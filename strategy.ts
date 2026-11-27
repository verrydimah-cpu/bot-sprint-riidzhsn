// Dip-bounce overlay + pace-tracked probe engine for the pump.fun bonding-curve
// replay (protocol agent-fun/replay/v2).
//
// Two engines share the five position slots:
//
// 1. Probe engine (guardrails). The scoring bar asks for a round trip of at
//    least 0.01 SOL on each of at least 20 coins, roughly 200 fills, and a
//    max drawdown under 50%. The probe engine buys a small fixed ticket
//    (0.012 SOL) on the deepest liquid curve it has seen trade recently,
//    holds it for a handful of slots, and sells it back. Each trip costs
//    roughly the curve fees plus the two transaction fees and carries almost
//    no directional risk. Trips are paced against the slot clock of the
//    replay itself: the engine tracks how many trips *should* be done by
//    this slot of a 6-hour window and only opens a new probe while it is
//    behind pace, preferring coins it has not round-tripped yet so the
//    distinct-coin bar is met early.
//
// 2. Bounce overlay (the PnL attempt). Chasing strength on these curves gets
//    sold into, so the overlay does the opposite: it waits for a deep curve
//    that has fallen hard from its recent high, checks that buyers are
//    stepping back in and that the price has actually turned up off its
//    local low, and only then buys a small ticket. Exits are mechanical and
//    fast: take profit, a hard stop, a trailing stop once the trade is in
//    profit, and a slot limit. The overlay is deliberately tiny — a couple
//    of concurrent tickets and a small lifetime entry budget — so its worst
//    case is a bounded bleed while a trending window can still pay.
//
// The strategy is a pure function of the hello/batch stream: no clock, no
// Math.random, no environment reads, and every map is walked in insertion
// order, so the two graded executions emit identical orders.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // ---- probe engine ----
  /** Lamports per probe buy (must stay >= the 0.01 SOL round-trip bar). */
  probeSize: bigint;
  /** Slots a probe is held before the time exit fires. */
  probeHoldSlots: number;
  /** A probe also exits early once its value reaches cost * (1 + this). */
  probeScratchGain: number;
  /** ...or once its value falls to cost * (1 - this). */
  probeCutLoss: number;
  /** Minimum real SOL reserve (lamports) for a curve to host a probe. */
  probeMinRealSol: bigint;
  /** The curve must have traded within this many slots to host a probe. */
  probeFreshSlots: number;
  /** Most probes open at the same time. */
  probeMaxOpen: number;
  /** Round trips the engine aims to complete inside the window. */
  probeTargetTrips: number;
  /** Slot offset by which the target should be reached (pace deadline). */
  probePaceSlots: number;
  /** Slots a coin rests after a probe exit before it can host another. */
  probeCooldownSlots: number;
  // ---- bounce overlay ----
  /** Lamports per bounce buy. */
  bounceSize: bigint;
  /** Lookback (slots) for the recent high the dip is measured from. */
  bounceHighSlots: number;
  /** Dip band: enter when price is between these fractions below the high. */
  bounceDipMin: number;
  bounceDipMax: number;
  /** Minimum real SOL reserve (lamports) for a bounce candidate. */
  bounceMinRealSol: bigint;
  /** Price must have risen at least this fraction off the local low. */
  bounceTurnUp: number;
  /** Lookback (slots) for the local low the turn-up is measured from. */
  bounceLowSlots: number;
  /** Of the last `bounceFlowTrades` trades at least this many must be buys. */
  bounceFlowTrades: number;
  bounceFlowBuys: number;
  /** Most bounce positions open at once, and most bounce entries per run. */
  bounceMaxOpen: number;
  bounceMaxEntries: number;
  /** Exit fractions on liquidation value versus cost. */
  bounceTakeProfit: number;
  bounceStopLoss: number;
  /** Trailing stop: arms at this gain, exits this many points below the best gain. */
  bounceTrailArm: number;
  bounceTrailGive: number;
  /** Slot limit for a bounce position. */
  bounceMaxHoldSlots: number;
  /** Slots a coin rests after a bounce exit. */
  bounceCooldownSlots: number;
  // ---- shared ----
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  probeSize: 12_000_000n,
  probeHoldSlots: 18,
  probeScratchGain: 0.004,
  probeCutLoss: 0.09,
  probeMinRealSol: 3_000_000_000n,
  probeFreshSlots: 150,
  probeMaxOpen: 3,
  probeTargetTrips: 105,
  probePaceSlots: 42_000,
  probeCooldownSlots: 200,
  bounceSize: 45_000_000n,
  bounceHighSlots: 900,
  bounceDipMin: 0.1,
  bounceDipMax: 0.28,
  bounceMinRealSol: 8_000_000_000n,
  bounceTurnUp: 0.02,
  bounceLowSlots: 150,
  bounceFlowTrades: 6,
  bounceFlowBuys: 4,
  bounceMaxOpen: 2,
  bounceMaxEntries: 4,
  bounceTakeProfit: 0.12,
  bounceStopLoss: 0.08,
  bounceTrailArm: 0.04,
  bounceTrailGive: 0.09,
  bounceMaxHoldSlots: 400,
  bounceCooldownSlots: 900,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
};

const CURVE_FEE_BPS = 125n;
const BPS_WHOLE = 10_000n;

/** What a full sell of `tokens` would return after curve fees, at the marked reserves. */
function sellProceeds(mark: Mark | undefined, tokens: bigint): bigint {
  if (mark === undefined || tokens <= 0n) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  const rq = BigInt(mark.real_quote_reserves);
  let gross = (tokens * vq) / (vt + tokens);
  if (gross > rq) gross = rq;
  return gross - (gross * CURVE_FEE_BPS + BPS_WHOLE - 1n) / BPS_WHOLE;
}

/** The reply size cap for a mint, shaved so our own flow cannot push us over it. */
function cappedBuy(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 90n) / 100n;
}

interface Observation {
  slot: number;
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

type TicketKind = 'probe' | 'bounce';

interface Ticket {
  kind: TicketKind;
  openedSlot: number;
  /** Best gain (value/cost - 1) seen while held; drives the trailing stop. */
  bestGain: number;
  /** A sell order for this ticket is in flight. */
  closing: boolean;
}

interface CoinNotes {
  obs: Observation[];
  lastTradeSlot: number;
  restUntil: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const notes = new Map<Pubkey, CoinNotes>();
  const tickets = new Map<Pubkey, Ticket>();
  /** Kind chosen for a buy that has been sent but has not filled yet. */
  const intended = new Map<Pubkey, TicketKind>();
  const trippedCoins = new Set<Pubkey>();
  let firstSlot = -1;
  let tripsDone = 0;
  let bounceEntries = 0;

  const notesFor = (mint: Pubkey): CoinNotes => {
    let n = notes.get(mint);
    if (n === undefined) {
      n = { obs: [], lastTradeSlot: -1, restUntil: -1 };
      notes.set(mint, n);
    }
    return n;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    if (firstSlot < 0) firstSlot = slot;
    const txFee = state.txFeeLamports();
    const orderCap = state.hello.caps.max_orders_per_batch;

    // Fold this batch's trades into the per-coin observation rings.
    const tradedNow: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const n = notesFor(e.mint);
      const vt = BigInt(e.virtual_token_reserves);
      const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
      n.obs.push({ slot, price, realSol: BigInt(e.real_quote_reserves), isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (n.obs.length > 320) n.obs.splice(0, n.obs.length - 320);
      n.lastTradeSlot = slot;
      if (!tradedNow.includes(e.mint)) tradedNow.push(e.mint);
    }

    // Read the fills: a sell that resolved frees its ticket; a rejected or
    // failed opening buy cancels the intention behind it.
    for (const f of batch.fills) {
      if (f.side === 'sell') {
        const t = tickets.get(f.mint);
        if (t !== undefined) t.closing = false;
      } else if (f.status !== 'filled') {
        let stillInFlight = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint && o.order.side === 'buy') stillInFlight = true;
        if (!stillInFlight && !state.positions.has(f.mint)) intended.delete(f.mint);
      }
    }

    // Finalise tickets whose position is gone (sold, completed or flattened):
    // a finished probe counts as a round trip and rests its coin.
    for (const [mint, t] of [...tickets]) {
      if (state.positions.has(mint)) continue;
      let sellInFlight = false;
      for (const o of state.pending.values()) if (o.order.mint === mint && o.order.side === 'sell') sellInFlight = true;
      if (sellInFlight) continue;
      tickets.delete(mint);
      const n = notesFor(mint);
      if (t.kind === 'probe') {
        tripsDone += 1;
        trippedCoins.add(mint);
        n.restUntil = slot + p.probeCooldownSlots;
      } else {
        n.restUntil = slot + p.bounceCooldownSlots;
      }
    }

    // Adopt positions we hold but have no ticket for (their buy just filled).
    for (const mint of state.positions.keys()) {
      if (!tickets.has(mint)) {
        const kind = intended.get(mint) ?? 'probe';
        tickets.set(mint, { kind, openedSlot: slot, bestGain: 0, closing: false });
        intended.delete(mint);
      }
    }

    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const busyMints = new Set<Pubkey>();
    for (const o of state.pending.values()) busyMints.add(o.order.mint);

    const orders: OrderInput[] = [];
    const gainOf = (mint: Pubkey): number => {
      const h = state.positions.get(mint);
      if (h === undefined || h.cost_lamports <= 0n) return 0;
      const value = sellProceeds(marks.get(mint), h.token_amount);
      return Number(value - h.cost_lamports) / Number(h.cost_lamports);
    };

    // ---- 1. exits for everything held -------------------------------------
    for (const [mint, h] of state.positions) {
      if (orders.length >= orderCap) break;
      const t = tickets.get(mint);
      if (t === undefined || t.closing || busyMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const gain = gainOf(mint);
      if (gain > t.bestGain) t.bestGain = gain;
      const age = slot - t.openedSlot;
      let exit = false;
      if (t.kind === 'probe') {
        exit =
          age >= p.probeHoldSlots ||
          (age >= 8 && gain >= p.probeScratchGain) ||
          gain <= -p.probeCutLoss;
      } else {
        exit =
          gain >= p.bounceTakeProfit ||
          gain <= -p.bounceStopLoss ||
          age >= p.bounceMaxHoldSlots ||
          (t.bestGain >= p.bounceTrailArm && gain <= t.bestGain - p.bounceTrailGive);
      }
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: p.sellSlippageBps });
      t.closing = true;
      busyMints.add(mint);
    }

    const openCount = (): number => state.committedPositionCount();
    const openOfKind = (kind: TicketKind): number => {
      let n = 0;
      for (const t of tickets.values()) n += t.kind === kind ? 1 : 0;
      for (const [mint, k] of intended) if (k === kind && !tickets.has(mint)) n += 1;
      return n;
    };
    const canAfford = (amount: bigint): boolean => state.freeCashLamports() - amount - txFee >= 0n;

    // ---- 2. bounce entries on coins that traded in this batch -------------
    for (const mint of tradedNow) {
      if (orders.length >= orderCap) break;
      if (bounceEntries >= p.bounceMaxEntries) break;
      if (openOfKind('bounce') >= p.bounceMaxOpen) break;
      if (openCount() >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || busyMints.has(mint) || intended.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const n = notesFor(mint);
      if (slot < n.restUntil) continue;
      const obs = n.obs;
      if (obs.length < p.bounceFlowTrades) continue;
      const last = obs[obs.length - 1]!;
      if (last.realSol < p.bounceMinRealSol) continue;
      // Recent high and local low from the observation ring.
      let high = 0;
      let low = Number.POSITIVE_INFINITY;
      for (let i = obs.length - 1; i >= 0; i--) {
        const o = obs[i]!;
        if (slot - o.slot <= p.bounceHighSlots && o.price > high) high = o.price;
        if (slot - o.slot <= p.bounceLowSlots && o.price < low) low = o.price;
      }
      if (high <= 0 || !Number.isFinite(low) || low <= 0) continue;
      const dip = 1 - last.price / high;
      if (dip < p.bounceDipMin || dip > p.bounceDipMax) continue;
      if (last.price < low * (1 + p.bounceTurnUp)) continue;
      // Buyers stepping back in: mostly buys at the tail, last trade a buy.
      let buys = 0;
      for (let i = obs.length - p.bounceFlowTrades; i < obs.length; i++) if (obs[i]!.isBuy) buys++;
      if (buys < p.bounceFlowBuys || !last.isBuy) continue;
      let amount = p.bounceSize;
      const capHere = cappedBuy(state, mint);
      if (amount > capHere) amount = capHere;
      if (amount < 10_000_000n) continue;
      if (!canAfford(amount)) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      intended.set(mint, 'bounce');
      busyMints.add(mint);
      bounceEntries++;
    }

    // ---- 3. probe entries, paced against the window's slot clock ----------
    const elapsed = slot - firstSlot;
    const paceDue = Math.min(p.probeTargetTrips, Math.floor((elapsed * p.probeTargetTrips) / p.probePaceSlots));
    let probesWanted = paceDue - tripsDone - openOfKind('probe');
    while (probesWanted > 0) {
      if (orders.length >= orderCap) break;
      if (openOfKind('probe') >= p.probeMaxOpen) break;
      if (openCount() >= state.hello.caps.max_open_positions) break;
      // Deepest fresh curve wins; untripped coins are considered first so the
      // distinct-coin bar is covered before any coin is revisited.
      let pick: Pubkey | null = null;
      let pickReserve = 0n;
      for (const pass of [0, 1]) {
        pick = null;
        pickReserve = 0n;
        for (const [mint, curve] of state.curves) {
          if (curve.complete) continue;
          if (state.positions.has(mint) || busyMints.has(mint) || intended.has(mint)) continue;
          const n = notes.get(mint);
          if (n === undefined) continue;
          if (slot < n.restUntil) continue;
          if (slot - n.lastTradeSlot > p.probeFreshSlots) continue;
          if (curve.real_quote_reserves < p.probeMinRealSol) continue;
          if (cappedBuy(state, mint) < p.probeSize) continue;
          if (pass === 0 && trippedCoins.has(mint)) continue;
          if (curve.real_quote_reserves > pickReserve) {
            pick = mint;
            pickReserve = curve.real_quote_reserves;
          }
        }
        if (pick !== null) break;
      }
      if (pick === null) break;
      if (!canAfford(p.probeSize)) break;
      orders.push({ side: 'buy', mint: pick, quote_lamports: p.probeSize, max_slippage_bps: p.buySlippageBps });
      intended.set(pick, 'probe');
      busyMints.add(pick);
      probesWanted--;
    }

    return orders;
  };
}
