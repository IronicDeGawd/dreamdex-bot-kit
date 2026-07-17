// Local control panel for scripts/bot.ts — pick a config, start/stop the bot,
// watch its logs live. Deliberately dependency-free (Node builtins only).
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 4545);

// -- auth: HTTP Basic, gated on DASHBOARD_USER/DASHBOARD_PASSWORD --
const AUTH_USER = process.env.DASHBOARD_USER;
const AUTH_PASS = process.env.DASHBOARD_PASSWORD;
const AUTH_ENABLED = !!(AUTH_USER && AUTH_PASS);

function safeEqual(a, b) {
  // timingSafeEqual requires equal-length buffers; hash both to a fixed length
  // first so a length mismatch doesn't short-circuit the comparison early.
  const bufA = createHash("sha256").update(a).digest();
  const bufB = createHash("sha256").update(b).digest();
  return timingSafeEqual(bufA, bufB);
}

function checkAuth(req) {
  if (!AUTH_ENABLED) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASS);
}

// -- state: one bot instance at a time, matching how we've been running it --
let child = null;
let startedAt = null;
let lastConfig = {};
const LOG_LIMIT = 500;
const logBuffer = [];
const logClients = new Set();

function pushLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > LOG_LIMIT) logBuffer.shift();
  for (const res of logClients) res.write(`data: ${JSON.stringify(line)}\n\n`);
}

// -- .env parsing (never returns PRIVATE_KEY) --
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of readFileSync(filePath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key === "PRIVATE_KEY") continue;
    out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

function readDefaults() {
  return {
    ...parseEnvFile(path.resolve(root, "../.env.testnet")),
    ...parseEnvFile(path.resolve(root, ".env")),
  };
}

function startBot(config) {
  if (child) throw Object.assign(new Error("already running"), { status: 409 });
  const env = { ...process.env, ...config, DRY_RUN: config.DRY_RUN ?? "true" };
  lastConfig = config;
  child = spawn(process.execPath, ["scripts/bot.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  startedAt = Date.now();
  const onData = (buf) => buf.toString().split("\n").filter(Boolean).forEach(pushLog);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code, signal) => {
    pushLog(`[dashboard] process exited (code=${code} signal=${signal})`);
    child = null;
    startedAt = null;
  });
  return { pid: child.pid, startedAt };
}

function stopBot() {
  if (!child) throw Object.assign(new Error("not running"), { status: 404 });
  const target = child;
  target.kill("SIGINT");
  const killTimer = setTimeout(() => { if (!target.killed) target.kill("SIGKILL"); }, 3000);
  target.once("exit", () => clearTimeout(killTimer));
  return { stopping: true };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="dashboard"', "Content-Type": "text/plain" });
    res.end("authentication required");
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/") {
      const file = path.join(root, "dashboard/public/index.html");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(file));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/defaults") {
      return json(res, 200, readDefaults());
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, { running: !!child, pid: child?.pid ?? null, startedAt, config: lastConfig });
    }
    if (req.method === "POST" && url.pathname === "/api/start") {
      const body = await readBody(req);
      const result = startBot(body.config ?? {});
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const result = stopBot();
      return json(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      for (const line of logBuffer) res.write(`data: ${JSON.stringify(line)}\n\n`);
      logClients.add(res);
      req.on("close", () => logClients.delete(res));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    json(res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`dashboard: http://localhost:${PORT}`);
  if (!AUTH_ENABLED) {
    console.warn("dashboard: no DASHBOARD_USER/DASHBOARD_PASSWORD set — running WITHOUT authentication");
  }
});

process.on("SIGINT", () => {
  if (child) child.kill("SIGINT");
  process.exit(0);
});
