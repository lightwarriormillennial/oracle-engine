import { BacktestService, type SignalParams } from './backtest.service';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock the PriceFeedAggregator dependency (constructor dep); we test evaluate() via
// runBacktest() with a seeded CSV, so the aggregator only needs to be constructable.
jest.mock('./feeds/price-feed-aggregator', () => ({
  PriceFeedAggregator: class {
    onTick() { return () => undefined; }
  },
}));

function makeService(csvDir: string): BacktestService {
  const stub = {
    get: (key: string, dft?: any) => {
      const m: Record<string, any> = {
        ENGINE_STATE_DIR: csvDir,
        BACKTEST_MAX_SAMPLES: 100000,
        SIGNAL_FEE_BPS: 0.07,
      };
      return m[key] ?? dft;
    },
  };
  return new BacktestService({ onTick: () => () => undefined } as any, stub as any);
}

function writeTicks(csvPath: string, rows: Array<[number, number, number, number]>) {
  // rows: [divergence, binancePrice, chainlinkPrice]
  const lines = ['timestamp,symbol,binancePrice,chainlinkPrice,divergence,emaShort,emaLong,momentum'];
  let t = 1_000_000;
  for (const [div, bn, cl] of rows) {
    lines.push([t, 'BTC', bn.toFixed(6), cl.toFixed(6), div.toFixed(8), bn.toFixed(6), (bn * 0.999).toFixed(6), '0.0001'].join(','));
    t += 1000;
  }
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
}

describe('BacktestService.runBacktest', () => {
  let dir: string;
  let csvPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    csvPath = path.join(dir, 'signal-ticks.csv');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const params: SignalParams = {
    entryThreshold: 0.0001,
    emaWeight: 0.3, divergenceWeight: 0.5, momentumWeight: 0.2,
    divergenceToProbMult: 2.0, slippageBuffer: 0.005,
  };

  it('returns null with insufficient data (<100 ticks)', async () => {
    writeTicks(csvPath, Array.from({ length: 50 }, (_, i): [number, number, number, number] => [0.001, 50000 + i, 49995, 0]));
    const svc = makeService(dir);
    expect(await svc.runBacktest(params)).toBeNull();
  });

  it('counts signals, winners, and computes winRate', async () => {
    // 150 ticks: divergence consistently positive, price rises (winners).
    const rows = Array.from({ length: 150 }, (_, i) => [0.002, 50000 + i, 49995 + i, 0] as [number, number, number, number]);
    writeTicks(csvPath, rows);
    const svc = makeService(dir);
    const result = await svc.runBacktest(params);
    expect(result).not.toBeNull();
    expect(result!.totalSignals).toBeGreaterThan(0);
    expect(result!.winners + result!.losers).toBe(result!.totalSignals);
    expect(result!.winRate).toBeGreaterThanOrEqual(0);
    expect(result!.winRate).toBeLessThanOrEqual(1);
  });

  it('reports gross expectancy and fee cost', async () => {
    const rows = Array.from({ length: 150 }, (_, i): [number, number, number, number] => [0.002, 50000 + i, 49995 + i, 0]);
    writeTicks(csvPath, rows);
    const svc = makeService(dir);
    const result = await svc.runBacktest(params);
    expect(result).not.toBeNull();
    expect(result!.grossExpectancy).toBeGreaterThan(0);
    // fee = slippageBuffer(0.005) + feeBps(0.07)*0.5*0.5 = 0.005 + 0.0175 = 0.0225
    expect(result!.avgFeeCost).toBeCloseTo(0.0225, 3);
  });

  it('marks tradeable=true only when net expectancy is positive', async () => {
    // Strong divergence + consistent uptrend → gross edge should beat fees.
    const rows = Array.from({ length: 200 }, (_, i): [number, number, number, number] => [0.05, 50000 + i * 10, 49000 + i * 10, 0]);
    writeTicks(csvPath, rows);
    const svc = makeService(dir);
    const result = await svc.runBacktest(params);
    expect(result).not.toBeNull();
    if (result!.tradeable) {
      expect(result!.netExpectancy).toBeGreaterThan(0);
    }
  });
});

describe('BacktestService.sweepParameters', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const csvPath = path.join(dir, 'signal-ticks.csv');
    const rows = Array.from({ length: 150 }, (_, i): [number, number, number, number] => [0.05, 50000 + i, 49000 + i, 0]);
    writeTicks(csvPath, rows);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns tradeable configs sorted by netExpectancy descending', async () => {
    const svc = makeService(dir);
    const results = await svc.sweepParameters();
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].netExpectancy).toBeGreaterThanOrEqual(results[i].netExpectancy);
    }
  });

  it('returns empty array with no recorded data', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-empty-'));
    try {
      const svc = makeService(emptyDir);
      expect(await svc.sweepParameters()).toEqual([]);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
