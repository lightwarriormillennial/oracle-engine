/**
 * ChainlinkClient — reads Chainlink aggregator oracle prices on Polygon.
 *
 * The Tier-2 leading-signal edge comes from Binance price moving before the Chainlink
 * oracle (which Polymarket resolution often lags) updates. This client reads the slow
 * oracle leg so PriceFeedAggregator can compute divergence against the fast Binance leg.
 *
 * Feed addresses are configurable (CHAINLINK_FEED_BTC/ETH/SOL env). Only BTC/USD is
 * verified-live by default; other symbols must be supplied via env. The client polls on
 * a configurable interval (Chainlink updates on-chain, not push).
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

const AGGREGATOR_ABI = [
  'function latestAnswer() view returns (int256)',
  'function decimals() view returns (uint8)',
  'function latestTimestamp() view returns (uint256)',
  'function description() view returns (string)',
];

/** Verified-live Chainlink feeds on Polygon mainnet (BTC/USD works). */
const DEFAULT_FEEDS: Record<string, string> = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
};

export interface OraclePrice {
  symbol: string;
  price: number;
  timestamp: number; // ms epoch
}

@Injectable()
export class ChainlinkClient implements OnModuleDestroy {
  private readonly logger = new Logger(ChainlinkClient.name);
  private readonly provider: ethers.JsonRpcProvider;
  private readonly feeds: Map<string, ethers.Contract> = new Map();
  private readonly pollIntervalMs: number;
  private readonly cache = new Map<string, OraclePrice>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: ConfigService) {
    const rpcUrl =
      this.config.get<string>('POLY_RPC_URL') ||
      this.config.get<string>('RPC_URL') ||
      'https://polygon-bor-rpc.publicnode.com';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.pollIntervalMs = this.config.get<number>('CHAINLINK_POLL_MS', 2000);

    // Merge defaults with env-configured feeds.
    const envFeeds = this.parseEnvFeeds();
    const all = { ...DEFAULT_FEEDS, ...envFeeds };
    for (const [symbol, addr] of Object.entries(all)) {
      try {
        this.feeds.set(symbol.toUpperCase(), new ethers.Contract(addr, AGGREGATOR_ABI, this.provider));
      } catch (e: any) {
        this.logger.warn(`Invalid Chainlink feed for ${symbol} (${addr}): ${e.message}`);
      }
    }
    this.logger.log(`Chainlink client ready — feeds: ${[...this.feeds.keys()].join(', ')}`);
  }

  /** Start polling all feeds into the cache. */
  startPolling(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /** Latest cached price for a symbol (null if not yet polled / unavailable). */
  getPrice(symbol: string): OraclePrice | null {
    return this.cache.get(symbol.toUpperCase()) ?? null;
  }

  /** Fetch a fresh price on demand (also updates cache). */
  async fetchPrice(symbol: string): Promise<OraclePrice | null> {
    const contract = this.feeds.get(symbol.toUpperCase());
    if (!contract) return null;
    try {
      const [answer, decimals, ts] = await Promise.all([
        contract.latestAnswer(),
        contract.decimals(),
        contract.latestTimestamp(),
      ]);
      const price = Number(ethers.formatUnits(answer, Number(decimals)));
      const result: OraclePrice = {
        symbol: symbol.toUpperCase(),
        price,
        timestamp: Number(ts) * 1000,
      };
      this.cache.set(symbol.toUpperCase(), result);
      return result;
    } catch (e: any) {
      this.logger.warn(`fetchPrice(${symbol}) failed: ${e.message}`);
      return null;
    }
  }

  private async refresh(): Promise<void> {
    await Promise.all(
      [...this.feeds.keys()].map((sym) => this.fetchPrice(sym).catch(() => null)),
    );
  }

  /** Parse CHAINLINK_FEED_BTC / _ETH / _SOL env vars into a {symbol: address} map. */
  private parseEnvFeeds(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      const m = /^CHAINLINK_FEED_([A-Z]+)$/.exec(key);
      if (m) {
        const val = process.env[key]?.trim();
        if (val) out[m[1]] = val;
      }
    }
    return out;
  }
}
