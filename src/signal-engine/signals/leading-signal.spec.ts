/**
 * LeadingSignalStrategy — Tier 2 signal-driven strategy tests.
 *
 * Pins: direction detection from Binance/Chainlink divergence, fee-adjusted edge
 * threshold, HALTED gating, and the up/down market scoring filter.
 */
import {
  LeadingSignalStrategy,
  SignalDirection,
  PriceFeedState,
} from './leading-signal.strategy';
import {
  StrategyContext, StrategyConfig, StrategyTier, MarketRegime,
} from '../../common/interfaces';
import { makeBook, makeMarket } from '../../common/test-helpers';

function makeFeed(overrides: Partial<PriceFeedState> = {}): PriceFeedState {
  return {
    binancePrice: 100,
    chainlinkPrice: 100,
    binanceTimestamp: Date.now(),
    chainlinkTimestamp: Date.now(),
    emaShort: 100,
    emaLong: 100,
    momentum: 0,
    ...overrides,
  };
}

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

function makeConfig(feed: PriceFeedState, params: Record<string, number> = {}): StrategyConfig {
  return {
    name: 'leading-signal',
    tier: StrategyTier.TIER_2_SIGNAL,
    // The strategy casts params.signalState via `as any` (see leading-signal.strategy.ts:32),
    // so we do the same here to inject the feed object.
    params: { signalState: feed, ...params } as any,
  };
}

describe('LeadingSignalStrategy.compute', () => {
  const strategy = new LeadingSignalStrategy();

  it('returns no quotes when there is no signal state', () => {
    const ctx = makeCtx();
    const config = { name: 'leading-signal', tier: StrategyTier.TIER_2_SIGNAL, params: {} };
    const target = strategy.compute(ctx, config);
    expect(target.quotes).toHaveLength(0);
    expect(target.confidence).toBe(0);
  });

  it('returns no quotes in a HALTED regime', () => {
    const feed = makeFeed({ binancePrice: 105, chainlinkPrice: 100 });
    const target = strategy.compute(makeCtx({ regime: MarketRegime.HALTED }), makeConfig(feed));
    expect(target.quotes).toHaveLength(0);
  });

  it('returns no quotes when Binance and Chainlink are aligned (no edge)', () => {
    const feed = makeFeed({ binancePrice: 100, chainlinkPrice: 100, emaShort: 100, emaLong: 100 });
    const target = strategy.compute(makeCtx(), makeConfig(feed));
    expect(target.quotes).toHaveLength(0);
  });

  it('emits a BUY_YES when Binance leads upward (divergence above threshold)', () => {
    const feed = makeFeed({
      binancePrice: 110,
      chainlinkPrice: 100,
      emaShort: 105,
      emaLong: 100,
      momentum: 0.01,
    });
    const target = strategy.compute(makeCtx(), makeConfig(feed, { entryThreshold: 0.001 }));
    expect(target.quotes.length).toBeGreaterThanOrEqual(1);
    expect(target.quotes[0].side).toBe('BUY_YES');
    expect(target.confidence).toBeGreaterThan(0);
  });

  it('emits a BUY_NO when Binance leads downward (divergence below threshold)', () => {
    const feed = makeFeed({
      binancePrice: 90,
      chainlinkPrice: 100,
      emaShort: 95,
      emaLong: 100,
      momentum: -0.01,
    });
    const target = strategy.compute(makeCtx(), makeConfig(feed, { entryThreshold: 0.001 }));
    expect(target.quotes.length).toBeGreaterThanOrEqual(1);
    expect(target.quotes[0].side).toBe('BUY_NO');
  });

  it('respects the fee-adjusted minimum edge (no quote when edge < minEdge)', () => {
    // Tiny divergence that produces a small edge, with a high slippage buffer
    const feed = makeFeed({ binancePrice: 100.5, chainlinkPrice: 100 });
    const target = strategy.compute(
      makeCtx(),
      makeConfig(feed, { slippageBuffer: 0.5, divergenceToProbMult: 1 }),
    );
    expect(target.quotes).toHaveLength(0);
  });
});

describe('LeadingSignalStrategy.scoreMarket', () => {
  const strategy = new LeadingSignalStrategy();

  it('returns 0 for non-up/down markets', () => {
    expect(strategy.scoreMarket(makeMarket({ slug: 'will-bitcoin-hit-100k' }))).toBe(0);
  });

  it('returns 0 for markets not accepting orders', () => {
    expect(strategy.scoreMarket(makeMarket({ slug: 'btc-up-or-down', acceptingOrders: false }))).toBe(0);
  });

  it('scores up/down markets positively based on volume', () => {
    const low = strategy.scoreMarket(makeMarket({ slug: 'btc-up-or-down', volume24hr: 1000 }));
    const high = strategy.scoreMarket(makeMarket({ slug: 'btc-up-or-down', volume24hr: 10000 }));
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(0);
  });
});
