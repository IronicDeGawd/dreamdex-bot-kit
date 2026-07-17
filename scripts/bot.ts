// Teaching bot: pick a strategy (mean-reversion / momentum / grid) via STRATEGY,
// and optionally trade whichever pair (WETH:USDso vs WBTC:USDso) is cheapest by
// spread/depth via DYNAMIC_PAIR. Respects DRY_RUN. Educational, not a strategy.
import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool as PoolT } from "@dreamdex-bot-kit/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv({ path: path.resolve(root, "../.env.testnet") });
dotenv({ path: path.resolve(root, ".env") });

const { createChainContext, Pool, ORDER_TYPE, ERC20_ABI, toRaw, alignToLot, fromRaw, shiftBps, spreadBps, readBookLevels } =
  await import("@dreamdex-bot-kit/core");

const num = (k: string, d: number) => Number(process.env[k] ?? d);
const bool = (k: string, d: boolean) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v === "1" || v.toLowerCase() === "true";
};
const list = (k: string, d: string[]) => {
  const v = process.env[k];
  return v ? v.split(",").map((s) => s.trim()) : d;
};

const SYMBOL = process.env.SYMBOL ?? "WETH:USDso";
const DRY_RUN = (process.env.DRY_RUN ?? "true") !== "false";
const [POLL_S, LOOKBACK, ENTRY_BPS] = [num("POLL_S", 10), num("LOOKBACK", 12), num("ENTRY_BPS", 5)];
const [TARGET_BPS, STOP_BPS, MIN_HOLD_S] = [num("TARGET_BPS", 10), num("STOP_BPS", 20), num("MIN_HOLD_S", 60)];
const [LEG_USD, CROSS_BPS] = [num("LEG_USD", 1.9), num("CROSS_BPS", 8)];

const STRATEGY = process.env.STRATEGY ?? "mean-reversion";

// Momentum (reuses TARGET_BPS/STOP_BPS/LEG_USD/CROSS_BPS above for exits/sizing).
const [MOM_WINDOW, MOM_ENTRY_BPS, MOM_EXIT_BPS] = [num("MOM_WINDOW", 8), num("MOM_ENTRY_BPS", 30), num("MOM_EXIT_BPS", 0)];

// Grid.
const [GRID_STEP_BPS, GRID_MAX_INVENTORY_USD, GRID_MAX_SPREAD_BPS] =
  [num("GRID_STEP_BPS", 30), num("GRID_MAX_INVENTORY_USD", LEG_USD * 3), num("GRID_MAX_SPREAD_BPS", 15)];
const [GRID_MAX_SESSION_LOSS_USD, GRID_STUCK_TIMEOUT_S] = [num("GRID_MAX_SESSION_LOSS_USD", 1), num("GRID_STUCK_TIMEOUT_S", 120)];

// Dynamic pair selection.
const DYNAMIC_PAIR = bool("DYNAMIC_PAIR", false);
const PAIR_CANDIDATES = list("PAIR_CANDIDATES", ["WETH:USDso", "WBTC:USDso"]);
const [PAIR_RECHECK_TICKS, PAIR_DEPTH_LEVELS] = [num("PAIR_RECHECK_TICKS", 6), num("PAIR_DEPTH_LEVELS", 3)];
const PAIR_TIE_BPS = num("PAIR_TIE_BPS", 1.5);
const PAIR_MIN_DEPTH_USD = num("PAIR_MIN_DEPTH_USD", LEG_USD * 5);

const ctx = createChainContext();

interface Position { entry: number; qty: number; at: number }
interface Lot { price: number; qty: number }

let pos: Position | undefined;
const mids: number[] = [];
let flat = true; // no strategy has open exposure — gates pair re-checks

let lots: Lot[] = [];
let anchor: number | undefined;
let realizedPnl = 0;
let stuckSince: number | undefined;

// Core has walletBase() but no quote-side equivalent; read the ERC-20 directly.
async function walletQuote(pool: PoolT): Promise<number> {
  const raw = await ctx.publicClient.readContract({
    address: pool.params.quoteToken, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.account.address],
  });
  return fromRaw(raw, pool.quoteDecimals);
}

// Shared placement primitive: aligns to lot, checks minQty and wallet balance,
// then either logs (DRY_RUN) or places for real and prints the tx + explorer link.
async function placeGuarded(pool: PoolT, isBid: boolean, price: number, qtyWanted: number, orderType: number): Promise<number | undefined> {
  const qtyRaw = alignToLot(toRaw(qtyWanted, pool.baseDecimals), pool.params.lotSize);
  const qty = fromRaw(qtyRaw, pool.baseDecimals);
  if (qtyRaw < pool.params.minQuantity) {
    console.log(`  skip: qty ${qty} < minQty ${pool.minQty} — raise size`);
    return undefined;
  }
  // A buy spends quote (USDso), a sell spends base. Check the side we actually
  // pay from — the minQty guard above only checks the market's rules.
  const [have, need, sym] = isBid
    ? [await walletQuote(pool), qty * price, "USDso"]
    : [await pool.walletBase(), qty, pool.symbol.split(":")[0]];
  if (have < need) {
    console.log(`  skip: have ${have.toFixed(4)} ${sym}, need ${need.toFixed(4)}`);
    return undefined;
  }
  if (DRY_RUN) {
    console.log(`  DRY_RUN ${isBid ? "buy" : "sell"} ${qty} @ ${price.toFixed(2)} (${orderType === ORDER_TYPE.PostOnly ? "maker" : "IOC"})`);
    return qty;
  }
  const res = await pool.place({ isBid, price, qty, orderType });
  console.log(`  ${isBid ? "BUY" : "SELL"} ${qty} @ ${price.toFixed(2)} tx=${res.txHash} gas=${res.gasUsed}`);
  console.log(`  explorer: ${ctx.net.explorer}/tx/${res.txHash}`);
  return qty;
}

// Taker crossing helper used by mean-reversion and momentum.
async function trade(pool: PoolT, isBid: boolean, mid: number, touch: number): Promise<number | undefined> {
  // Cross THROUGH the touch: at-the-touch often misses on a moving book.
  const price = shiftBps(touch, isBid ? CROSS_BPS : -CROSS_BPS);
  const qty = await placeGuarded(pool, isBid, price, LEG_USD / price, ORDER_TYPE.ImmediateOrCancel);
  return qty !== undefined ? mid : undefined;
}

async function tickMeanReversion(pool: PoolT): Promise<void> {
  const { bestBid, bestAsk, mid } = await pool.topOfBook();
  if (bestBid === undefined || bestAsk === undefined || mid === undefined) return;

  mids.push(mid);
  if (mids.length > LOOKBACK) mids.shift();
  const mean = mids.reduce((a, b) => a + b, 0) / mids.length;
  const devBps = ((mid - mean) / mean) * 10_000;
  const stamp = new Date().toISOString().slice(11, 19);

  if (!pos) {
    // Wait for a full window before trusting the mean.
    const ready = mids.length >= LOOKBACK;
    console.log(`${stamp} flat  mid=${mid.toFixed(2)} mean=${mean.toFixed(2)} dev=${devBps.toFixed(1)}bps${ready ? "" : " (warmup)"}`);
    if (ready && devBps <= -ENTRY_BPS) {
      console.log(`  SIGNAL: mid ${Math.abs(devBps).toFixed(1)}bps below mean`);
      const entry = await trade(pool, true, mid, bestAsk);
      if (entry !== undefined) { pos = { entry, qty: LEG_USD / entry, at: Date.now() }; flat = false; }
    }
    return;
  }

  const heldS = (Date.now() - pos.at) / 1000;
  const pnlBps = ((mid - pos.entry) / pos.entry) * 10_000;
  console.log(`${stamp} long  mid=${mid.toFixed(2)} entry=${pos.entry.toFixed(2)} pnl=${pnlBps.toFixed(1)}bps held=${heldS.toFixed(0)}s`);
  if (heldS < MIN_HOLD_S) return;

  const reason = pnlBps >= TARGET_BPS ? "TARGET" : pnlBps <= -STOP_BPS ? "STOP" : undefined;
  if (!reason) return;
  console.log(`  ${reason} hit after ${heldS.toFixed(0)}s`);
  if ((await trade(pool, false, mid, bestBid)) === undefined) return;
  console.log(`  CLOSED pnl=${pnlBps.toFixed(1)}bps (${((mid - pos.entry) * pos.qty).toFixed(4)} USDso)`);
  pos = undefined;
  flat = true;
}

async function tickMomentum(pool: PoolT): Promise<void> {
  const { bestBid, bestAsk, mid } = await pool.topOfBook();
  if (bestBid === undefined || bestAsk === undefined || mid === undefined) return;

  mids.push(mid);
  if (mids.length > MOM_WINDOW) mids.shift();
  const stamp = new Date().toISOString().slice(11, 19);
  if (mids.length < MOM_WINDOW) {
    console.log(`${stamp} flat  mid=${mid.toFixed(2)} (warmup ${mids.length}/${MOM_WINDOW})`);
    return;
  }

  // (recent half average − older half average) / older half average, in bps.
  const half = Math.floor(mids.length / 2);
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const olderAvg = avg(mids.slice(0, half));
  const momentumBps = olderAvg > 0 ? ((avg(mids.slice(half)) - olderAvg) / olderAvg) * 10_000 : 0;

  if (pos) {
    const heldS = (Date.now() - pos.at) / 1000;
    const pnlBps = ((mid - pos.entry) / pos.entry) * 10_000;
    console.log(`${stamp} long  mid=${mid.toFixed(2)} entry=${pos.entry.toFixed(2)} pnl=${pnlBps.toFixed(1)}bps momentum=${momentumBps.toFixed(1)}bps held=${heldS.toFixed(0)}s`);
    const reason = pnlBps >= TARGET_BPS ? "TARGET" : pnlBps <= -STOP_BPS ? "STOP" : momentumBps <= MOM_EXIT_BPS ? "FADE" : undefined;
    if (!reason) return;
    console.log(`  ${reason} hit after ${heldS.toFixed(0)}s`);
    if ((await trade(pool, false, mid, bestBid)) === undefined) return;
    console.log(`  CLOSED pnl=${pnlBps.toFixed(1)}bps (${((mid - pos.entry) * pos.qty).toFixed(4)} USDso)`);
    pos = undefined;
    flat = true;
    return;
  }

  console.log(`${stamp} flat  mid=${mid.toFixed(2)} momentum=${momentumBps.toFixed(1)}bps`);
  const breakout = mid >= Math.max(...mids) * 0.999;
  if (momentumBps >= MOM_ENTRY_BPS && breakout) {
    console.log(`  SIGNAL: momentum ${momentumBps.toFixed(1)}bps, breakout`);
    const entry = await trade(pool, true, mid, bestAsk);
    if (entry !== undefined) { pos = { entry, qty: LEG_USD / entry, at: Date.now() }; flat = false; }
  }
}

function closeLots(qty: number, exitPrice: number): void {
  let remaining = qty;
  while (remaining > 1e-12 && lots.length > 0) {
    const lot = lots[0]!;
    const take = Math.min(lot.qty, remaining);
    realizedPnl += (exitPrice - lot.price) * take;
    lot.qty -= take;
    remaining -= take;
    if (lot.qty <= 1e-12) lots.shift();
  }
}

// Buy dips / sell rips around a moving anchor, FIFO lots, maker/taker switching:
// takes with IOC when the counterpart side is present, rests PostOnly when it isn't.
async function tickGrid(pool: PoolT): Promise<void> {
  const { bestBid, bestAsk, mid } = await pool.topOfBook();
  if (mid === undefined) return;
  if (anchor === undefined) anchor = mid;

  const stamp = new Date().toISOString().slice(11, 19);
  if (bestBid !== undefined && bestAsk !== undefined && spreadBps(bestBid, bestAsk) > GRID_MAX_SPREAD_BPS) {
    console.log(`${stamp} sit out — spread ${spreadBps(bestBid, bestAsk).toFixed(1)}bps > ${GRID_MAX_SPREAD_BPS}bps`);
    return; // dislocated book
  }

  const offloadOnly = realizedPnl <= -GRID_MAX_SESSION_LOSS_USD;
  const buyTrigger = shiftBps(anchor, -GRID_STEP_BPS);
  const sellTrigger = shiftBps(lots[0]?.price ?? anchor, GRID_STEP_BPS);
  const inventoryUsd = lots.reduce((s, l) => s + l.qty, 0) * mid;
  const qty = LEG_USD / mid;
  console.log(`${stamp} mid=${mid.toFixed(2)} anchor=${anchor.toFixed(2)} lots=${lots.length} pnl=${realizedPnl.toFixed(4)}`);

  // SELL: oldest lot's target crossed by the best bid.
  if (lots.length > 0 && bestBid !== undefined && bestBid >= sellTrigger) {
    const closing = Math.min(qty, lots.reduce((s, l) => s + l.qty, 0));
    if (closing < pool.minQty) return;
    console.log(`  SELL trigger: bid ${bestBid.toFixed(2)} >= ${sellTrigger.toFixed(2)}`);
    const filled = await placeGuarded(pool, false, bestBid, closing, ORDER_TYPE.ImmediateOrCancel);
    if (filled !== undefined) {
      closeLots(filled, bestBid);
      stuckSince = undefined;
      if (lots.length === 0) flat = true;
    }
    return;
  }

  // BUY: price dipped through the buy trigger, room in inventory.
  if (!offloadOnly && bestAsk !== undefined && bestAsk <= buyTrigger && inventoryUsd < GRID_MAX_INVENTORY_USD && qty >= pool.minQty) {
    const hasAsk = Number.isFinite(bestAsk);
    const price = hasAsk ? bestAsk : buyTrigger;
    const orderType = hasAsk ? ORDER_TYPE.ImmediateOrCancel : ORDER_TYPE.PostOnly;
    console.log(`  BUY trigger: ask ${bestAsk.toFixed(2)} <= ${buyTrigger.toFixed(2)}`);
    const filled = await placeGuarded(pool, true, price, qty, orderType);
    if (filled !== undefined) { lots.push({ price, qty: filled }); flat = false; }
    return;
  }

  // STUCK: holding lots but no sell trigger for too long — cut and re-anchor.
  if (lots.length > 0 && GRID_STUCK_TIMEOUT_S > 0 && bestBid !== undefined) {
    const now = Date.now();
    stuckSince ??= now;
    if (now - stuckSince >= GRID_STUCK_TIMEOUT_S * 1000) {
      const held = lots.reduce((s, l) => s + l.qty, 0);
      console.log(`  stuck ${Math.round((now - stuckSince) / 1000)}s — cutting inventory at bid ${bestBid.toFixed(2)}`);
      if (held >= pool.minQty) {
        const filled = await placeGuarded(pool, false, bestBid, held, ORDER_TYPE.ImmediateOrCancel);
        if (filled !== undefined) closeLots(filled, bestBid);
      } else {
        lots = [];
      }
      anchor = mid;
      stuckSince = undefined;
      flat = lots.length === 0;
    }
  }
}

const STRATEGIES: Record<string, (pool: PoolT) => Promise<void>> = {
  "mean-reversion": tickMeanReversion,
  "momentum": tickMomentum,
  "grid": tickGrid,
};
const strategyTick = STRATEGIES[STRATEGY];
if (!strategyTick) throw new Error(`Unknown STRATEGY "${STRATEGY}". Options: ${Object.keys(STRATEGIES).join(", ")}`);

interface PairScore { symbol: string; pool: PoolT; mid: number; spreadBps: number; depthUsd: number }

async function scorePair(symbol: string): Promise<PairScore | undefined> {
  const p = await Pool.load(ctx, symbol);
  const { bestBid, bestAsk, mid } = await p.topOfBook();
  // A one-sided/empty book is not an error — getBookLevels returns [] rather
  // than reverting — so this pair is just not scoreable right now.
  if (bestBid === undefined || bestAsk === undefined || mid === undefined) return undefined;
  const [bids, asks] = await Promise.all([
    readBookLevels(ctx.publicClient, p.address, true, PAIR_DEPTH_LEVELS),
    readBookLevels(ctx.publicClient, p.address, false, PAIR_DEPTH_LEVELS),
  ]);
  const sumUsd = (levels: { priceRaw: bigint; sizeRaw: bigint }[]) =>
    levels.reduce((s, l) => s + fromRaw(l.sizeRaw, p.baseDecimals) * fromRaw(l.priceRaw, p.quoteDecimals), 0);
  return { symbol, pool: p, mid, spreadBps: spreadBps(bestBid, bestAsk), depthUsd: Math.min(sumUsd(bids), sumUsd(asks)) };
}

// Ranks candidates by tightest spread; book depth only breaks a near-tie or
// rejects a best-spread pool that's too thin to size a trade against safely.
async function pickBestPair(candidates: string[]): Promise<PairScore | undefined> {
  const scored = (await Promise.all(candidates.map((s) => scorePair(s).catch(() => undefined))))
    .filter((s): s is PairScore => s !== undefined);
  if (scored.length === 0) return undefined;
  scored.sort((a, b) => a.spreadBps - b.spreadBps);
  console.log(`  pairs: ${scored.map((s) => `${s.symbol} spread=${s.spreadBps.toFixed(1)}bps depth=$${s.depthUsd.toFixed(0)}`).join(" | ")}`);
  let best = scored[0]!;
  for (const cand of scored.slice(1)) {
    const tie = cand.spreadBps - best.spreadBps <= PAIR_TIE_BPS;
    const bestTooThin = best.depthUsd < PAIR_MIN_DEPTH_USD;
    if ((tie || bestTooThin) && cand.depthUsd > best.depthUsd) best = cand;
  }
  return best;
}

let symbol = SYMBOL;
let pool = await Pool.load(ctx, symbol);
console.log(`${symbol} on ${ctx.net.name} | STRATEGY=${STRATEGY} | DRY_RUN=${DRY_RUN} | tick=${pool.tick} lot=${pool.lot} minQty=${pool.minQty}`);
console.log(`entry<-${ENTRY_BPS}bps target=${TARGET_BPS} stop=${STOP_BPS} hold>=${MIN_HOLD_S}s lookback=${LOOKBACK}${DYNAMIC_PAIR ? ` | DYNAMIC_PAIR candidates=${PAIR_CANDIDATES.join(",")}` : ""}\n`);

let tickCount = 0;
let tickRunning = false; // serializes ticks so overlapping runs can't race for the same wallet nonce

async function runTick(): Promise<void> {
  if (tickRunning) {
    console.log("  busy, skipping tick");
    return;
  }
  tickRunning = true;
  try {
    tickCount++;
    if (DYNAMIC_PAIR && flat && tickCount % PAIR_RECHECK_TICKS === 0) {
      const best = await pickBestPair(PAIR_CANDIDATES);
      if (best && best.symbol !== symbol) {
        console.log(`  SWITCH ${symbol} -> ${best.symbol} (spread ${best.spreadBps.toFixed(1)}bps, depth $${best.depthUsd.toFixed(0)})`);
        symbol = best.symbol;
        pool = best.pool;
        mids.length = 0;
        lots = [];
        anchor = undefined;
      }
    }
    await strategyTick(pool);
  } catch (e) {
    console.error(`  ERROR: ${(e as Error).message}`);
  } finally {
    tickRunning = false;
  }
}

await runTick();
const timer = setInterval(() => void runTick(), POLL_S * 1000);
process.on("SIGINT", () => { clearInterval(timer); console.log("\nstopped."); process.exit(0); });
