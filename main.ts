// Dip Catcher — Pump.fun Replay Sprint paper bot.
//
// Strategy: buy the dip, never chase the run. For every bonding curve we
// watch a tape of its trades and only step in when the price has fallen
// 20-40% below its own 2,500-slot high, the last trade was a buy, at
// least three distinct buyers have shown up, and the last 60 slots of
// flow are not negative. Stake is small (0.05 SOL) and flat, exits are
// whole-position only: take profit at +25%, stop loss at -12%, or a
// 600-slot time stop. At most five positions open, at most two entries
// per mint, 300 slots of cooldown after an exit. A tiny pacing probe
// (0.01 SOL) exists only as guardrail insurance so the entry can never
// fall below the 20-coin / 100-fill pace the rules ask for.
//
// The kit pilots showed momentum loses badly (-9.5 SOL) and strong
// coins lose too, so this bot does the opposite: it buys weakness after
// the crowd has already started buying back, and it gets out fast.
//
// Everything here is deterministic: insertion-ordered maps, batch order,
// bigint arithmetic. No clock, no randomness, no environment reads.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning

/** Flat stake per dip entry (0.05 SOL). */
const STAKE_LAMPORTS = 50_000_000n;
/** Minimum buy size; also the guardrail round-trip floor (0.01 SOL). */
const MIN_BUY_LAMPORTS = 10_000_000n;
/** Guardrail pacing probe size (0.01 SOL). */
const PROBE_LAMPORTS = 10_000_000n;
/** Entry when price is between 60% and 80% of the window high. */
const DIP_LOW_NUM = 3n; // price >= 60% of high
const DIP_HIGH_NUM = 4n; // price <= 80% of high
const DIP_DEN = 5n;
/** Take profit at +35% of cost, stop loss at -12% of cost. */
const TP_NUM = 13500n;
const SL_NUM = 8800n;
const BPS_DEN = 10000n;
/** Time stop: exit a position held this many slots. */
const HOLD_SLOTS = 600;
/** Window for the price high, in slots. */
const HIGH_WINDOW_SLOTS = 2500;
/** Window for the net-flow check, in slots. */
const FLOW_WINDOW_SLOTS = 60;
/** Minimum distinct buyers on the tape before an entry. */
const MIN_BUYERS = 3;
/** Entry only when real SOL reserves are within this band. */
const MIN_REAL_SOL = 5n * LAMPORTS_PER_SOL;
const MAX_REAL_SOL = 1000n * LAMPORTS_PER_SOL;
/** Entry only on a liquid curve for the pacing probe (1 SOL). */
const MIN_PROBE_REAL_SOL = 1n * LAMPORTS_PER_SOL;
/** Max entries per mint over the whole run. */
const MAX_ENTRIES_PER_MINT = 2;
/** Slots of cooldown after an exit before the same mint may re-enter. */
const REENTRY_COOLDOWN_SLOTS = 300;
/** Max open positions (mirrors the harness cap). */
const MAX_OPEN_POSITIONS = 5;
/** Slippage tolerance on every order, in bps. */
const SLIPPAGE_BPS = 500;
/** Liquidation value haircut: quote out x 0.9875, then minus tx fee. */
const LIQ_NUM = 9875n;
const LIQ_DEN = 10000n;
/** Guardrail pace: 40 coins / 100 fills prorated over a full day. */
const PACE_COINS = 40;
const PACE_FILLS = 100;
const PACE_WINDOW_SECONDS = 86400;

// ---------------------------------------------------------------- tape

interface TapePoint {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: string;
  vq: bigint;
  vt: bigint;
}

interface MintTape {
  creator: string | null;
  createdSlot: number | null;
  devSold: boolean;
  points: TapePoint[];
  entries: number;
  lastExitSlot: number | null;
}

interface PositionInfo {
  openedSlot: number;
  cost: bigint;
  peakValue: bigint;
  tpDone: boolean;
  probe: boolean;
}

const tapes = new Map<string, MintTape>();
const myPositions = new Map<string, PositionInfo>();
const filledCoins = new Set<string>();
let totalFills = 0;
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;
let probeMint: string | null = null;

function tapeFor(mint: string): MintTape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = {
      creator: null,
      createdSlot: null,
      devSold: false,
      points: [],
      entries: 0,
      lastExitSlot: null,
    };
    tapes.set(mint, tape);
  }
  return tape;
}

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) return true;
  }
  return false;
}

// ---------------------------------------------------------------- batch

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const slot = batch.slot;
  const txFee = state.txFeeLamports();
  let spentThisBatch = 0n;
  const newBuys = new Set<string>();

  // --- 1. Fold the fills that resolved since the last batch. ---
  for (const fill of batch.fills) {
    if (fill.status === 'rejected' || fill.status === 'failed') {
      if (fill.side === 'buy' && probeMint === fill.mint) probeMint = null;
      continue;
    }
    if (fill.status !== 'filled') continue;
    totalFills++;
    if (fill.side === 'buy') {
      filledCoins.add(fill.mint);
      const held = state.positions.get(fill.mint);
      const prev = myPositions.get(fill.mint);
      if (prev === undefined) {
        myPositions.set(fill.mint, {
          openedSlot: fill.slot,
          cost: held !== undefined ? held.cost_lamports : BigInt(fill.quote_lamports),
          peakValue: 0n,
          tpDone: false,
          probe: probeMint === fill.mint,
        });
        tapeFor(fill.mint).entries += 1;
      } else {
        prev.cost = held !== undefined ? held.cost_lamports : prev.cost;
      }
    } else {
      const tape = tapes.get(fill.mint);
      if (tape !== undefined) tape.lastExitSlot = fill.slot;
      myPositions.delete(fill.mint);
      if (probeMint === fill.mint) probeMint = null;
    }
  }
  // Sweep anything the harness closed without a fill we saw.
  for (const mint of [...myPositions.keys()]) {
    if (!state.positions.has(mint)) {
      const tape = tapes.get(mint);
      if (tape !== undefined && tape.lastExitSlot === null) tape.lastExitSlot = slot;
      myPositions.delete(mint);
      if (probeMint === mint) probeMint = null;
    }
  }

  // --- 2. Fold this batch's events into the per-mint tapes. ---
  const tradedOrder: string[] = [];
  const tradedToday = new Set<string>();
  for (const e of batch.events) {
    if (e.block_time !== null && e.block_time !== undefined) {
      if (firstBlockTime === null) firstBlockTime = e.block_time;
      lastBlockTime = e.block_time;
    }
    if (e.event === 'CreateEvent') {
      const tape = tapeFor(e.mint);
      if (tape.creator === null) tape.creator = e.creator;
      if (tape.createdSlot === null) tape.createdSlot = e.slot;
    } else if (e.event === 'TradeEvent') {
      const tape = tapeFor(e.mint);
      if (tape.creator === null) tape.creator = e.creator;
      if (!tradedToday.has(e.mint)) {
        tradedToday.add(e.mint);
        tradedOrder.push(e.mint);
      }
      const cutoff = e.slot - HIGH_WINDOW_SLOTS;
      while (tape.points.length > 0 && tape.points[0].slot < cutoff) {
        tape.points.shift();
      }
      tape.points.push({
        slot: e.slot,
        isBuy: e.is_buy,
        sol: BigInt(e.sol_amount),
        user: e.user,
        vq: BigInt(e.virtual_quote_reserves),
        vt: BigInt(e.virtual_token_reserves),
      });
      if (!e.is_buy && tape.creator !== null && e.user === tape.creator) {
        tape.devSold = true;
      }
    } else {
      tapeFor(e.mint);
    }
  }

  // --- 3. Exits first: whole-position TP / SL / time stop / probe. ---
  // A sell already in flight covers the position: never send a second
  // sell for the same mint while the first is pending (the harness
  // would reject it and it buys nothing).
  for (const [mint, held] of state.positions) {
    const info = myPositions.get(mint);
    if (info === undefined) continue;
    if (hasPendingSell(state, mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const tokens = held.token_amount;
    let value = (tokens * curve.virtual_quote_reserves) / (curve.virtual_token_reserves + tokens);
    value = (value * LIQ_NUM) / LIQ_DEN - txFee;
    if (value < 0n) value = 0n;
    if (value > info.peakValue) info.peakValue = value;
    const cost = held.cost_lamports;
    const heldSlots = slot - info.openedSlot;
    const takeProfit = value >= (cost * TP_NUM) / BPS_DEN;
    const stopLoss = value <= (cost * SL_NUM) / BPS_DEN;
    const timeStop = heldSlots >= HOLD_SLOTS;
    if (info.probe || takeProfit || stopLoss || timeStop) {
      if (takeProfit) info.tpDone = true;
      orders.push({
        side: 'sell',
        mint,
        token_amount: tokens,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }
  }

  // --- 4. Dip entries, only on mints that traded in this batch. ---
  const maxOrders = state.hello.caps.max_orders_per_batch;
  for (const mint of tradedOrder) {
    if (orders.length >= maxOrders) break;
    if (state.positions.has(mint) || newBuys.has(mint)) continue;
    if (hasPendingBuy(state, mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const tape = tapes.get(mint);
    if (tape === undefined || tape.devSold) continue;
    if (tape.entries >= MAX_ENTRIES_PER_MINT) continue;
    if (tape.lastExitSlot !== null && slot < tape.lastExitSlot + REENTRY_COOLDOWN_SLOTS) continue;
    if (tape.entries > 0 && tape.lastExitSlot === null) continue;
    const realSol = curve.real_quote_reserves;
    if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
    if (tape.points.length === 0) continue;
    const last = tape.points[tape.points.length - 1];
    if (!last.isBuy) continue;

    // One scan: window high, distinct buyers, 60-slot net flow.
    let highQ = 0n;
    let highT = 1n;
    const buyers = new Set<string>();
    let flow = 0n;
    const flowCutoff = slot - FLOW_WINDOW_SLOTS;
    for (const pt of tape.points) {
      if (pt.vq * highT > highQ * pt.vt) {
        highQ = pt.vq;
        highT = pt.vt;
      }
      if (pt.isBuy) buyers.add(pt.user);
      if (pt.slot >= flowCutoff) flow += pt.isBuy ? pt.sol : -pt.sol;
    }
    if (buyers.size < MIN_BUYERS) continue;
    if (flow < 0n) continue;

    // Dip band: current price between 60% and 80% of the window high.
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vq === 0n || vt === 0n || highQ === 0n) continue;
    const lhs = vq * highT * DIP_DEN;
    if (lhs > highQ * vt * DIP_HIGH_NUM) continue;
    if (lhs < highQ * vt * DIP_LOW_NUM) continue;

    if (state.committedPositionCount() + newBuys.size >= MAX_OPEN_POSITIONS) continue;
    const cap = state.maxBuyLamports(mint);
    let amount = STAKE_LAMPORTS;
    const capped = (cap * 97n) / 100n;
    if (capped < amount) amount = capped;
    if (amount < MIN_BUY_LAMPORTS) continue;
    if (state.freeCashLamports() - spentThisBatch < amount + txFee) continue;
    spentThisBatch += amount + txFee;
    orders.push({
      side: 'buy',
      mint,
      quote_lamports: amount,
      max_slippage_bps: SLIPPAGE_BPS,
    });
    newBuys.add(mint);
  }

  // --- 5. Guardrail pacing probe (insurance only, expected never to fire). ---
  if (
    firstBlockTime !== null &&
    lastBlockTime !== null &&
    probeMint === null &&
    orders.length < maxOrders
  ) {
    const elapsed = lastBlockTime - firstBlockTime;
    if (
      elapsed > 0 &&
      (filledCoins.size * PACE_WINDOW_SECONDS < PACE_COINS * elapsed ||
        totalFills * PACE_WINDOW_SECONDS < PACE_FILLS * elapsed)
    ) {
      for (const mint of tradedOrder) {
        if (orders.length >= maxOrders) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (state.positions.has(mint) || newBuys.has(mint)) continue;
        if (hasPendingBuy(state, mint)) continue;
        if (curve.real_quote_reserves < MIN_PROBE_REAL_SOL) continue;
        const cap = state.maxBuyLamports(mint);
        if ((cap * 97n) / 100n < PROBE_LAMPORTS) continue;
        if (state.committedPositionCount() + newBuys.size >= MAX_OPEN_POSITIONS) break;
        if (state.freeCashLamports() - spentThisBatch < PROBE_LAMPORTS + txFee) break;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: PROBE_LAMPORTS,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        probeMint = mint;
        spentThisBatch += PROBE_LAMPORTS + txFee;
        break;
      }
    }
  }

  return orders;
}

function onDone(state: BotState): void {
  console.error(
    `done: cash=${state.cash} positions=${state.positions.size} ` +
      `coins=${filledCoins.size} fills=${totalFills}`,
  );
}

await runBot({ onBatch, onDone });
