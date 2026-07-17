import { PnlReconciler } from './pnl-reconciler.service';
import { MarketSnapshot } from '../common/interfaces';

// Mock the heavy clients that pull in ESM-only deps (@polymarket/clob-client, ethers)
// so jest's CommonJS transform doesn't choke. We inject our own stubs via the constructor.
jest.mock('../polymarket/clients/ctf.client', () => ({ CtfClient: class {} }));
jest.mock('../polymarket/clients/clob.client', () => ({ ClobClient: class {} }));
jest.mock('../risk/risk-manager.service', () => ({ RiskManager: class {} }));
jest.mock('../alerts/alerts.service', () => ({ AlertsService: class {} }));

function makeReconciler(overrides: {
  ctf?: any;
  clob?: any;
  risk?: any;
  alerts?: any;
  config?: any;
} = {}) {
  const ctf = overrides.ctf ?? {
    isReady: true,
    getInventory: async () => ({ yesShares: 0, noShares: 0, usdcBalance: 0 }),
  };
  const clob = overrides.clob ?? {
    getOrderBook: async () => ({ bids: [{ price: '0.5' }], asks: [{ price: '0.51' }] }),
  };
  const risk = overrides.risk ?? {
    getState: () => ({ realizedDailyPnl: 0 }),
  };
  const alerts = overrides.alerts ?? { send: async () => undefined };
  const config = overrides.config ?? {
    get: (key: string, dft?: any) => {
      const m: Record<string, any> = {
        ENGINE_START_CAPITAL_USDC: 50,
        ENGINE_PNL_DRIFT_TOLERANCE_USDC: 5,
        ENGINE_PNL_DRIFT_TOLERANCE_PCT: 0.05,
        ENGINE_DAILY_LOSS_KILL_USDC: 40,
        ENGINE_BOOK_TTL_MS: 60000,
      };
      return m[key] ?? dft;
    },
  };
  return new PnlReconciler(ctf, clob, risk, alerts, config);
}

function makeMarket(partial: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    conditionId: 'cond-1', slug: 'test-market', question: 'q', category: 'other',
    yesTokenId: 'yes-1', noTokenId: 'no-1', tickSize: 0.01,
    outcomePrices: ['0.5', '0.5'], endDate: '', volume24hr: 1000, liquidity: 5000,
    acceptingOrders: true, negRisk: false, rewardsMinSize: 50, rewardsMaxSpread: 5,
    dailyRewardRateUsdc: 100, makerRebatePct: 0.25,
    ...partial,
  };
}

describe('PnlReconciler.reconcileDaily', () => {
  it('reports zero drift when on-chain equity matches expected', async () => {
    const reconciler = makeReconciler({
      ctf: { isReady: true, getInventory: async () => ({ yesShares: 0, noShares: 0, usdcBalance: 50 }) },
      risk: { getState: () => ({ realizedDailyPnl: 0 }) },
    });
    const report = await reconciler.reconcileDaily([makeMarket()]);
    expect(report.onChainEquityUsdc).toBe(50);
    expect(report.expectedEquityUsdc).toBe(50);
    expect(report.driftUsdc).toBe(0);
    expect(report.breaches).toHaveLength(0);
  });

  it('marks open inventory to mid-price', async () => {
    const reconciler = makeReconciler({
      ctf: {
        isReady: true,
        getInventory: async (yesId: string, noId: string) => ({
          yesShares: yesId === 'yes-1' ? 100 : 0,
          noShares: noId === 'no-1' ? 100 : 0,
          usdcBalance: 0,
        }),
      },
      clob: { getOrderBook: async () => ({ bids: [{ price: '0.6' }], asks: [{ price: '0.62' }] }) },
    });
    const report = await reconciler.reconcileDaily([makeMarket()]);
    // mid = (0.6+0.62)/2 = 0.61; yes=100*0.61 + no=100*0.61 = 122
    expect(report.onChainEquityUsdc).toBeCloseTo(122, 1);
    expect(report.positions).toHaveLength(2);
  });

  it('flags a warning breach when drift exceeds tolerance', async () => {
    const sent: any[] = [];
    const reconciler = makeReconciler({
      ctf: { isReady: true, getInventory: async () => ({ yesShares: 0, noShares: 0, usdcBalance: 30 }) },
      risk: { getState: () => ({ realizedDailyPnl: 0 }) }, // expected 50, on-chain 30 → drift -20
      alerts: { send: async (msg: string, pri: string) => sent.push({ msg, pri }) },
    });
    const report = await reconciler.reconcileDaily([makeMarket()]);
    expect(report.driftUsdc).toBe(-20);
    expect(report.breaches.length).toBeGreaterThanOrEqual(1);
    expect(sent.some((s) => s.pri === 'warn')).toBe(true);
  });

  it('raises a critical breach when drawdown exceeds daily-loss-kill', async () => {
    const sent: any[] = [];
    const reconciler = makeReconciler({
      ctf: { isReady: true, getInventory: async () => ({ yesShares: 0, noShares: 0, usdcBalance: 5 }) },
      risk: { getState: () => ({ realizedDailyPnl: 0 }) }, // expected 50, on-chain 5 → drift -45 > 40
      alerts: { send: async (msg: string, pri: string) => sent.push({ msg, pri }) },
    });
    const report = await reconciler.reconcileDaily([makeMarket()]);
    expect(report.driftUsdc).toBe(-45);
    expect(sent.some((s) => s.pri === 'critical')).toBe(true);
  });

  it('dedupes markets by conditionId', async () => {
    const invCalls: string[] = [];
    const reconciler = makeReconciler({
      ctf: {
        isReady: true,
        getInventory: async (yesId: string, noId: string) => {
          invCalls.push(`${yesId}/${noId}`);
          return { yesShares: 0, noShares: 0, usdcBalance: 0 };
        },
      },
    });
    const m = makeMarket();
    await reconciler.reconcileDaily([m, { ...m, slug: 'dup' }]); // same conditionId
    expect(invCalls).toHaveLength(2); // one market's two token calls only
  });

  it('runs quietly in paper mode with zero balances (structure check)', async () => {
    const reconciler = makeReconciler({
      ctf: { isReady: false, getInventory: async () => ({ yesShares: 0, noShares: 0, usdcBalance: 0 }) },
    });
    const report = await reconciler.reconcileDaily([makeMarket()]);
    expect(report.onChainEquityUsdc).toBe(0);
    expect(report).toBeDefined();
  });
});
