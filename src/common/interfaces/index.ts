/**
 * Oracle Engine — Core Interfaces (Polymorphic Contract Layer)
 */

export enum StrategyTier {
  TIER_1_MAKER = 'TIER_1_MAKER',
  TIER_2_SIGNAL = 'TIER_2_SIGNAL',
}

export enum MarketRegime {
  QUIET = 'QUIET',
  TRENDING = 'TRENDING',
  EVENT = 'EVENT',
  REDUCE_ONLY = 'REDUCE_ONLY',
  HALTED = 'HALTED',
}

export interface OrderBookLevel { price: number; size: number; }

export interface OrderBook {
  tokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  tickSize: number;
  timestamp: number;
  bestBid(): OrderBookLevel | null;
  bestAsk(): OrderBookLevel | null;
  midPrice(): number;
  microprice(levels?: number): number;
  spread(): number;
  depthAtLevel(side: 'bid' | 'ask', levels: number): number;
}

export interface Quote {
  side: 'BUY_YES' | 'BUY_NO';
  price: number; size: number; tokenId: string; postOnly: boolean;
}

export interface TargetQuotes {
  quotes: Quote[]; regime: string; fairValue: number; confidence: number;
}

export interface Inventory {
  yesShares: number; noShares: number; netUsdc: number; realizedPnl: number;
}

export interface Fill { price: number; size: number; side: 'BUY' | 'SELL'; timestamp: number; }

export interface MarketSnapshot {
  conditionId: string; slug: string; question: string; category: string;
  yesTokenId: string; noTokenId: string; tickSize: number;
  outcomePrices: [string, string]; endDate: string;
  volume24hr: number; liquidity: number; acceptingOrders: boolean;
  negRisk: boolean; rewardsMinSize: number; rewardsMaxSpread: number;
  dailyRewardRateUsdc: number; makerRebatePct: number;
}

export interface StrategyConfig {
  name: string; tier: StrategyTier; marketSlug?: string;
  params: Record<string, number | string | boolean>;
}

export interface StrategyContext {
  book: OrderBook; market: MarketSnapshot; inventory: Inventory;
  clock: number; volatility: number; toxicity: number; regime: MarketRegime;
}

export interface IStrategy {
  readonly name: string;
  readonly tier: StrategyTier;
  compute(ctx: StrategyContext, config: StrategyConfig): TargetQuotes;
  scoreMarket(market: MarketSnapshot): number;
  classifyRegime(book: OrderBook, recentFills: Fill[]): MarketRegime;
}

export const FEE_MATRIX: Record<string, { takerFee: number; makerRebate: number }> = {
  crypto: { takerFee: 0.07, makerRebate: 0.20 },
  sports: { takerFee: 0.05, makerRebate: 0.15 },
  finance: { takerFee: 0.04, makerRebate: 0.25 },
  politics: { takerFee: 0.04, makerRebate: 0.25 },
  economics: { takerFee: 0.05, makerRebate: 0.25 },
  culture: { takerFee: 0.05, makerRebate: 0.25 },
  weather: { takerFee: 0.05, makerRebate: 0.25 },
  tech: { takerFee: 0.04, makerRebate: 0.25 },
  mentions: { takerFee: 0.04, makerRebate: 0.25 },
  geopolitics: { takerFee: 0.00, makerRebate: 0.00 },
  other: { takerFee: 0.05, makerRebate: 0.25 },
};

export function computeTakerFee(category: string, price: number, shares: number): number {
  const entry = FEE_MATRIX[category] || FEE_MATRIX.other;
  return shares * entry.takerFee * price * (1 - price);
}

/** DI token for the multi-provider array of registered strategies. */
export const STRATEGIES = Symbol('STRATEGIES');
