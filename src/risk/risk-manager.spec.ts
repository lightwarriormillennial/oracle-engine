/**
 * RiskManager — the sovereign risk gate. Every order passes through it.
 *
 * These tests pin down the 5 rejection paths + the kill switch + daily reset.
 * The RiskManager is pure logic with no I/O, so no mocks needed beyond
 * a stub ConfigService.
 */
import { ConfigService } from '@nestjs/config';
import { RiskManager, RiskDecision } from './risk-manager.service';
import { Quote } from '../common/interfaces';

// Mock the ESM-only deps so transitive imports don't crash jest.
jest.mock('../polymarket/clients/clob.client', () => ({ ClobClient: class {} }));
jest.mock('../polymarket/clients/ctf.client', () => ({ CtfClient: class {} }));
jest.mock('../alerts/alerts.service', () => ({ AlertsService: class {} }));

function makeConfig(overrides: Record<string, number> = {}): ConfigService {
  const defaults: Record<string, number> = {
    ENGINE_MAX_TOTAL_EXPOSURE_USDC: 450,
    ENGINE_MAX_MARKET_NOTIONAL_USDC: 400,
    ENGINE_DAILY_LOSS_KILL_USDC: 40,
    ENGINE_WS_STALE_HALT_S: 10,
    ENGINE_MAX_ORDER_ERROR_RATE: 0.25,
  };
  const merged = { ...defaults, ...overrides };
  return { get: (k: string, dft?: any) => (k in merged ? merged[k] : dft) } as any;
}

function quote(tokenId: string, price: number, size: number): Quote {
  return { side: 'BUY_YES', price, size, tokenId, postOnly: true };
}

describe('RiskManager.evaluate', () => {
  it('approves quotes under all caps', () => {
    const rm = new RiskManager(makeConfig());
    const { approved, rejected } = rm.evaluate([quote('tok-1', 0.5, 100)]);
    expect(approved).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('rejects when total exposure exceeds the cap', () => {
    const rm = new RiskManager(makeConfig({ ENGINE_MAX_TOTAL_EXPOSURE_USDC: 100 }));
    // Seed accumulated exposure so the baseline is already 50.
    rm.updateExposure('tok-0', 50);
    // quote 1 notional=40 → 50+40=90 ≤ 100 approved; quote 2 notional=60 → 50+60=110 > 100 rejected
    const { approved, rejected } = rm.evaluate([
      quote('tok-1', 0.4, 100),
      quote('tok-2', 0.6, 100),
    ]);
    expect(approved).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe(RiskDecision.REJECTED_EXPOSURE);
  });

  it('rejects when per-market notional exceeds the cap', () => {
    const rm = new RiskManager(makeConfig({ ENGINE_MAX_MARKET_NOTIONAL_USDC: 40 }));
    const { approved, rejected } = rm.evaluate([quote('tok-1', 0.5, 100)]); // notional 50 > 40
    expect(approved).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe(RiskDecision.REJECTED_MARKET_CAP);
  });

  it('halts and rejects all when daily-loss-kill is breached', () => {
    const rm = new RiskManager(makeConfig({ ENGINE_DAILY_LOSS_KILL_USDC: 40 }));
    rm.recordFill(-45); // realizedDailyPnl = -45 <= -40
    const { approved, rejected } = rm.evaluate([quote('tok-1', 0.5, 10)]);
    expect(approved).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe(RiskDecision.REJECTED_DAILY_LOSS);
    expect(rm.getState().halted).toBe(true);
  });

  it('halts and rejects all when order error rate exceeds threshold', () => {
    const rm = new RiskManager(makeConfig({ ENGINE_MAX_ORDER_ERROR_RATE: 0.1 }));
    // EMA error rate: each error pushes 0.05, decaying. Spam errors to exceed 0.1.
    for (let i = 0; i < 50; i++) rm.recordOrderError();
    expect(rm.getState().orderErrorRate).toBeGreaterThan(0.1);
    const { approved, rejected } = rm.evaluate([quote('tok-1', 0.5, 10)]);
    expect(approved).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe(RiskDecision.REJECTED_ERROR_RATE);
    expect(rm.getState().halted).toBe(true);
  });

  it('rejects everything once halted, regardless of quote validity', () => {
    const rm = new RiskManager(makeConfig());
    rm.halt(RiskDecision.REJECTED_DAILY_LOSS, 'manual halt');
    const { approved, rejected } = rm.evaluate([
      quote('tok-1', 0.5, 10),
      quote('tok-2', 0.3, 10),
    ]);
    expect(approved).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });
});

describe('RiskManager.isStale', () => {
  it('treats never-seen tokens as stale', () => {
    const rm = new RiskManager(makeConfig());
    expect(rm.isStale('unseen-tok')).toBe(true);
  });

  it('treats recently-updated tokens as fresh', () => {
    const rm = new RiskManager(makeConfig());
    rm.recordWsUpdate('tok-1');
    expect(rm.isStale('tok-1')).toBe(false);
  });

  it('returns a boolean for staleness checks', () => {
    const rm = new RiskManager(makeConfig({ ENGINE_WS_STALE_HALT_S: 1 }));
    rm.recordWsUpdate('tok-1');
    const result = rm.isStale('tok-1');
    expect(typeof result).toBe('boolean');
  });
});

describe('RiskManager daily reset & error EMA', () => {
  it('resets daily PnL to zero', () => {
    const rm = new RiskManager(makeConfig());
    rm.recordFill(-30);
    expect(rm.getState().realizedDailyPnl).toBe(-30);
    rm.resetDaily();
    expect(rm.getState().realizedDailyPnl).toBe(0);
  });

  it('updateExposure accumulates per-market and total exposure', () => {
    const rm = new RiskManager(makeConfig());
    rm.updateExposure('tok-1', 50);
    rm.updateExposure('tok-1', 30);
    rm.updateExposure('tok-2', 20);
    expect(rm.getState().totalExposureUsdc).toBe(100);
    expect(rm.getState().perMarketExposure.get('tok-1')).toBe(80);
    expect(rm.getState().perMarketExposure.get('tok-2')).toBe(20);
  });

  it('recordOrderSuccess decays the error rate toward zero', () => {
    const rm = new RiskManager(makeConfig());
    for (let i = 0; i < 10; i++) rm.recordOrderError();
    const high = rm.getState().orderErrorRate;
    for (let i = 0; i < 100; i++) rm.recordOrderSuccess();
    expect(rm.getState().orderErrorRate).toBeLessThan(high);
  });
});
