/**
 * BacktestService — records signal ticks and computes net-of-fees edge expectancy.
 *
 * The central question of Phase 3: the Binance→Chainlink lag is real, but is it
 * tradeable AFTER fees? This service:
 *   1. Records every FeedTick (timestamp, divergence, EMA, momentum) to a CSV sink.
 *   2. Replays recorded ticks through the signal + fee model to compute expectancy.
 *   3. Runs a parameter sweep over (entryThreshold, emaWeight, divergenceWeight) to
 *      find the net-positive configuration.
 *
 * Fee model: taker fee = takerFeeBps * p * (1-p) per the FEE_MATRIX; slippage buffer
 * added to the breakeven edge. A signal "wins" if the resolved outcome matches the
 * direction implied by divergence sign at entry.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PriceFeedAggregator, FeedTick } from './feeds/price-feed-aggregator';

export interface SignalParams {
  entryThreshold: number;
  emaWeight: number;
  divergenceWeight: number;
  momentumWeight: number;
  divergenceToProbMult: number;
  slippageBuffer: number;
}

export interface BacktestResult {
  params: SignalParams;
  totalSignals: number;
  winners: number;
  losers: number;
  winRate: number;
  /** Expected probability-edge per signal, net of fees + slippage. */
  netExpectancy: number;
  /** Gross edge before fees. */
  grossExpectancy: number;
  avgFeeCost: number;
  tradeable: boolean; // netExpectancy > 0
}

const DEFAULT_PARAMS: SignalParams = {
  entryThreshold: 0.001,
  emaWeight: 0.3,
  divergenceWeight: 0.5,
  momentumWeight: 0.2,
  divergenceToProbMult: 2.0,
  slippageBuffer: 0.005,
};

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private readonly stateDir: string;
  private readonly csvPath: string;
  private readonly maxSamples: number;
  private readonly feeBps: number; // crypto taker fee in bps-of-p*(1-p)
  private unsubscribe: (() => void) | null = null;

  constructor(
    private aggregator: PriceFeedAggregator,
    private config: ConfigService,
  ) {
    this.stateDir = this.config.get<string>('ENGINE_STATE_DIR', './state');
    this.csvPath = path.join(this.stateDir, 'signal-ticks.csv');
    this.maxSamples = this.config.get<number>('BACKTEST_MAX_SAMPLES', 100_000);
    this.feeBps = this.config.get<number>('SIGNAL_FEE_BPS', 0.07); // crypto category
  }

  /** Begin recording ticks to the CSV sink for later offline backtesting. */
  startRecording(): void {
    if (this.unsubscribe) return;
    this.ensureDir();
    // Append-mode CSV: timestamp,symbol,binancePrice,chainlinkPrice,divergence,emaShort,emaLong,momentum
    const header = !fs.existsSync(this.csvPath);
    if (header) {
      fs.appendFileSync(this.csvPath, 'timestamp,symbol,binancePrice,chainlinkPrice,divergence,emaShort,emaLong,momentum\n');
    }
    this.unsubscribe = this.aggregator.onTick((tick) => this.recordTick(tick));
    this.logger.log(`Recording signal ticks → ${this.csvPath}`);
  }

  stopRecording(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Replay the recorded CSV through the signal model under given params and compute
   * net-of-fees expectancy. Returns null if insufficient data.
   */
  async runBacktest(params: SignalParams = DEFAULT_PARAMS): Promise<BacktestResult | null> {
    const ticks = await this.loadRecordedTicks();
    if (ticks.length < 100) {
      this.logger.warn(`Backtest needs >=100 recorded ticks, have ${ticks.length}`);
      return null;
    }
    return this.evaluate(ticks, params);
  }

  /**
   * Grid-search over entryThreshold × emaWeight × divergenceWeight and return all
   * tradeable (net-positive) configurations, sorted by expectancy.
   */
  async sweepParameters(): Promise<BacktestResult[]> {
    const ticks = await this.loadRecordedTicks();
    if (ticks.length < 100) return [];
    const thresholds = [0.0005, 0.001, 0.002, 0.004];
    const emaWeights = [0.2, 0.3, 0.4];
    const divWeights = [0.4, 0.5, 0.6, 0.7];
    const results: BacktestResult[] = [];
    for (const entryThreshold of thresholds) {
      for (const emaWeight of emaWeights) {
        for (const divergenceWeight of divWeights) {
          const momentumWeight = Math.max(0, 1 - emaWeight - divergenceWeight);
          const r = this.evaluate(ticks, {
            ...DEFAULT_PARAMS,
            entryThreshold, emaWeight, divergenceWeight, momentumWeight,
          });
          if (r.tradeable) results.push(r);
        }
      }
    }
    results.sort((a, b) => b.netExpectancy - a.netExpectancy);
    this.logger.log(
      `Parameter sweep: ${results.length}/${thresholds.length * emaWeights.length * divWeights.length} configs tradeable` +
      (results[0] ? ` — best netExpectancy=${results[0].netExpectancy.toFixed(5)} winRate=${(results[0].winRate * 100).toFixed(1)}%` : ''),
    );
    return results;
  }

  /** Core evaluation: simulate entries and mark-to-resolution. */
  private evaluate(ticks: FeedTick[], p: SignalParams): BacktestResult {
    let totalSignals = 0;
    let winners = 0;
    let losers = 0;
    let grossEdgeSum = 0;
    let feeCostSum = 0;
    const horizon = Math.min(60, Math.floor(ticks.length / 4)); // look forward N ticks for "resolution"

    for (let i = 0; i < ticks.length - horizon; i++) {
      const t = ticks[i];
      const signal = this.combinedSignal(t, p);
      if (Math.abs(signal) <= p.entryThreshold) continue;

      totalSignals += 1;
      const direction = signal > 0 ? 1 : -1;
      // Gross edge estimate: divergence magnitude mapped to probability space.
      const grossEdge = Math.abs(t.divergence) * p.divergenceToProbMult;
      grossEdgeSum += grossEdge;

      // Resolution: did price move in the signal's direction over the horizon?
      const future = ticks[i + horizon];
      const resolved = Math.sign(future.binancePrice - t.binancePrice) === direction;
      if (resolved) winners += 1; else losers += 1;

      // Fee cost at mid-probability 0.5 (up/down market): feeBps * p * (1-p).
      const midProb = 0.5;
      const feeCost = p.slippageBuffer + this.feeBps * midProb * (1 - midProb);
      feeCostSum += feeCost;
    }

    const winRate = totalSignals > 0 ? winners / totalSignals : 0;
    const grossExpectancy = totalSignals > 0 ? grossEdgeSum / totalSignals : 0;
    const avgFeeCost = totalSignals > 0 ? feeCostSum / totalSignals : 0;
    // Net expectancy: realized gross edge scaled by win-rate asymmetry, minus fees.
    const netExpectancy = grossExpectancy * (2 * winRate - 1) - avgFeeCost;
    return {
      params: p,
      totalSignals, winners, losers, winRate,
      netExpectancy, grossExpectancy, avgFeeCost,
      tradeable: netExpectancy > 0 && totalSignals >= 30,
    };
  }

  private combinedSignal(t: FeedTick, p: SignalParams): number {
    const emaPct = (t.emaShort - t.emaLong) / t.binancePrice;
    return emaPct * p.emaWeight + t.divergence * p.divergenceWeight + t.momentum * p.momentumWeight;
  }

  private recordTick(tick: FeedTick): void {
    try {
      const row = [
        tick.timestamp, tick.symbol, tick.binancePrice.toFixed(6),
        tick.chainlinkPrice.toFixed(6), tick.divergence.toFixed(8),
        tick.emaShort.toFixed(6), tick.emaLong.toFixed(6), tick.momentum.toFixed(8),
      ].join(',') + '\n';
      fs.appendFileSync(this.csvPath, row);
    } catch {
      // Non-fatal: recording is best-effort.
    }
    // Bound file size by trimming from the head when over maxSamples lines.
    this.maybeTrim();
  }

  private maybeTrim(): void {
    try {
      const stat = fs.statSync(this.csvPath);
      // ~160 bytes/row heuristic; trim if over maxSamples rows (~16MB at 100k).
      if (stat.size > this.maxSamples * 160) {
        const content = fs.readFileSync(this.csvPath, 'utf8');
        const lines = content.split('\n');
        const keep = lines.slice(-this.maxSamples);
        fs.writeFileSync(this.csvPath, keep.join('\n'));
      }
    } catch { /* ignore */ }
  }

  private async loadRecordedTicks(): Promise<FeedTick[]> {
    if (!fs.existsSync(this.csvPath)) return [];
    const content = fs.readFileSync(this.csvPath, 'utf8');
    const lines = content.trim().split('\n').slice(1); // skip header
    const ticks: FeedTick[] = [];
    for (const line of lines) {
      const [ts, symbol, bn, cl, div, emaS, emaL, mom] = line.split(',');
      if (!ts || !symbol) continue;
      ticks.push({
        timestamp: Number(ts), symbol,
        binancePrice: parseFloat(bn), chainlinkPrice: parseFloat(cl),
        divergence: parseFloat(div), emaShort: parseFloat(emaS),
        emaLong: parseFloat(emaL), momentum: parseFloat(mom),
      });
    }
    return ticks;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.stateDir)) fs.mkdirSync(this.stateDir, { recursive: true });
  }
}
