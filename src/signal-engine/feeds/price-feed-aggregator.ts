/**
 * PriceFeedAggregator — merges the Binance (fast) and Chainlink (slow) legs into the
 * PriceFeedState that LeadingSignalStrategy consumes.
 *
 * For each asset symbol it maintains:
 *   - latest Binance + Chainlink prices
 *   - EMA(short) / EMA(long) over the Binance tick stream
 *   - rolling momentum (rate of change)
 *   - divergence = (binance - chainlink) / chainlink
 *
 * Also emits a tick log (timestamp, symbol, binance, chainlink, divergence) suitable for
 * backtest data collection — every tick is recorded so historical edge can be analyzed.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BinanceClient } from './binance.client';
import { ChainlinkClient } from './chainlink.client';
import { PriceFeedState } from '../signals/leading-signal.strategy';

export interface FeedTick {
  timestamp: number;
  symbol: string;
  binancePrice: number;
  chainlinkPrice: number;
  divergence: number; // (binance - chainlink) / chainlink
  emaShort: number;
  emaLong: number;
  momentum: number;
}

type TickSink = (tick: FeedTick) => void;

interface SymbolAccumulator {
  emaShort: number;
  emaLong: number;
  momentum: number;
  lastBinancePrice: number;
  binanceTimestamp: number;
  initialized: boolean;
}

@Injectable()
export class PriceFeedAggregator implements OnModuleInit {
  private readonly logger = new Logger(PriceFeedAggregator.name);
  private readonly emaShortPeriod: number;
  private readonly emaLongPeriod: number;
  private readonly momentumWindow: number;
  private readonly accum = new Map<string, SymbolAccumulator>();
  private readonly tickSinks: Set<TickSink> = new Set();

  constructor(
    private binance: BinanceClient,
    private chainlink: ChainlinkClient,
    private config: ConfigService,
  ) {
    this.emaShortPeriod = this.config.get<number>('SIGNAL_EMA_SHORT', 10);
    this.emaLongPeriod = this.config.get<number>('SIGNAL_EMA_LONG', 50);
    this.momentumWindow = this.config.get<number>('SIGNAL_MOMENTUM_WINDOW', 20);
  }

  onModuleInit(): void {
    // Start the oracle poll loop and wire Binance ticks into the EMA update.
    this.chainlink.startPolling();
    this.binance.connect();
    this.binance.onPrice((bp) => this.onBinanceTick(bp));
    this.logger.log(`PriceFeedAggregator started — EMA ${this.emaShortPeriod}/${this.emaLongPeriod}`);
  }

  /** Register a sink to receive every tick (used by the backtest recorder). */
  onTick(sink: TickSink): () => void {
    this.tickSinks.add(sink);
    return () => this.tickSinks.delete(sink);
  }

  /** Build the PriceFeedState the strategy consumes, or null if no data yet. */
  getState(symbol: string): PriceFeedState | null {
    const sym = symbol.toUpperCase();
    const binance = this.binance.getPrice(sym);
    const chainlink = this.chainlink.getPrice(sym);
    const acc = this.accum.get(sym);
    if (!binance || !chainlink || !acc || !acc.initialized) return null;
    return {
      binancePrice: binance.price,
      chainlinkPrice: chainlink.price,
      binanceTimestamp: binance.timestamp,
      chainlinkTimestamp: chainlink.timestamp,
      emaShort: acc.emaShort,
      emaLong: acc.emaLong,
      momentum: acc.momentum,
    };
  }

  /** Snapshot every symbol with live data (for multi-market scanning). */
  getAllStates(): Map<string, PriceFeedState> {
    const out = new Map<string, PriceFeedState>();
    for (const sym of this.accum.keys()) {
      const st = this.getState(sym);
      if (st) out.set(sym, st);
    }
    return out;
  }

  private onBinanceTick(bp: { symbol: string; price: number; timestamp: number }): void {
    const sym = bp.symbol.toUpperCase();
    const acc = this.accum.get(sym) ?? this.newAccumulator();
    const price = bp.price;

    // Standard EMA update: ema = price*K + prev*(1-K), K = 2/(period+1).
    const kShort = 2 / (this.emaShortPeriod + 1);
    const kLong = 2 / (this.emaLongPeriod + 1);
    if (!acc.initialized) {
      acc.emaShort = price;
      acc.emaLong = price;
      acc.momentum = 0;
      acc.lastBinancePrice = price;
      acc.initialized = true;
    } else {
      acc.emaShort = price * kShort + acc.emaShort * (1 - kShort);
      acc.emaLong = price * kLong + acc.emaLong * (1 - kLong);
      // Momentum: simple rate-of-change proxy against last tick, damped by window.
      const roc = (price - acc.lastBinancePrice) / acc.lastBinancePrice;
      acc.momentum = (acc.momentum * (this.momentumWindow - 1) + roc) / this.momentumWindow;
      acc.lastBinancePrice = price;
    }
    acc.binanceTimestamp = bp.timestamp;
    this.accum.set(sym, acc);

    // Emit a tick record for backtest collection if we have an oracle leg.
    const chainlink = this.chainlink.getPrice(sym);
    if (chainlink) {
      const divergence = (price - chainlink.price) / chainlink.price;
      const tick: FeedTick = {
        timestamp: bp.timestamp,
        symbol: sym,
        binancePrice: price,
        chainlinkPrice: chainlink.price,
        divergence,
        emaShort: acc.emaShort,
        emaLong: acc.emaLong,
        momentum: acc.momentum,
      };
      for (const sink of this.tickSinks) {
        try { sink(tick); } catch (e: any) { this.logger.warn(`tick sink error: ${e.message}`); }
      }
    }
  }

  private newAccumulator(): SymbolAccumulator {
    return {
      emaShort: 0,
      emaLong: 0,
      momentum: 0,
      lastBinancePrice: 0,
      binanceTimestamp: 0,
      initialized: false,
    };
  }
}
