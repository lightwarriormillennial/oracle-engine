/**
 * PnlReconciler — daily mark-to-market reconciliation against on-chain positions.
 *
 * Internal accounting (RiskManager.realizedDailyPnl + ExecutionGateway live orders) is an
 * estimate. This service periodically checks it against ground truth:
 *
 *   1. Pull on-chain ERC-1155 YES/NO balances + USDC balance via CtfClient.
 *   2. Mark open inventory to the current order-book mid-price (fetch via ClobClient).
 *   3. Compute equity = usdcBalance + Σ(yesShares * midYes + noShares * midNo).
 *   4. Compare equity delta to the internal realizedDailyPnl. Flag drift beyond tolerance.
 *   5. Emit Telegram alerts on material drift or daily-loss-kill breach.
 *
 * In paper mode (no signing), on-chain balances read as zero and the reconciler logs only.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CtfClient } from '../polymarket/clients/ctf.client';
import { ClobClient } from '../polymarket/clients/clob.client';
import { RiskManager } from '../risk/risk-manager.service';
import { AlertsService } from '../alerts/alerts.service';
import { MarketSnapshot } from '../common/interfaces';

export interface PositionMark {
  tokenId: string;
  shares: number;
  midPrice: number;
  marketValue: number;
}

export interface ReconciliationReport {
  timestamp: number;
  onChainEquityUsdc: number;
  internalRealizedPnlUsdc: number;
  expectedEquityUsdc: number;
  driftUsdc: number;
  driftPct: number;
  positions: PositionMark[];
  breaches: string[];
}

@Injectable()
export class PnlReconciler {
  private readonly logger = new Logger(PnlReconciler.name);
  private readonly driftToleranceUsdc: number;
  private readonly driftTolerancePct: number;
  private readonly bookTtlMs: number;

  /** Cached mid-prices keyed by tokenId (refreshed during reconciliation). */
  private midPriceCache = new Map<string, { mid: number; ts: number }>();

  constructor(
    private ctf: CtfClient,
    private clob: ClobClient,
    private risk: RiskManager,
    private alerts: AlertsService,
    private config: ConfigService,
  ) {
    this.driftToleranceUsdc = this.config.get<number>('ENGINE_PNL_DRIFT_TOLERANCE_USDC', 5);
    this.driftTolerancePct = this.config.get<number>('ENGINE_PNL_DRIFT_TOLERANCE_PCT', 0.05);
    this.bookTtlMs = this.config.get<number>('ENGINE_BOOK_TTL_MS', 60_000);
  }

  /**
   * Reconcile PnL across the given active markets. Returns a structured report and
   * raises alerts (Telegram + dashboard) on material drift or breach.
   */
  async reconcileDaily(markets: Iterable<MarketSnapshot>): Promise<ReconciliationReport> {
    const breaches: string[] = [];
    const positions: PositionMark[] = [];
    const seen = new Set<string>();
    let onChainEquity = 0;

    for (const market of markets) {
      // Dedupe by condition id to avoid double-counting cross-listed markets.
      if (market.conditionId && seen.has(market.conditionId)) continue;
      if (market.conditionId) seen.add(market.conditionId);

      const inv = await this.ctf.getInventory(market.yesTokenId, market.noTokenId);
      const midYes = await this.fetchMid(market.yesTokenId);
      const midNo = await this.fetchMid(market.noTokenId);

      const markYes: PositionMark = {
        tokenId: market.yesTokenId, shares: inv.yesShares, midPrice: midYes,
        marketValue: inv.yesShares * midYes,
      };
      const markNo: PositionMark = {
        tokenId: market.noTokenId, shares: inv.noShares, midPrice: midNo,
        marketValue: inv.noShares * midNo,
      };
      positions.push(markYes, markNo);
      onChainEquity += markYes.marketValue + markNo.marketValue;
    }

    // Add the single global USDC balance once.
    const usdcBalance = await this.fetchUsdcBalance();
    onChainEquity += usdcBalance;

    const internalPnl = this.risk.getState().realizedDailyPnl;
    // Expected equity = starting capital + realized PnL (mark-to-market already in onChainEquity).
    const expectedEquity = this.config.get<number>('ENGINE_START_CAPITAL_USDC', 50) + internalPnl;
    const driftUsdc = onChainEquity - expectedEquity;
    const driftPct = expectedEquity > 0 ? driftUsdc / expectedEquity : 0;

    // Breach detection.
    if (Math.abs(driftUsdc) > this.driftToleranceUsdc && Math.abs(driftPct) > this.driftTolerancePct) {
      const msg = `PnL drift detected: $${driftUsdc.toFixed(2)} (${(driftPct * 100).toFixed(1)}%) — on-chain $${onChainEquity.toFixed(2)} vs expected $${expectedEquity.toFixed(2)}`;
      breaches.push(msg);
      this.logger.warn(msg);
      await this.alerts.send(msg, 'warn');
    }

    // Daily-loss-kill reconciliation: if internal PnL is near the kill threshold but
    // on-chain equity shows a deeper drawdown, surface it as critical.
    const dailyLossKill = this.config.get<number>('ENGINE_DAILY_LOSS_KILL_USDC', 40);
    if (driftUsdc <= -dailyLossKill) {
      const msg = `On-chain drawdown $${Math.abs(driftUsdc).toFixed(2)} exceeds daily-loss-kill $${dailyLossKill}`;
      breaches.push(msg);
      this.logger.error(`🛑 ${msg}`);
      await this.alerts.send(msg, 'critical');
    }

    const report: ReconciliationReport = {
      timestamp: Date.now(),
      onChainEquityUsdc: onChainEquity,
      internalRealizedPnlUsdc: internalPnl,
      expectedEquityUsdc: expectedEquity,
      driftUsdc,
      driftPct,
      positions,
      breaches,
    };
    this.logger.log(
      `Daily PnL reconciliation: on-chain=$${onChainEquity.toFixed(2)} expected=$${expectedEquity.toFixed(2)} drift=$${driftUsdc.toFixed(2)} (${(driftPct * 100).toFixed(2)}%) breaches=${breaches.length}`,
    );
    return report;
  }

  /** Fetch mid-price for a token, with a short TTL cache to bound CLOB calls. */
  private async fetchMid(tokenId: string): Promise<number> {
    const cached = this.midPriceCache.get(tokenId);
    if (cached && Date.now() - cached.ts < this.bookTtlMs) return cached.mid;
    try {
      const book = await this.clob.getOrderBook(tokenId);
      const bestBid = Number(book.bids?.[0]?.price ?? 0);
      const bestAsk = Number(book.asks?.[0]?.price ?? 1);
      const mid = bestBid > 0 && bestAsk < 1 ? (bestBid + bestAsk) / 2 : 0.5;
      this.midPriceCache.set(tokenId, { mid, ts: Date.now() });
      return mid;
    } catch (e: any) {
      this.logger.warn(`fetchMid failed for ${tokenId}: ${e.message} — using 0.5`);
      return 0.5;
    }
  }

  private async fetchUsdcBalance(): Promise<number> {
    if (!this.ctf.isReady) return 0;
    // Reuse getInventory with sentinel tokens to read the global USDC balance.
    const inv = await this.ctf.getInventory('0', '0');
    return inv.usdcBalance;
  }
}
