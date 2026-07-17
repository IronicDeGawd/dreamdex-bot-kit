// Read-only ticker: polls top of book for WETH:USDso every 5s and prints
// best bid / best ask / mid / spread in bps. Sends no transactions.
//
//   npx tsx scripts/watch-weth.ts
//
import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv({ path: path.resolve(root, "../.env.testnet") });
dotenv({ path: path.resolve(root, ".env") });

const { createChainContext, Pool, spreadBps } = await import("@dreamdex-bot-kit/core");

const SYMBOL = "WETH:USDso";
const INTERVAL_MS = 5_000;

function fmt(price: number | undefined): string {
  return price !== undefined ? price.toFixed(6).padStart(14) : "—".padStart(14);
}

async function tick(pool: Pool): Promise<void> {
  const stamp = new Date().toISOString().slice(11, 19);
  try {
    const { bestBid, bestAsk, mid } = await pool.topOfBook();
    const spread =
      bestBid !== undefined && bestAsk !== undefined
        ? `${spreadBps(bestBid, bestAsk).toFixed(2).padStart(8)} bps`
        : `${"—".padStart(8)} bps`;
    console.log(`${stamp}  bid=${fmt(bestBid)}  ask=${fmt(bestAsk)}  mid=${fmt(mid)}  spread=${spread}`);
  } catch (err) {
    // Don't swallow: an empty book returns [], so a throw here is a real
    // RPC/ABI failure. Report it and keep polling.
    console.error(`${stamp}  ERROR: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const pool = await Pool.load(ctx, SYMBOL);

  console.log(`\nnetwork : ${ctx.net.name} (chain ${ctx.net.chainId})`);
  console.log(`market  : ${SYMBOL} @ ${pool.address}`);
  console.log(`tick=${pool.tick}  lot=${pool.lot}  minQty=${pool.minQty}`);
  console.log(`polling every ${INTERVAL_MS / 1000}s — ctrl-c to stop\n`);

  await tick(pool);
  const timer = setInterval(() => void tick(pool), INTERVAL_MS);

  process.on("SIGINT", () => {
    clearInterval(timer);
    console.log("\nstopped.");
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
