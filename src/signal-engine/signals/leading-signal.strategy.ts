/**
 * LeadingSignalStrategy — Tier 2
 * Exploits Binance→Chainlink oracle latency on up/down markets.
 */
import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import {
  IStrategy, StrategyContext, StrategyConfig, StrategyTier,
  MarketRegime, Fill, OrderBook, TargetQuotes, Quote, MarketSnapshot, FEE_MATRIX,
} from '../../common/interfaces';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export enum SignalDirection { FLAT = 'FLAT', LONG_UP = 'LONG_UP', LONG_DOWN = 'LONG_DOWN' }

export interface PriceFeedState {
  binancePrice: number; chainlinkPrice: number;
  binanceTimestamp: number; chainlinkTimestamp: number;
  emaShort: number; emaLong: number; momentum: number;
}

@Injectable()
export class LeadingSignalStrategy implements IStrategy {
  readonly name = 'leading-signal';
  readonly tier = StrategyTier.TIER_2_SIGNAL;

  compute(ctx: StrategyContext, config: StrategyConfig): TargetQuotes {
    const p = this.parseParams(config.params);
    const { book, regime } = ctx;
    const quotes: Quote[] = [];
    if (regime === MarketRegime.HALTED) return { quotes, regime, fairValue: book.midPrice(), confidence: 0 };
    const signalState = (config.params as any).signalState as PriceFeedState | undefined;
    if (!signalState) return { quotes, regime, fairValue: book.midPrice(), confidence: 0 };
    const direction = this.evaluateSignal(signalState, p);
    const edge = this.estimateEdge(direction, signalState, p);
    const minEdge = this.minEdgeAfterFees(ctx.market, p);
    if (edge > minEdge && direction !== SignalDirection.FLAT) {
      const side: 'BUY_YES' | 'BUY_NO' = direction === SignalDirection.LONG_UP ? 'BUY_YES' : 'BUY_NO';
      const bestPrice = book.bestAsk()?.price ?? 1;
      quotes.push({ side, price: bestPrice, size: p.orderSize, tokenId: side === 'BUY_YES' ? ctx.market.yesTokenId : ctx.market.noTokenId, postOnly: false });
      return { quotes, regime, fairValue: direction === SignalDirection.LONG_UP ? bestPrice + edge : bestPrice - edge, confidence: Math.min(edge / (minEdge * 2), 1) };
    }
    return { quotes, regime, fairValue: book.midPrice(), confidence: 0 };
  }

  private evaluateSignal(s: PriceFeedState, p: SignalParams): SignalDirection {
    const emaPct = (s.emaShort - s.emaLong) / s.binancePrice;
    const divergence = (s.binancePrice - s.chainlinkPrice) / s.chainlinkPrice;
    const combined = emaPct * p.emaWeight + divergence * p.divergenceWeight + s.momentum * p.momentumWeight;
    if (combined > p.entryThreshold) return SignalDirection.LONG_UP;
    if (combined < -p.entryThreshold) return SignalDirection.LONG_DOWN;
    return SignalDirection.FLAT;
  }

  private estimateEdge(dir: SignalDirection, s: PriceFeedState, p: SignalParams): number {
    if (dir === SignalDirection.FLAT) return 0;
    const divergence = Math.abs((s.binancePrice - s.chainlinkPrice) / s.chainlinkPrice);
    return divergence * p.divergenceToProbMult;
  }

  private minEdgeAfterFees(market: MarketSnapshot, p: SignalParams): number {
    const midProb = parseFloat(market.outcomePrices[0]);
    const entry = FEE_MATRIX[market.category] || FEE_MATRIX.other;
    return entry.takerFee * midProb * (1 - midProb) + p.slippageBuffer;
  }

  scoreMarket(market: MarketSnapshot): number {
    const isUpDown = market.slug.includes('up-or-down') || market.slug.includes('5m') || market.slug.includes('15m');
    if (!isUpDown || !market.acceptingOrders) return 0;
    return Math.min(market.volume24hr / 10000, 1);
  }

  classifyRegime(_book: OrderBook, _fills: Fill[]): MarketRegime { return MarketRegime.QUIET; }

  private parseParams(raw: Record<string, number | string | boolean>): SignalParams {
    return {
      emaShortPeriod: Number(raw.emaShortPeriod ?? 10), emaLongPeriod: Number(raw.emaLongPeriod ?? 50),
      emaWeight: Number(raw.emaWeight ?? 0.3), divergenceWeight: Number(raw.divergenceWeight ?? 0.5),
      momentumWeight: Number(raw.momentumWeight ?? 0.2), entryThreshold: Number(raw.entryThreshold ?? 0.001),
      divergenceToProbMult: Number(raw.divergenceToProbMult ?? 2.0), slippageBuffer: Number(raw.slippageBuffer ?? 0.005),
      orderSize: Number(raw.orderSize ?? 50),
    };
  }
}
interface SignalParams {
  emaShortPeriod: number; emaLongPeriod: number; emaWeight: number;
  divergenceWeight: number; momentumWeight: number; entryThreshold: number;
  divergenceToProbMult: number; slippageBuffer: number; orderSize: number;
}
