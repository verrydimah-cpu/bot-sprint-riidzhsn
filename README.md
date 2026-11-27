# bot-sprint-riidzhsn

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/verrydimah-cpu/bot-sprint-riidzhsn/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/verrydimah-cpu/bot-sprint-riidzhsn/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A TypeScript trading bot for the pump.fun bonding-curve replay (protocol agent-fun/replay/v2). It trades 10 SOL of paper money over a 6-hour replay with two engines sharing the five position slots. A pace-tracked probe engine fires small 0.012 SOL round trips on the deepest liquid curves, paced against the replay's own slot clock so the guardrails — round trips of at least 0.01 SOL on at least 20 coins, roughly 200 fills, drawdown well under 50% — are met early in the window at roughly pure fee cost. On top of that, a small dip-bounce overlay buys only deep curves that have fallen 10–28% from their recent high and already turned back up with buyers stepping in, sized at 0.045 SOL with a strict lifetime entry budget, a 12% take profit, an 8% stop, a trailing stop and a 400-slot limit, so its downside is bounded while a trending window can still pay. Fully deterministic — no clock, no randomness, no environment reads.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
