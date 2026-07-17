import { CtfClient } from './ctf.client';

describe('CtfClient.planRebalance', () => {
  // Construct without DI: planRebalance is a pure instance method with no constructor deps
  // beyond ConfigService (unused by planRebalance). Pass a stub.
  function makeClient(): CtfClient {
    const stub = { get: () => undefined };
    return new CtfClient(stub as any);
  }

  const opts = { qMaxUsdc: 200, softFrac: 0.6, minSize: 50, minUsdcReserve: 10 };

  it('returns none when inventory is within bands', () => {
    const client = makeClient();
    const plan = client.planRebalance(
      { yesShares: 120, noShares: 100, usdcBalance: 100 },
      opts,
    );
    expect(plan.action).toBe('none');
    // net=20, softCap=120 → within band
  });

  it('merges to flatten when directional skew exceeds the soft band', () => {
    const client = makeClient();
    // net = 180, softCap = 120 → skew breach, matched = 60
    const plan = client.planRebalance(
      { yesShares: 240, noShares: 60, usdcBalance: 100 },
      opts,
    );
    expect(plan.action).toBe('merge');
    expect(plan.amountUsdc).toBeGreaterThan(0);
    expect(plan.reason).toContain('flatten skew');
    // mergeAmount = min(matched=60, |net|-softCap = 180-120 = 60) = 60
    expect(plan.amountUsdc).toBe(60);
  });

  it('does not merge when matched inventory is below minSize', () => {
    const client = makeClient();
    // skew breach but matched (40) < minSize (50)
    const plan = client.planRebalance(
      { yesShares: 200, noShares: 40, usdcBalance: 100 },
      opts,
    );
    expect(plan.action).not.toBe('merge');
  });

  it('splits to re-arm when both sides are depleted and USDC is available', () => {
    const client = makeClient();
    // matched = 10 < minSize 50; usdcAvailable = 200 - 10 = 190
    const plan = client.planRebalance(
      { yesShares: 10, noShares: 10, usdcBalance: 200 },
      opts,
    );
    expect(plan.action).toBe('split');
    expect(plan.amountUsdc).toBeGreaterThan(0);
    expect(plan.reason).toContain('re-arm');
    // splitAmount = min(usdcAvailable=190, qMaxUsdc=200) = 190
    expect(plan.amountUsdc).toBe(190);
  });

  it('does not split when USDC reserve is insufficient', () => {
    const client = makeClient();
    // matched below minSize, but usdcAvailable = 40 - 10 reserve = 30 < minSize 50
    const plan = client.planRebalance(
      { yesShares: 5, noShares: 5, usdcBalance: 40 },
      opts,
    );
    expect(plan.action).toBe('none');
  });

  it('caps split amount at qMaxUsdc', () => {
    const client = makeClient();
    const plan = client.planRebalance(
      { yesShares: 5, noShares: 5, usdcBalance: 1000 },
      opts,
    );
    expect(plan.action).toBe('split');
    expect(plan.amountUsdc).toBe(opts.qMaxUsdc);
  });

  it('truncates amounts to 2 decimal places', () => {
    const client = makeClient();
    const plan = client.planRebalance(
      { yesShares: 241.777, noShares: 60.123, usdcBalance: 100 },
      opts,
    );
    if (plan.amountUsdc > 0) {
      const decimals = (plan.amountUsdc.toString().split('.')[1] || '').length;
      expect(decimals).toBeLessThanOrEqual(2);
    }
  });
});
