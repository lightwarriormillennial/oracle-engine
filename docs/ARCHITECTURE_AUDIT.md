# Oracle Engine — Architecture Audit & Gap Analysis

**Author:** Sage — Chief of Staff  
**Date:** 2026-07-17  
**Issue:** ALT-192 (Master Build Plan & Architecture)  
**Status:** Phase 1 Foundation VERIFIED — ready for Phase 2

## 1. Build Verification

- `nest build` — passes, zero errors
- TypeScript strict mode (`strictNullChecks`, `noImplicitAny`, `forceConsistentCasingInFileNames`) — enabled
- Total: 20 TypeScript files, 834 LOC

## 2. Module Status

| Module | File | Status |
|--------|------|--------|
| Core Interfaces | `common/interfaces/index.ts` | Complete — IStrategy, OrderBook, FEE_MATRIX |
| Engine Loop | `engine.service.ts` | Partial — scan + WS sub work, handleMarketEvent is TODO |
| RewardFarmingStrategy | `market-maker/strategies/reward-farming.strategy.ts` | Complete |
| AvellanedaStoikovStrategy | `market-maker/strategies/avellaneda-stoikov.strategy.ts` | Complete |
| LeadingSignalStrategy | `signal-engine/signals/leading-signal.strategy.ts` | Complete |
| RiskManager | `risk/risk-manager.service.ts` | Complete — 5 rejection paths, kill switch |
| ExecutionGateway | `execution/execution-gateway.service.ts` | Complete — cancel/replace, paper/live |
| ClobClient | `polymarket/clients/clob.client.ts` | STUB — no EIP-712 signing |
| GammaClient | `polymarket/clients/gamma.client.ts` | Complete |
| AlertsService | `alerts/alerts.service.ts` | Complete — Telegram |
| DashboardGateway | `dashboard/dashboard.gateway.ts` | Complete — Socket.io |

## 3. Critical Gaps

### GAP-1: EIP-712 Order Signing — BLOCKING
- Where: `clob.client.ts:postOrder()` — returns fake stub IDs
- Fix: Install `@polymarket/clob-client`, implement L2 auth header signing
- Effort: ~4h
- Blocks: ALT-189

### GAP-2: OrderBook WS Reconstruction — BLOCKING
- Where: `engine.service.ts:handleMarketEvent()` — empty TODO
- Fix: Parse WS price_change events into OrderBook objects
- Effort: ~6h
- Blocks: all live phases

### GAP-3: Unit Tests
- Zero test files, Jest exits code 1
- Effort: ~8h

### GAP-4: Dockerfile
- Does not exist. Needed for Phase 4.
- Effort: ~1h

### GAP-5: Missing dependency
- `@polymarket/clob-client` not in package.json

## 4. Phase Plan

**Phase 2 (ALT-189):** Fix GAP-1 + GAP-2, wire the trading loop, paper mode 24h, then first $50 live order. Est. 3-5 days.

**Phase 3 (ALT-190):** Binance + Chainlink feeds, backtest 1000+ signals, prove edge survives fees. Est. 5-7 days.

**Phase 4 (ALT-191):** Dashboard, Dockerfile, deploy, 72h unattended. Est. 3-5 days.

## 5. Next Actions

GAP-1 and GAP-2 are the critical path. Assign ALT-189 to an engineer to implement EIP-712 signing and OrderBook reconstruction first.
