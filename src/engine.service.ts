/**
 * EngineService — the main trading loop.
 * WS event → OrderBook → Strategy.compute() → RiskManager → ExecutionGateway
 */
import { Injectable, OnModuleInit, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GammaClient } from './polymarket/clients/gamma.client';
import { ClobClient } from './polymarket/clients/clob.client';
import { RiskManager } from './risk/risk-manager.service';
import { ExecutionGateway } from './execution/execution-gateway.service';
import { PnlReconciler } from './execution/pnl-reconciler.service';
import { BacktestService } from './signal-engine/backtest.service';
import { PriceFeedAggregator } from './signal-engine/feeds/price-feed-aggregator';
import {
  IStrategy, MarketSnapshot, OrderBook, OrderBookLevel, Fill,
  StrategyContext, StrategyConfig, STRATEGIES,
} from './common/interfaces';

interface BookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
  tickSize: number;
  recentFills: Fill[];
}

@Injectable()
export class EngineService implements OnModuleInit {
  private readonly logger = new Logger(EngineService.name);
  private strategies = new Map<string, IStrategy>();
  private activeMarkets = new Map<string, MarketSnapshot>();
  private bookStates = new Map<string, BookState>();
  private running = false;
  private lastReconcile = new Map<string, number>();
  private readonly reconcileIntervalMs = 2000;

  constructor(
    private gamma: GammaClient,
    private clob: ClobClient,
    private risk: RiskManager,
    private execution: ExecutionGateway,
    private pnlReconciler: PnlReconciler,
    private backtest: BacktestService,
    private feedAggregator: PriceFeedAggregator,
    @Inject(STRATEGIES) private injectedStrategies: IStrategy[],
  ) {}

  registerStrategy(name: string, strategy: IStrategy): void {
    this.strategies.set(name, strategy);
    this.logger.log(`Strategy registered: ${name} (${strategy.tier})`);
  }

  async onModuleInit() {
    this.logger.log('═══════════════════════════════════════════');
    this.logger.log('  Oracle Engine — initializing');
    this.logger.log(`  Mode: ${process.env.ENGINE_MODE || 'paper'}`);
    this.logger.log('═══════════════════════════════════════════');
    // Auto-register injected strategies (multi-provider STRATEGIES token).
    for (const strategy of this.injectedStrategies ?? []) {
      this.registerStrategy(strategy.name, strategy);
    }
    if (this.strategies.size === 0) {
      this.logger.warn('No strategies registered — engine will not monitor markets');
    }
    // Start collecting Tier-2 signal ticks for backtest (Phase 3).
    this.backtest.startRecording();
    await this.scanMarkets();
    await this.start();
  }

  async scanMarkets(): Promise<void> {
    this.logger.log('Scanning markets...');
    const markets = await this.gamma.scanRewardMarkets(100);
    this.logger.log(`Fetched ${markets.length} active markets`);
    for (const [name, strategy] of this.strategies) {
      const scored = markets
        .map(m => ({ market: m, score: strategy.scoreMarket(m) }))
        .filter(x => x.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      this.logger.log(`Strategy "${name}": ${scored.length} markets above threshold`);
      for (const { market, score } of scored.slice(0, 5)) {
        this.logger.log(`  ${market.slug}: score=${score.toFixed(3)} vol24=${market.volume24hr}`);
        this.activeMarkets.set(market.yesTokenId, market);
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.log(`Engine started — monitoring ${this.activeMarkets.size} markets`);
    for (const [tokenId, market] of this.activeMarkets) {
      this.bookStates.set(tokenId, { bids: new Map(), asks: new Map(), tickSize: market.tickSize, recentFills: [] });
      this.clob.subscribeOrderBook(tokenId, (data) => {
        this.risk.recordWsUpdate(tokenId);
        this.handleMarketEvent(tokenId, market, data);
      });
    }
  }

  private async handleMarketEvent(tokenId: string, market: MarketSnapshot, data: any): Promise<void> {
    if (!this.running || this.risk.isStale(tokenId)) return;

    // Reconstruct order book from WS price_change events
    this.updateBookState(tokenId, data);

    // Throttle reconciliation to avoid excessive compute
    const now = Date.now();
    const last = this.lastReconcile.get(tokenId) ?? 0;
    if (now - last < this.reconcileIntervalMs) return;
    this.lastReconcile.set(tokenId, now);

    const state = this.bookStates.get(tokenId);
    if (!state || (state.bids.size === 0 && state.asks.size === 0)) return;

    const book = this.buildOrderBook(tokenId, state);
    const strategy = this.pickStrategy(market);
    if (!strategy) return;

    const ctx: StrategyContext = {
      book,
      market,
      inventory: this.getInventory(tokenId),
      clock: now,
      volatility: this.computeVolatility(state),
      toxicity: this.computeToxicity(state),
      regime: strategy.classifyRegime(book, state.recentFills),
    };

    const config: StrategyConfig = {
      name: strategy.name,
      tier: strategy.tier,
      marketSlug: market.slug,
      params: this.getStrategyParams(strategy.name),
    };

    const target = strategy.compute(ctx, config);
    await this.execution.reconcile(tokenId, target);
  }

  private updateBookState(tokenId: string, data: any): void {
    const state = this.bookStates.get(tokenId);
    if (!state) return;

    // Polymarket WS sends arrays of events; handle both single and array forms
    const events = Array.isArray(data) ? data : [data];
    for (const evt of events) {
      if (!evt || typeof evt !== 'object') continue;
      const changes = evt.changes ?? evt.price_changes ?? evt.events ?? [];
      if (!Array.isArray(changes)) continue;
      for (const ch of changes) {
        const price = parseFloat(ch.price);
        const side = ch.side ?? 'BUY';
        const size = parseFloat(ch.size);
        if (isNaN(price) || isNaN(size)) continue;
        const book = side === 'BUY' || side === 'BID' ? state.bids : state.asks;
        if (size === 0) {
          book.delete(price);
        } else {
          book.set(price, size);
        }
      }
    }
  }

  private buildOrderBook(tokenId: string, state: BookState): OrderBook {
    const bids: OrderBookLevel[] = [...state.bids.entries()]
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => b.price - a.price);
    const asks: OrderBookLevel[] = [...state.asks.entries()]
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => a.price - b.price);
    const tickSize = state.tickSize;
    return {
      tokenId, bids, asks, tickSize,
      timestamp: Date.now(),
      bestBid: () => bids[0] ?? null,
      bestAsk: () => asks[0] ?? null,
      midPrice: () => bids.length && asks.length ? (bids[0].price + asks[0].price) / 2 : 0.5,
      microprice: (levels = 3) => {
        const bLevels = bids.slice(0, levels);
        const aLevels = asks.slice(0, levels);
        if (!bLevels.length || !aLevels.length) return bids.length ? bids[0].price : 0.5;
        const bVol = bLevels.reduce((s, l) => s + l.size, 0);
        const aVol = aLevels.reduce((s, l) => s + l.size, 0);
        const total = bVol + aVol;
        if (total === 0) return 0.5;
        return (bLevels[0].price * aVol + aLevels[0].price * bVol) / total;
      },
      spread: () => bids.length && asks.length ? asks[0].price - bids[0].price : 1,
      depthAtLevel: (side, levels) => {
        const arr = side === 'bid' ? bids : asks;
        return arr.slice(0, levels).reduce((s, l) => s + l.size, 0);
      },
    };
  }

  private pickStrategy(market: MarketSnapshot): IStrategy | null {
    let best: IStrategy | null = null;
    let bestScore = -1;
    for (const strategy of this.strategies.values()) {
      const score = strategy.scoreMarket(market);
      if (score > bestScore) { bestScore = score; best = strategy; }
    }
    return bestScore > 0.3 ? best : null;
  }

  private getInventory(tokenId: string) {
    return { yesShares: 0, noShares: 0, netUsdc: 0, realizedPnl: 0 };
  }

  private computeVolatility(state: BookState): number {
    const fills = state.recentFills;
    if (fills.length < 2) return 0.01;
    const recent = fills.slice(-20);
    const prices = recent.map(f => f.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
    return Math.sqrt(variance);
  }

  private computeToxicity(state: BookState): number {
    const now = Date.now();
    return state.recentFills.filter(f => now - f.timestamp < 60_000).length / 60;
  }

  private getStrategyParams(name: string): Record<string, number | string | boolean> {
    return {};
  }

  @Cron('0 0 * * *')
  async dailyReset(): Promise<void> {
    // Reconcile PnL against on-chain positions before resetting the daily counter.
    try {
      await this.pnlReconciler.reconcileDaily(this.activeMarkets.values());
    } catch (e: any) {
      this.logger.error(`Daily PnL reconciliation failed: ${e.message}`);
    }
    this.risk.resetDaily();
    // Run the daily Tier-2 backtest sweep: does the edge survive net of fees?
    try {
      const results = await this.backtest.sweepParameters();
      if (results.length > 0) {
        const best = results[0];
        this.logger.log(
          `Backtest sweep: ${results.length} tradeable configs — best netExpectancy=${best.netExpectancy.toFixed(5)} winRate=${(best.winRate * 100).toFixed(1)}% signals=${best.totalSignals}`,
        );
      } else {
        this.logger.warn('Backtest sweep: no tradeable configurations found (insufficient data or no net edge)');
      }
    } catch (e: any) {
      this.logger.error(`Backtest sweep failed: ${e.message}`);
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async rescan(): Promise<void> {
    await this.scanMarkets();
    // Rebalance inventory (CTF split/merge) for active markets after each rescan.
    await this.rebalanceActiveMarkets();
  }

  private async rebalanceActiveMarkets(): Promise<void> {
    const markets = [...this.activeMarkets.values()];
    for (const market of markets) {
      try {
        await this.execution.rebalanceInventory(market);
      } catch (e: any) {
        this.logger.warn(`Rebalance failed for ${market.slug}: ${e.message}`);
      }
    }
  }
}
