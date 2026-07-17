---
name: telegram-alerts
description: Add a Telegram monitoring bot to a dreamDEX trading bot so it DMs you alerts — started, filled, paused, errored, disconnected, kill-switch — while it runs 24/7 (e.g. on Railway). Use whenever a user wants alerts/monitoring for their bot, asks "how do I know if my bot is still running", or wants to be pinged when it fills, errors, or dies. Telegram is chosen over Discord because outbound alerts need only a bot token + one HTTPS POST — no gateway, no intents, no open port.
---

# Telegram alerts for your dreamBot

Your bot runs somewhere you can't watch (Railway, a VPS, a Pi). A monitoring
bot closes that gap: the trading bot pushes a one-line message to Telegram on
every event you care about, so your phone tells you it's alive — and tells you
the moment it isn't.

Telegram, not Discord, for one reason: an alert is **one HTTPS POST**. No
websocket gateway, no intents, no bot hosting for the *notifier* itself. It
works from any process that can make an HTTP request, and needs no inbound port
— perfect for Railway's free tier.

## Step 1 — create the bot (30 seconds)

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot`, give it a name and a username ending in `bot`.
3. BotFather replies with a **token** like `8123456789:AAH...`. That's your
   `TG_BOT_TOKEN`. Keep it secret — anyone with it can post as your bot.

## Step 2 — get your chat id

The bot can only message people who have talked to it first.

1. Open your new bot and send it any message (e.g. `hi`).
2. Fetch updates and read the chat id:

```bash
curl -s "https://api.telegram.org/bot$TG_BOT_TOKEN/getUpdates" \
  | grep -oE '"chat":\{"id":[-0-9]+' | head -1
# → "chat":{"id":123456789      →  TG_CHAT_ID=123456789
```

A group works too: add the bot to the group, post a message, and the id will be
**negative** (e.g. `-1001234567890`). Use that as `TG_CHAT_ID`.

## Step 3 — the notifier (drop-in)

`scripts/notify.ts` — no dependencies, safe to call from anywhere. It never
throws (a monitoring call must never crash the thing it monitors) and no-ops
when the env vars are absent, so it's harmless in local/dry-run.

```ts
// scripts/notify.ts
const TOKEN = process.env.TG_BOT_TOKEN;
const CHAT = process.env.TG_CHAT_ID;

export async function notify(text: string): Promise<void> {
  if (!TOKEN || !CHAT) return;                 // silent no-op if not configured
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
    });
  } catch { /* never let an alert failure break the bot */ }
}
```

## Step 4 — wire it into the bot's events

Import it in `scripts/bot.ts` and call it at the moments you'd want to know
about. Alert on **state changes**, not every tick, or you'll mute yourself.

```ts
import { notify } from "./notify";

// on startup
await notify(`🟢 ${SYMBOL} bot up on ${ctx.net.name} · DRY_RUN=${DRY_RUN}`);

// on entry / fill
await notify(`🔵 BUY ${qty} @ ${price.toFixed(2)} (mid ${mid.toFixed(2)})`);

// on close
await notify(`✅ CLOSED ${reason} pnl=${pnlBps.toFixed(1)}bps`);

// in the loop's catch(): errors
.catch((e) => { console.error(e); void notify(`🔴 ERROR: ${(e as Error).message}`); });

// kill switch / shutdown
process.on("SIGINT", () => { void notify("🛑 bot stopped (SIGINT)"); /* ...flatten... */ });
```

**Heartbeat (know it's alive even when quiet).** A silent bot and a dead bot
look identical. Send a low-frequency "still here" so silence means trouble:

```ts
let lastBeat = 0;
// inside tick(), after computing mid:
if (Date.now() - lastBeat > 3_600_000) {           // once an hour
  lastBeat = Date.now();
  void notify(`💓 alive · ${SYMBOL} mid=${mid.toFixed(2)} ${pos ? "long" : "flat"}`);
}
```

## Step 5 — run it 24/7 on Railway

1. Push the bot repo to GitHub.
2. Railway → **New Project → Deploy from GitHub** → pick the repo.
3. **Variables**: add `TG_BOT_TOKEN`, `TG_CHAT_ID`, `PRIVATE_KEY`, `NETWORK`,
   and your strategy knobs (`SYMBOL`, `LEG_USD`, …). Never commit these.
4. **Start command**: `npx tsx scripts/bot.ts` (or add an `npm start` script).
5. Deploy. Within seconds you get the `🟢 bot up` DM — that's your proof the
   deploy worked *and* alerts work, in one shot.

Railway's free tier keeps a small always-on worker running, which is exactly
what a trading loop is. No inbound URL is needed because the bot only makes
*outbound* calls (to the RPC and to Telegram).

## Test it before you trust it

```bash
TG_BOT_TOKEN=... TG_CHAT_ID=... \
  node -e 'fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:process.env.TG_CHAT_ID,text:"test ✅"})}).then(r=>r.json()).then(console.log)'
# → {"ok":true,...}  and the message lands in your chat
```

If `ok:false`: `chat not found` = you haven't messaged the bot yet (Step 2);
`Unauthorized` = wrong token.

## Discord instead? (only if you must)

For alerts, a Discord **webhook** is the equivalent one-POST path — create one
in a channel's settings and POST `{"content":"..."}` to its URL. A Discord
**bot** (gateway + intents) is overkill for one-way alerts; use the webhook.
Everything above maps 1:1 — swap the URL and the JSON field (`content` vs
`text`). Telegram stays the recommended default: no channel/server setup, and
it DMs you directly.

## Alert on these, at minimum

- **up / down** — started, and SIGINT/crash (down is the one that matters most)
- **fills** — every order that actually executes
- **errors** — anything the loop's catch sees
- **drift** — holding inventory longer than expected, or PnL past a threshold
- **heartbeat** — hourly "alive", so silence is a signal
