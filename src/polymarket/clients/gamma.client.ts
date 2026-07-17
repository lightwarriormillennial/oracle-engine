/**
 * GammaClient — Polymarket Gamma API client (read-only market discovery).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketSnapshot } from '../../common/interfaces';

@Injectable()
export class GammaClient {
  private readonly logger = new Logger(GammaClient.name);
  private readonly host: string;

  constructor(private config: ConfigService) {
    this.host = this.config.get<string>('POLY_GAMMA_HOST', 'https://gamma-api.polymarket.com');
  }

  async fetchMarkets(opts?: { limit?: number; active?: boolean; order?: string }): Promise<MarketSnapshot[]> {
    const params = new URLSearchParams({
      limit: String(opts?.limit ?? 100),
      active: String(opts?.active ?? true),
      order: opts?.order ?? 'volume',
      ascending: 'false',
    });
    const resp = await fetch(`${this.host}/markets?${params}`);
    const raw: any[] = await resp.json();
    return raw.map(this.normalizeMarket).filter(Boolean) as MarketSnapshot[];
  }

  async scanRewardMarkets(limit: number = 50): Promise<MarketSnapshot[]> {
    return this.fetchMarkets({ limit, active: true, order: 'volume' });
  }

  private normalizeMarket(raw: any): MarketSnapshot | null {
    try {
      const tokenIds: string[] = JSON.parse(raw.clobTokenIds || '[]');
      const outcomePrices: string[] = JSON.parse(raw.outcomePrices || '["0.5", "0.5"]');
      if (tokenIds.length < 2) return null;
      return {
        conditionId: raw.conditionId, slug: raw.slug, question: raw.question,
        category: (raw.events?.[0]?.tags?.[0]?.slug || 'other'),
        yesTokenId: tokenIds[0], noTokenId: tokenIds[1],
        tickSize: raw.orderPriceMinTickSize ?? 0.01,
        outcomePrices: outcomePrices as [string, string],
        endDate: raw.endDate, volume24hr: raw.volume24hr ?? 0,
        liquidity: raw.liquidityNum ?? raw.liquidity ?? 0,
        acceptingOrders: raw.acceptingOrders ?? true, negRisk: raw.negRisk ?? false,
        rewardsMinSize: raw.rewardsMinSize ?? 50, rewardsMaxSpread: raw.rewardsMaxSpread ?? 5,
        dailyRewardRateUsdc: raw.dailyRewardRateUsdc ?? 0, makerRebatePct: raw.makerRebatePct ?? 0.25,
      };
    } catch { return null; }
  }
}
