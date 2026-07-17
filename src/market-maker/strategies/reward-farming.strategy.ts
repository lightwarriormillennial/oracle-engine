/**
 * RewardFarmingStrategy — Tier 1
 * Post maker-only orders within the liquidity-reward band to farm
 * daily rewards + maker rebates. Two-sided quotes that merge to USDC.
 */
import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import {
  IStrategy, StrategyContext, StrategyConfig, StrategyTier,
  MarketRegime, Fill, OrderBook, TargetQuotes, Quote, MarketSnapshot,
} from '../../common/interfaces';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

@Injectable()
export class RewardFarmingStrategy implements IStrategy {
  readonly name = 'reward-farming';
  readonly tier = StrategyTier.TIER_1_MAKER;

  compute(ctx: StrategyContext, config: StrategyConfig): TargetQuotes {
    const p = this.parseParams(config.params);
    const { book, inventory, volatility, toxicity, regime } = ctx;
    const fv = new Decimal(book.microprice(p.microLevels));
    const netPos = new Decimal(inventory.yesShares - inventory.noShares);
    const skew = netPos.times(p.gamma).div(p.qMaxUsdc);
    const reservation = fv.minus(skew);
    const halfSpread = new Decimal(p.deltaMinTicks * book.tickSize)
      .plus(p.cVol * volatility).plus(p.cTox * toxicity);

    const bidYesPrice = reservation.minus(halfSpread);
    const bidNoPrice = new Decimal(1).minus(reservation).minus(halfSpread);
    const rewardSize = Math.max(ctx.market.rewardsMinSize, p.baseSizeUsdc / bidYesPrice.toNumber());
    const adjustedSize = this.adjustSizeForInventory(rewardSize * p.rewardSizeMult, netPos.toNumber(), p);

    const mid = new Decimal(book.midPrice());
    const maxSpread = new Decimal(ctx.market.rewardsMaxSpread / 100);
    const clampedBidYes = Decimal.max(bidYesPrice, mid.minus(maxSpread));
    const clampedBidNo = Decimal.max(bidNoPrice, mid.minus(maxSpread));

    const quotes: Quote[] = [];
    if (regime !== MarketRegime.HALTED && regime !== MarketRegime.REDUCE_ONLY) {
      const sf = regime === MarketRegime.TRENDING ? 0.5 : 1.0;
      quotes.push({ side: 'BUY_YES', price: this.toFixed(clampedBidYes, book.tickSize), size: Math.floor(adjustedSize * sf), tokenId: ctx.market.yesTokenId, postOnly: true });
      quotes.push({ side: 'BUY_NO', price: this.toFixed(clampedBidNo, book.tickSize), size: Math.floor(adjustedSize * sf), tokenId: ctx.market.noTokenId, postOnly: true });
    }
    return { quotes, regime, fairValue: fv.toNumber(), confidence: regime === MarketRegime.QUIET ? 0.85 : 0.4 };
  }

  scoreMarket(market: MarketSnapshot): number {
    if (!market.acceptingOrders || market.category === 'geopolitics') return 0;
    const midProb = parseFloat(market.outcomePrices[0]);
    const feeCurve = 4 * midProb * (1 - midProb);
    const rewardScore = Math.min(market.dailyRewardRateUsdc / 300, 1);
    const rebateScore = market.makerRebatePct / 0.25;
    const liqScore = Math.min(Math.log10(market.liquidity + 1) / 4, 1);
    return feeCurve * 0.35 + rewardScore * 0.35 + rebateScore * 0.15 + liqScore * 0.15;
  }

  classifyRegime(book: OrderBook, recentFills: Fill[]): MarketRegime {
    const now = Date.now();
    const recent = recentFills.filter(f => now - f.timestamp < 60_000);
    if (recent.length > 0) {
      const last = recent[recent.length - 1];
      if (Math.abs(book.midPrice() - last.price) > book.tickSize * 6) return MarketRegime.EVENT;
    }
    if (recent.length > 5) return MarketRegime.TRENDING;
    return MarketRegime.QUIET;
  }

  private adjustSizeForInventory(size: number, netPos: number, p: RewardParams): number {
    const util = Math.abs(netPos) / p.qMaxUsdc;
    return util > p.qSoftFrac ? size * (1 - util) : size;
  }

  private toFixed(price: Decimal, tickSize: number): number {
    return parseFloat(price.toDecimalPlaces(tickSize >= 0.01 ? 2 : 3).toString());
  }

  private parseParams(raw: Record<string, number | string | boolean>): RewardParams {
    return {
      microLevels: Number(raw.microLevels ?? 3), gamma: Number(raw.gamma ?? 0.6),
      deltaMinTicks: Number(raw.deltaMinTicks ?? 2), cVol: Number(raw.cVol ?? 1.5),
      cTox: Number(raw.cTox ?? 3.0), baseSizeUsdc: Number(raw.baseSizeUsdc ?? 50),
      qMaxUsdc: Number(raw.qMaxUsdc ?? 200), qSoftFrac: Number(raw.qSoftFrac ?? 0.6),
      rewardSizeMult: Number(raw.rewardSizeMult ?? 1.5),
    };
  }
}

interface RewardParams {
  microLevels: number; gamma: number; deltaMinTicks: number; cVol: number;
  cTox: number; baseSizeUsdc: number; qMaxUsdc: number; qSoftFrac: number; rewardSizeMult: number;
}
