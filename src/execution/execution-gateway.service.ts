/**
 * ExecutionGateway — reconciles target quotes against live orders.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClobClient } from '../polymarket/clients/clob.client';
import { CtfClient } from '../polymarket/clients/ctf.client';
import { RiskManager } from '../risk/risk-manager.service';
import { Quote, TargetQuotes, MarketSnapshot } from '../common/interfaces';

export interface LiveOrder { orderId: string; tokenId: string; side: 'BUY_YES' | 'BUY_NO'; price: number; size: number; }

@Injectable()
export class ExecutionGateway {
  private readonly logger = new Logger(ExecutionGateway.name);
  private liveOrders: Map<string, LiveOrder[]> = new Map();
  private readonly mode: 'paper' | 'live';

  constructor(
    private clob: ClobClient,
    private ctf: CtfClient,
    private risk: RiskManager,
    private config: ConfigService,
  ) {
    this.mode = (this.config.get<string>('ENGINE_MODE', 'paper') as 'paper' | 'live');
  }

  async reconcile(tokenId: string, target: TargetQuotes, repriceTicks: number = 2, resizeFrac: number = 0.2): Promise<void> {
    const live = this.liveOrders.get(tokenId) ?? [];
    const { approved } = this.risk.evaluate(target.quotes);
    const toCancel: LiveOrder[] = [];
    const toPlace: Quote[] = [];
    for (const tq of approved) {
      const match = live.find(o => o.side === tq.side && Math.abs(o.price - tq.price) <= repriceTicks * 0.001 && Math.abs(o.size - tq.size) / Math.max(o.size, 1) <= resizeFrac);
      if (!match) toPlace.push(tq);
    }
    for (const o of live) {
      if (!approved.some(q => q.side === o.side && Math.abs(q.price - o.price) <= repriceTicks * 0.001)) toCancel.push(o);
    }
    for (const o of toCancel) {
      if (this.mode === 'live') await this.clob.cancelOrder(o.orderId).catch(e => this.logger.warn(`Cancel failed: ${e.message}`));
      this.removeLiveOrder(tokenId, o.orderId);
    }
    for (const q of toPlace) {
      if (this.mode === 'paper') {
        this.logger.debug(`[PAPER] ${q.side} ${q.size}@${q.price} for ${tokenId}`);
        this.addLiveOrder(tokenId, { orderId: `paper-${Date.now()}`, ...q });
      } else {
        try {
          const result = await this.clob.postOrder({ tokenID: q.tokenId, price: q.price, size: q.size, side: 'BUY' });
          this.addLiveOrder(tokenId, { orderId: result.orderId, ...q });
          this.risk.recordOrderSuccess();
        } catch (e: any) {
          this.logger.error(`Order failed: ${e.message}`);
          this.risk.recordOrderError();
        }
      }
    }
  }

  async cancelAll(): Promise<void> {
    if (this.mode === 'live') await this.clob.cancelAll();
    this.liveOrders.clear();
    this.logger.warn('All orders cancelled');
  }

  /**
   * Rebalance inventory for a binary market using CTF split/merge — flattens directional
   * skew or re-arms a depleted two-sided book without crossing the spread. No-op in paper
   * mode (CtfClient logs and returns when signing is disabled).
   */
  async rebalanceInventory(market: MarketSnapshot): Promise<void> {
    if (!this.ctf.isReady) {
      this.logger.debug(`[paper] rebalanceInventory skipped for ${market.slug} — CTF signing disabled`);
      return;
    }
    try {
      const inv = await this.ctf.getInventory(market.yesTokenId, market.noTokenId);
      const plan = this.ctf.planRebalance(inv, {
        qMaxUsdc: this.config.get<number>('ENGINE_Q_MAX_USDC', 200),
        softFrac: 0.6,
        minSize: market.rewardsMinSize,
        minUsdcReserve: this.config.get<number>('ENGINE_MIN_USDC_RESERVE', 10),
      });
      if (plan.action === 'none') return;

      this.logger.log(`Rebalance ${market.slug}: ${plan.action} $${plan.amountUsdc} — ${plan.reason}`);
      if (plan.action === 'merge') {
        await this.ctf.mergePositions(market.conditionId, plan.amountUsdc, market.negRisk);
        this.risk.updateExposure(market.yesTokenId, -plan.amountUsdc);
        this.risk.updateExposure(market.noTokenId, -plan.amountUsdc);
      } else if (plan.action === 'split') {
        await this.ctf.splitPosition(market.conditionId, plan.amountUsdc, market.negRisk);
        this.risk.updateExposure(market.yesTokenId, plan.amountUsdc);
        this.risk.updateExposure(market.noTokenId, plan.amountUsdc);
      }
    } catch (e: any) {
      this.logger.error(`rebalanceInventory failed for ${market.slug}: ${e.message}`);
    }
  }

  private addLiveOrder(tokenId: string, order: LiveOrder): void {
    const orders = this.liveOrders.get(tokenId) ?? [];
    orders.push(order);
    this.liveOrders.set(tokenId, orders);
  }
  private removeLiveOrder(tokenId: string, orderId: string): void {
    const orders = this.liveOrders.get(tokenId) ?? [];
    this.liveOrders.set(tokenId, orders.filter(o => o.orderId !== orderId));
  }
}
