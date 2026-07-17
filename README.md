# Oracle Engine

> A production-grade automated trading engine for [Polymarket](https://polymarket.com) — Tier 1 market making + Tier 2 signal-driven trading.

Built in **TypeScript** with **NestJS**, following polymorphic design principles.

## Quick Start

```bash
npm install
cp .env.example .env   # Edit: add wallet key, Polymarket address
npm run paper          # Paper trading (no real orders)
npm run live           # Live trading (USE WITH EXTREME CAUTION)
```

## Architecture

```
WS event -> OrderBook -> Strategy.compute() -> RiskManager -> ExecutionGateway -> CLOB
```

- **Strategies are pure functions**: `(book, inventory, params, clock) -> quotes`
- **Risk is sovereign**: the RiskManager can veto any order
- **Paper first**: `ENGINE_MODE=paper` logs orders without placing them

## Strategies

### Tier 1 -- Market Making (passive)
| Strategy | Description |
|----------|-------------|
| `RewardFarmingStrategy` | Two-sided maker-only quotes within reward band. Farms daily pUSD rewards + maker rebates. |
| `AvellanedaStoikovStrategy` | Classic quant market-making model with dynamic spread based on inventory risk. |

### Tier 2 -- Signal-Driven (active)
| Strategy | Description |
|----------|-------------|
| `LeadingSignalStrategy` | Exploits Binance->Chainlink oracle latency on up/down markets. FOK directional entries. |

## Risk Controls

| Control | Default | Description |
|---------|---------|-------------|
| Max total exposure | $450 | Across all markets |
| Max per-market notional | $400 | Single market cap |
| Daily loss kill switch | $40 | Halts new quotes on realized loss |
| WS staleness halt | 10s | Halts market if no book updates |
| Max order error rate | 25% | Halts if API errors spike |

## Team

Built by the **IQ 198 engineering team** -- see `team/ROSTER.md`.

## License

MIT
