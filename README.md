# Dip Catcher — Pump.fun Replay Sprint Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/androyesfernandez/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/androyesfernandez/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve events.

## Strategy

Buy the dip, never chase the run. The bot watches a per-mint tape of
trades and only steps in when:

- the price has fallen **20–40% below its own 2,500-slot high**,
- the last trade was a **buy**,
- at least **3 distinct buyers** have shown up on the tape,
- net flow over the last **60 slots is not negative**,
- the curve holds **5–1,000 SOL** of real reserves, and the dev has not sold.

Stake is flat at **0.05 SOL** per entry. Exits are whole-position only:

- take profit at **+25%** of cost,
- stop loss at **−12%** of cost,
- time stop after **600 slots** held.

At most **5 positions** open, at most **2 entries per mint**, with a
**300-slot cooldown** after an exit. A tiny 0.01 SOL pacing probe exists
only as guardrail insurance so the entry can never fall below the
20-coin / 100-fill pace the rules ask for.

The bot is fully deterministic (insertion-ordered maps, batch order,
bigint arithmetic — no clock, no randomness, no network), so the two
house executions produce byte-identical action logs.

## Run

The entrypoint is `main.ts` (Node 22, TypeScript run as-is). It speaks
the `agent-fun/replay/v2` protocol through the vendored kit SDK in
`vendor/makefun-bot.ts`.

## License

MIT — see [LICENSE](LICENSE).
