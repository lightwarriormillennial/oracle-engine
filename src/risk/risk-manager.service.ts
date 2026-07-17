/**
 * RiskManager — the sovereign risk gate.
 * Every order passes through here. Based on poly-maker's production config.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Quote } from '../common/interfaces';

export enum RiskDecision {
  APPROVED = 'APPROVED', REJECTED_EXPOSURE = 'REJECTED_EXPOSURE',
  REJECTED_MARKET_CAP = 'REJECTED_MARKET_CAP', REJECTED_DAILY_LOSS = 'REJECTED_DAILY_LOSS',
  REJECTED_STALE = 'REJECTED_STALE', REJECTED_ERROR_RATE = 'REJECTED_ERROR_RATE',
}

export interface RiskState {
  totalExposureUsdc: number;
  perMarketExposure: Map<string, number>;
  realizedDailyPnl: number;
  lastWsUpdate: Map<string, number>;
  orderErrorRate: number;
  halted: boolean;
  haltReason: string | null;
}

@Injectable()
export class RiskManager {
  private readonly logger = new Logger(RiskManager.name);
  private state: RiskState;
  private readonly maxTotalExposure: number;
  private readonly maxMarketNotional: number;
  private readonly dailyLossKill: number;
  private readonly wsStaleHaltS: number;
  private readonly maxOrderErrorRate: number;

  constructor(private config: ConfigService) {
    this.maxTotalExposure = this.config.get<number>('ENGINE_MAX_TOTAL_EXPOSURE_USDC', 450);
    this.maxMarketNotional = this.config.get<number>('ENGINE_MAX_MARKET_NOTIONAL_USDC', 400);
    this.dailyLossKill = this.config.get<number>('ENGINE_DAILY_LOSS_KILL_USDC', 40);
    this.wsStaleHaltS = this.config.get<number>('ENGINE_WS_STALE_HALT_S', 10);
    this.maxOrderErrorRate = this.config.get<number>('ENGINE_MAX_ORDER_ERROR_RATE', 0.25);
    this.state = {
      totalExposureUsdc: 0, perMarketExposure: new Map(),
      realizedDailyPnl: 0, lastWsUpdate: new Map(),
      orderErrorRate: 0, halted: false, haltReason: null,
    };
  }

  evaluate(quotes: Quote[]): { approved: Quote[]; rejected: { quote: Quote; reason: RiskDecision }[] } {
    const approved: Quote[] = [];
    const rejected: { quote: Quote; reason: RiskDecision }[] = [];
    if (this.state.halted) {
      this.logger.warn(`All quotes rejected — HALTED: ${this.state.haltReason}`);
      return { approved: [], rejected: quotes.map(q => ({ quote: q, reason: RiskDecision.REJECTED_DAILY_LOSS })) };
    }
    if (this.state.realizedDailyPnl <= -this.dailyLossKill) {
      this.halt(RiskDecision.REJECTED_DAILY_LOSS, `Daily loss ${this.state.realizedDailyPnl} <= -${this.dailyLossKill}`);
      return { approved: [], rejected: quotes.map(q => ({ quote: q, reason: RiskDecision.REJECTED_DAILY_LOSS })) };
    }
    if (this.state.orderErrorRate > this.maxOrderErrorRate) {
      this.halt(RiskDecision.REJECTED_ERROR_RATE, `Error rate ${this.state.orderErrorRate} > ${this.maxOrderErrorRate}`);
      return { approved: [], rejected: quotes.map(q => ({ quote: q, reason: RiskDecision.REJECTED_ERROR_RATE })) };
    }
    for (const q of quotes) {
      const notional = q.price * q.size;
      const marketExp = (this.state.perMarketExposure.get(q.tokenId) ?? 0) + notional;
      if (this.state.totalExposureUsdc + notional > this.maxTotalExposure) { rejected.push({ quote: q, reason: RiskDecision.REJECTED_EXPOSURE }); continue; }
      if (marketExp > this.maxMarketNotional) { rejected.push({ quote: q, reason: RiskDecision.REJECTED_MARKET_CAP }); continue; }
      approved.push(q);
    }
    return { approved, rejected };
  }

  isStale(tokenId: string): boolean {
    const last = this.state.lastWsUpdate.get(tokenId);
    return !last || (Date.now() - last) / 1000 > this.wsStaleHaltS;
  }

  halt(reason: RiskDecision, detail: string): void {
    this.state.halted = true;
    this.state.haltReason = `${reason}: ${detail}`;
    this.logger.error(`🛑 ENGINE HALTED: ${this.state.haltReason}`);
  }

  resetDaily(): void { this.state.realizedDailyPnl = 0; this.logger.log('Daily counters reset'); }
  updateExposure(tokenId: string, delta: number): void {
    this.state.totalExposureUsdc += delta;
    this.state.perMarketExposure.set(tokenId, (this.state.perMarketExposure.get(tokenId) ?? 0) + delta);
  }
  recordFill(pnl: number): void { this.state.realizedDailyPnl += pnl; }
  recordWsUpdate(tokenId: string): void { this.state.lastWsUpdate.set(tokenId, Date.now()); }
  recordOrderError(): void { this.state.orderErrorRate = this.state.orderErrorRate * 0.95 + 0.05; }
  recordOrderSuccess(): void { this.state.orderErrorRate = this.state.orderErrorRate * 0.95; }
  getState(): Readonly<RiskState> { return this.state; }
}
