/**
 * AvellanedaStoikovStrategy — Tier 1 (Advanced)
 * Classic quant market-making model with dynamic spread.
 * Reference: Avellaneda & Stoikov (2008).
 */
import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import {
  IStrategy, StrategyContext, StrategyConfig, StrategyTier,
  MarketRegime, Fill, OrderBook, TargetQuotes, Quote, MarketSnapshot,
} from '../../common/interfaces';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

@Injectable()
export class AvellanedaStoikovStrategy implements IStrategy {
  readonly name = 'avellaneda-stoikov';
  readonly tier = StrategyTier.TIER_1_MAKER;

  compute(ctx: StrategyContext, config: StrategyConfig): TargetQuotes {
    const p = this.parseParams(config.params);
    const { book, inventory, volatility, regime } = ctx;
    const s = new Decimal(book.midPrice());
    const q = new Decimal(inventory.yesShares - inventory.noShares);
    const sigma = new Decimal(volatility);
    const tt = new Decimal(p.horizonSeconds).div(3600);
    const reservation = s.minus(q.times(p.gamma).times(sigma.pow(2)).times(tt));
    const spreadHalf = sigma.pow(2).times(p.gamma).times(tt).div(2)
      .plus(new Decimal(1).div(p.gamma).times(Decimal.ln(new Decimal(1).plus(p.gamma / p.k))));
    const maxSpread = new Decimal(ctx.market.rewardsMaxSpread / 100);
    const clampedSpread = Decimal.min(spreadHalf, maxSpread.div(2));
    const bidPrice = reservation.minus(clampedSpread);
    const askPrice = reservation.plus(clampedSpread);
    const size = this.optimalSize(volatility, p);
    const quotes: Quote[] = [];
    if (regime !== MarketRegime.HALTED) {
      const sf = regime === MarketRegime.EVENT ? 0 : (regime === MarketRegime.TRENDING ? 0.5 : 1);
      if (bidPrice.gt(0) && bidPrice.lt(1))
        quotes.push({ side: 'BUY_YES', price: this.toFixed(bidPrice, book.tickSize), size: Math.floor(size * sf), tokenId: ctx.market.yesTokenId, postOnly: true });
      const noBid = new Decimal(1).minus(askPrice);
      if (noBid.gt(0) && noBid.lt(1))
        quotes.push({ side: 'BUY_NO', price: this.toFixed(noBid, book.tickSize), size: Math.floor(size * sf), tokenId: ctx.market.noTokenId, postOnly: true });
    }
    return { quotes, regime, fairValue: reservation.toNumber(), confidence: 0.7 };
  }

  scoreMarket(market: MarketSnapshot): number {
    if (!market.acceptingOrders) return 0;
    return Math.min(market.volume24hr / 5000, 1) * 0.5 + Math.min(Math.log10(market.liquidity + 1) / 4, 1) * 0.5;
  }

  classifyRegime(book: OrderBook, recentFills: Fill[]): MarketRegime {
    if (book.spread() > book.tickSize * 10) return MarketRegime.QUIET;
    if (recentFills.length > 3) return MarketRegime.TRENDING;
    return MarketRegime.QUIET;
  }

  private optimalSize(vol: number, p: ASParams): number {
    return Math.max(p.minSize, Math.floor(p.maxNotional / (1 + vol * 100)));
  }
  private toFixed(d: Decimal, tick: number): number {
    return parseFloat(d.toDecimalPlaces(tick >= 0.01 ? 2 : 3).toString());
  }
  private parseParams(raw: Record<string, number | string | boolean>): ASParams {
    return { gamma: Number(raw.gamma ?? 0.1), k: Number(raw.k ?? 1.5), horizonSeconds: Number(raw.horizonSeconds ?? 3600), maxNotional: Number(raw.maxNotional ?? 100), minSize: Number(raw.minSize ?? 10) };
  }
}
interface ASParams { gamma: number; k: number; horizonSeconds: number; maxNotional: number; minSize: number; }
