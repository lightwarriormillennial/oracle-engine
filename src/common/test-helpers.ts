/**
 * Shared test helpers for building OrderBook fixtures.
 *
 * Extracted so strategy + orderbook tests can construct identical book shapes
 * without duplicating builder logic.
 */
import {
  OrderBook, OrderBookLevel, MarketSnapshot, Fill,
} from '../common/interfaces';

export function makeBook(
  bids: Array<[number, number]>,
  asks: Array<[number, number]> = [],
  tickSize = 0.01,
): OrderBook {
  const b: OrderBookLevel[] = bids.map(([price, size]) => ({ price, size }))
    .sort((a, b) => b.price - a.price);
  const a: OrderBookLevel[] = asks.map(([price, size]) => ({ price, size }))
    .sort((a, b) => a.price - b.price);
  return {
    tokenId: 'test-tok',
    bids: b,
    asks: a,
    tickSize,
    timestamp: Date.now(),
    bestBid: () => b[0] ?? null,
    bestAsk: () => a[0] ?? null,
    midPrice: () => (b.length && a.length ? (b[0].price + a[0].price) / 2 : 0.5),
    microprice: (levels = 3) => {
      const bL = b.slice(0, levels);
      const aL = a.slice(0, levels);
      if (!bL.length || !aL.length) return b.length ? b[0].price : 0.5;
      const bV = bL.reduce((s, l) => s + l.size, 0);
      const aV = aL.reduce((s, l) => s + l.size, 0);
      const tot = bV + aV;
      if (tot === 0) return 0.5;
      return (bL[0].price * aV + aL[0].price * bV) / tot;
    },
    spread: () => (b.length && a.length ? a[0].price - b[0].price : 1),
    depthAtLevel: (side, levels) =>
      (side === 'bid' ? b : a).slice(0, levels).reduce((s, l) => s + l.size, 0),
  };
}

export function makeMarket(partial: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    conditionId: 'cond-1',
    slug: 'test-market',
    question: 'q?',
    category: 'crypto',
    yesTokenId: 'yes-1',
    noTokenId: 'no-1',
    tickSize: 0.01,
    outcomePrices: ['0.5', '0.5'],
    endDate: '',
    volume24hr: 5000,
    liquidity: 10000,
    acceptingOrders: true,
    negRisk: false,
    rewardsMinSize: 50,
    rewardsMaxSpread: 5,
    dailyRewardRateUsdc: 100,
    makerRebatePct: 0.25,
    ...partial,
  };
}

export function makeFill(price: number, ageMs = 0): Fill {
  return { price, size: 100, side: 'BUY', timestamp: Date.now() - ageMs };
}
