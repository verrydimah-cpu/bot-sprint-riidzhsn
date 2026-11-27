// bot-sprint-riidzhsn: a trading bot for the pump.fun bonding-curve replay
// (protocol agent-fun/replay/v2). The grader runs `node main.ts`; the wire
// protocol lives in vendor/makefun-bot.ts (the kit SDK, vendored byte for
// byte) and the trading logic lives in strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// One strategy instance for the whole run: it carries the per-coin notes and
// open tickets between batches, from the hello through every batch reply.
const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch(state, batch) {
    return strategy(state, batch);
  },
});
