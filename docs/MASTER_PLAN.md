# Oracle Engine -- Master Build Plan

## Architecture

```
                         +-----------------+
                         |  Dashboard (UI)  |  <- Sofia
                         |  Socket.io WS    |
                         +--------+--------+
                                  |
                    +-------------v--------------+
                    |      EngineService          |  <- Marcus
                    |  (async event loop)         |
                    +-----+-----------+-----------+
                          |           |
           +--------------v--+   +---v------------+
           |  Strategy Layer |   |  RiskManager   |  <- Rohan
           |  (polymorphic)  |   |  (sovereign)   |
           +------+----------+   +---^------------+
                  |                  |
      +-----------+----------+       | approve/reject
      |                      |       |
+-----v------+     +---------v----+  |
|  Tier 1    |     |   Tier 2     |  |
|  Maker     |     |   Signal     |  |
|            |     |              |  |
| Reward     |     | Leading      |  |
| Farming    |     | Signal       |  |
|            |     | (Binance     |  |
| Avellaneda |     |  lead)       |  |
| Stoikov    |     |              |  |
+-----+------+     +-----+--------+  |
      |                  |           |
      +------+-----------+           |
             | TargetQuotes          |
             +-----------------------+--> ExecutionGateway --> CLOB API
```

## Tier 1 -- Market Making (Passive Reward Farming)

**Goal:** Earn daily pUSD from liquidity rewards + maker rebates with minimal directional risk.

**Strategy:** Post maker-only two-sided quotes within the reward band. Both legs are bids (BUY_YES + BUY_NO) summing below $1, so a filled pair merges back to USDC at locked edge.

**Revenue sources (stacked):**
1. Bid-ask spread (maker fills pay $0 fees)
2. Maker rebates: 15-25% of taker fees (daily pUSD)
3. Liquidity rewards: quadratic-scoring program (daily pUSD)

**Key parameters (from poly-maker live configs):**
| Parameter | Value | Notes |
|-----------|-------|-------|
| baseSizeUsdc | $22-100 | Minimum reward-qualifying size |
| qMaxUsdc | $100-200 | Net directional cap per market |
| gamma | 0.6 | Inventory skew coefficient |
| deltaMinTicks | 1-2 | Half-spread floor |
| dailyLossKill | $40 | Hard stop on realized daily loss |
| maxTotalExposure | $450 | Across all markets |

## Tier 2 -- Signal-Driven Trading (Active Directional)

**Goal:** Exploit the Binance->Chainlink oracle latency to trade up/down markets.

**Strategy:** Monitor Binance real-time price vs. Chainlink oracle. When Binance moves significantly and the Polymarket probability hasn't caught up, enter a directional FOK order.

**Signal components:** EMA crossover, Binance-Chainlink divergence, rolling momentum.

**Risk controls:** FOK orders only, fixed position size, max concurrent positions, net exposure cap.

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2) -- DONE
- [x] Project scaffolding (NestJS + TypeScript)
- [x] Polymorphic IStrategy contract
- [x] Core interfaces (OrderBook, Quote, Market)
- [x] RiskManager with all caps and kill switches
- [x] ExecutionGateway with paper/live modes
- [ ] Polymarket CLOB client -- EIP-712 signing
- [ ] WebSocket orderbook reconstruction

### Phase 2: Tier 1 Live (Week 3-4)
- [ ] RewardFarmingStrategy -- paper trading on live markets
- [ ] Market scoring and selection automation
- [ ] First live trade with $50 capital

### Phase 3: Tier 2 Live (Week 5-6)
- [ ] Binance WS price feed integration
- [ ] Chainlink oracle price feed
- [ ] LeadingSignalStrategy -- backtest on historical data
- [ ] Edge validation: does signal beat fees net?

### Phase 4: Dashboard & Ops (Week 7-8)
- [ ] Real-time dashboard
- [ ] Telegram alert bot
- [ ] Docker deployment
- [ ] 24/7 unattended operation

## Critical Hard Truths

1. **Paper mode is non-negotiable.**
2. **Adverse selection is the #1 killer.**
3. **Small, disposable fills.** Never rest more than the minimum reward size.
4. **One engine per wallet.** Two instances double-order.
5. **The edge is infrastructure, not the model.**
