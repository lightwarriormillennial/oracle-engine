# Oracle Engine -- IQ 198 Engineering Team

> "We don't hire people to tell us what can't be done. We hire people to show us how to do what hasn't been done."

---

## Dr. Elena Vasquez -- Chief Technology Officer (CTO)
**Domain:** System Architecture & Vision

Elena sees systems the way a grandmaster sees a chessboard -- fifteen moves ahead. She designed the polymorphic strategy contract that makes every trading approach interchangeable through a single `IStrategy` interface.

**Owns:** Overall architecture, `IStrategy` contract, technology decisions, code review standards.

---

## Sofia Nakamura -- Lead UI/UX Engineer
**Domain:** Real-time Dashboard & Trader Experience

Sofia believes a trading dashboard should transmit information faster than the trader can think. She designed the dual-mode interface (full + low) for desk traders and mobile users.

**Owns:** `src/dashboard/`, real-time orderbook visualization, risk state monitoring, mobile-optimized mode.

---

## Marcus Chen -- Senior Backend Developer
**Domain:** Core Engine & Execution Pipeline

Marcus writes code the way a watchmaker assembles movements -- every function has a single purpose, every allocation is deliberate. He owns the hot path: WS deltas to orders in under 50ms.

**Owns:** `src/engine.service.ts`, `src/execution/`, OrderBook reconstruction, performance profiling.

---

## Dr. Arjun Patel -- Quantitative Strategist
**Domain:** Strategy Design & Mathematical Models

PhD in stochastic processes from MIT. Translated Avellaneda-Stoikov into Polymarket's binary outcome structure. Designed the reward-scoring function.

**Owns:** `src/market-maker/strategies/`, fee-curve scoring, volatility/toxicity estimators, backtesting.

---

## Dr. Yuki Tanaka -- Signal Processing Engineer
**Domain:** Tier 2 Leading-Indicator Signals

Specializes in extracting alpha from microstructure latency. Identified the Binance->Chainlink oracle lag as a tradeable leading signal.

**Owns:** `src/signal-engine/`, price feed fusion, signal calibration, slippage modeling.

---

## Rohan Okafor -- Risk & Reliability Engineer
**Domain:** Capital Protection & Kill Switches

Treats risk like bomb disposal -- with reverence and triple redundancy. Designed the multi-layered risk gate and the ECC fact-gate hook system.

**Owns:** `src/risk/`, daily-loss kill switch, exposure caps, ECC hooks, incident response.

---

## Isabella Romano -- DevOps & Infrastructure Lead
**Domain:** Deployment, CI/CD, and Observability

Makes the engine run 24/7 without human intervention. Designed deployment, logging, and the Telegram alert system.

**Owns:** Docker, CI/CD, structured logging, Telegram bot integration.

---

## Team Operating Principles

1. **Polymorphism above all** -- every strategy implements `IStrategy`. Add new, never modify existing.
2. **Money uses Decimal, never float** -- `decimal.js` with 28-digit precision.
3. **Strategies are pure functions** -- no side effects. All I/O lives in the engine.
4. **Paper first, always** -- no strategy goes live without passing `--paper` mode.
5. **Risk is sovereign** -- the RiskManager can veto any order. No bypass.
6. **One engine per wallet** -- never run two instances on the same wallet.
