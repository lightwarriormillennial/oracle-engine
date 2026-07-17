/**
 * ExecutionGateway — reconciles target quotes against live orders.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClobClient } from '../polymarket/clients/clob.client';
import { RiskManager } from '../risk/risk-manager.service';
import { Quote, TargetQuotes } from '../common/interfaces';

export interface LiveOrder { orderId: string; tokenId: string; side: 'BUY_YES' | 'BUY_NO'; price: number; size: number; }

@Injectable()
export class ExecutionGateway {
  private readonly logger = new Logger(ExecutionGateway.name);
  private liveOrders: Map<string, LiveOrder[]> = new Map();
  private readonly mode: 'paper' | 'live';

  constructor(private clob: ClobClient, private risk: RiskManager, private config: ConfigService) {
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
