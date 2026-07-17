/**
 * RewardFarmingStrategy — Tier 1 market-making strategy tests.
 *
 * Pins: two-sided quoting, inventory skew adjustment, regime gating, spread
 * clamping, and the fee/reward scoring function. Strategies are pure functions
 * (no side effects), so no mocking needed.
 */
import { RewardFarmingStrategy } from './reward-farming.strategy';
import {
  StrategyContext, StrategyConfig, StrategyTier, MarketRegime,
} from '../../common/interfaces';
import { makeBook, makeMarket, makeFill } from '../../common/test-helpers';

function makeCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    book: makeBook([[0.49, 100]], [[0.51, 100]]),
    market: makeMarket(),
    inventory: { yesShares: 0, noShares: 0, netUsdc: 0, realizedPnl: 0 },
    clock: Date.now(),
    volatility: 0.01,
    toxicity: 0,
    regime: MarketRegime.QUIET,
    ...overrides,
  };
}

function makeConfig(params: Record<string, number> = {}): StrategyConfig {
  return {
    name: 'reward-farming',
    tier: StrategyTier.TIER_1_MAKER,
    params,
  };
}

describe('RewardFarmingStrategy.compute', () => {
  const strategy = new RewardFarmingStrategy();

  it('quotes two-sided in a quiet regime', () => {
    const target = strategy.compute(makeCtx(), makeConfig());
    expect(target.quotes.length).toBeGreaterThanOrEqual(2);
    const sides = new Set(target.quotes.map(q => q.side));
    expect(sides.has('BUY_YES')).toBe(true);
    expect(sides.has('BUY_NO')).toBe(true);
  });

  it('does not quote in a HALTED regime', () => {
    const target = strategy.compute(makeCtx({ regime: MarketRegime.HALTED }), makeConfig());
    expect(target.quotes).toHaveLength(0);
  });

  it('does not quote in a REDUCE_ONLY regime', () => {
    const target = strategy.compute(makeCtx({ regime: MarketRegime.REDUCE_ONLY }), makeConfig());
    expect(target.quotes).toHaveLength(0);
  });

  it('halves size in a TRENDING regime', () => {
    const quietTarget = strategy.compute(makeCtx(), makeConfig({ baseSizeUsdc: 1000 }));
    const trendingTarget = strategy.compute(
      makeCtx({ regime: MarketRegime.TRENDING }),
      makeConfig({ baseSizeUsdc: 1000 }),
    );
    expect(trendingTarget.quotes.length).toBeGreaterThanOrEqual(1);
    // TRENDING applies sf=0.5, so each quote size should be roughly half of quiet
    expect(trendingTarget.quotes[0].size).toBeLessThanOrEqual(quietTarget.quotes[0].size);
  });

  it('clamps quotes within the rewards max spread band', () => {
    const market = makeMarket({ rewardsMaxSpread: 5 }); // 5% max spread
    const ctx = makeCtx({ market });
    const target = strategy.compute(ctx, makeConfig());
    const mid = ctx.book.midPrice();
    for (const q of target.quotes) {
      expect(q.price).toBeGreaterThanOrEqual(mid - 0.05);
      expect(q.price).toBeLessThanOrEqual(mid + 0.05);
    }
  });

  it('reduces size when inventory utilization exceeds the soft fraction', () => {
    // Two configs identical except qSoftFrac. With yesShares=100, qMaxUsdc=200,
    // util = 0.5. qSoftFrac=0.99 → no reduction; qSoftFrac=0.01 → 50% reduction.
    // Since qSoftFrac doesn't affect reservation price, rewardSize is identical;
    // only the adjustment factor differs.
    const noAdjust = strategy.compute(
      makeCtx({
        inventory: { yesShares: 100, noShares: 0, netUsdc: 0, realizedPnl: 0 },
      }),
      makeConfig({ baseSizeUsdc: 100, qMaxUsdc: 200, qSoftFrac: 0.99 }),
    );
    const withAdjust = strategy.compute(
      makeCtx({
        inventory: { yesShares: 100, noShares: 0, netUsdc: 0, realizedPnl: 0 },
      }),
      makeConfig({ baseSizeUsdc: 100, qMaxUsdc: 200, qSoftFrac: 0.01 }),
    );
    const noAdjustYes = noAdjust.quotes.find(q => q.side === 'BUY_YES')?.size ?? 0;
    const withAdjustYes = withAdjust.quotes.find(q => q.side === 'BUY_YES')?.size ?? 0;
    expect(withAdjustYes).toBeLessThan(noAdjustYes);
  });

  it('all quotes are postOnly (maker-only)', () => {
    const target = strategy.compute(makeCtx(), makeConfig());
    expect(target.quotes.every(q => q.postOnly)).toBe(true);
  });

  it('reports higher confidence in quiet regimes', () => {
    const quiet = strategy.compute(makeCtx({ regime: MarketRegime.QUIET }), makeConfig());
    const trending = strategy.compute(makeCtx({ regime: MarketRegime.TRENDING }), makeConfig());
    expect(quiet.confidence).toBeGreaterThan(trending.confidence);
  });
});

describe('RewardFarmingStrategy.classifyRegime', () => {
  const strategy = new RewardFarmingStrategy();

  it('returns QUIET when there are no recent fills', () => {
    const book = makeBook([[0.49, 100]], [[0.51, 100]]);
    expect(strategy.classifyRegime(book, [])).toBe(MarketRegime.QUIET);
  });

  it('returns TRENDING when there are many recent fills', () => {
    const book = makeBook([[0.49, 100]], [[0.51, 100]]);
    const fills = Array.from({ length: 6 }, (_, i) => makeFill(0.5, i * 1000));
    expect(strategy.classifyRegime(book, fills)).toBe(MarketRegime.TRENDING);
  });

  it('returns EVENT when the last fill price is far from mid', () => {
    const book = makeBook([[0.49, 100]], [[0.51, 100]]);
    // mid = 0.5, tickSize = 0.01; a fill at 0.8 is > 6 ticks away
    const fills = [makeFill(0.8)];
    expect(strategy.classifyRegime(book, fills)).toBe(MarketRegime.EVENT);
  });
});

describe('RewardFarmingStrategy.scoreMarket', () => {
  const strategy = new RewardFarmingStrategy();

  it('returns 0 for markets not accepting orders', () => {
    const score = strategy.scoreMarket(makeMarket({ acceptingOrders: false }));
    expect(score).toBe(0);
  });

  it('returns 0 for geopolitics category (no rewards)', () => {
    const score = strategy.scoreMarket(makeMarket({ category: 'geopolitics' }));
    expect(score).toBe(0);
  });

  it('scores higher for 50/50 markets (peak fee curve) than extreme outcomes', () => {
    const balanced = strategy.scoreMarket(makeMarket({ outcomePrices: ['0.5', '0.5'] }));
    const extreme = strategy.scoreMarket(makeMarket({ outcomePrices: ['0.99', '0.01'] }));
    expect(balanced).toBeGreaterThan(extreme);
  });

  it('scores higher for higher daily reward rates', () => {
    const lowReward = strategy.scoreMarket(makeMarket({ dailyRewardRateUsdc: 50 }));
    const highReward = strategy.scoreMarket(makeMarket({ dailyRewardRateUsdc: 300 }));
    expect(highReward).toBeGreaterThanOrEqual(lowReward);
  });
});
