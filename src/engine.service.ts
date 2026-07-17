/**
 * EngineService — the main trading loop.
 * WS event → OrderBook → Strategy.compute() → RiskManager → ExecutionGateway
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GammaClient } from './polymarket/clients/gamma.client';
import { ClobClient } from './polymarket/clients/clob.client';
import { RiskManager } from './risk/risk-manager.service';
import { ExecutionGateway } from './execution/execution-gateway.service';
import { IStrategy, MarketSnapshot } from './common/interfaces';

@Injectable()
export class EngineService implements OnModuleInit {
  private readonly logger = new Logger(EngineService.name);
  private strategies = new Map<string, IStrategy>();
  private activeMarkets = new Map<string, MarketSnapshot>();
  private running = false;

  constructor(
    private gamma: GammaClient, private clob: ClobClient,
    private risk: RiskManager, private execution: ExecutionGateway,
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
      this.clob.subscribeOrderBook(tokenId, (data) => {
        this.risk.recordWsUpdate(tokenId);
        this.handleMarketEvent(tokenId, market, data);
      });
    }
  }

  private async handleMarketEvent(tokenId: string, market: MarketSnapshot, data: any): Promise<void> {
    if (!this.running || this.risk.isStale(tokenId)) return;
    // TODO: reconstruct OrderBook, compute vol/tox, call strategy.compute(), reconcile
  }

  @Cron('0 0 * * *')
  dailyReset(): void { this.risk.resetDaily(); }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async rescan(): Promise<void> { await this.scanMarkets(); }
}
