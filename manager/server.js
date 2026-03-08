require("dotenv").config({ path: __dirname + "/.env" });
const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");

const app = express();
app.use(express.json());

const AUTH_USER = process.env.MANAGER_USER || "admin";
const AUTH_PASS = process.env.MANAGER_PASS || "changeme";

app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Bailey Manager"');
    return res.status(401).send("Unauthorised");
  }
  const [user, pass] = Buffer.from(auth.slice(6), "base64")
    .toString()
    .split(":");
  if (user !== AUTH_USER || pass !== AUTH_PASS) {
    return res.status(403).send("Forbidden");
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

const ROOT = path.join(__dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");
const TEMPLATE_DIR = path.join(ROOT, "template");
const CONFIG_FILE = path.join(__dirname, "config.json");

// ── Config persistence ────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE))
    return { supabase_url: "", supabase_key: "", accounts: {} };
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── PM2 helpers ───────────────────────────────────────────────────────────────
function pm2List() {
  try {
    const out = execSync("pm2 jlist", { encoding: "utf8" });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function pm2Status(name) {
  const list = pm2List();
  const proc = list.find((p) => p.name === name);
  if (!proc) return "stopped";
  return proc.pm2_env?.status || "stopped";
}

function pm2Start(name, cwd) {
  try {
    const existing = pm2List().find((p) => p.name === name);
    if (existing) {
      execSync(`pm2 restart ${name}`, { encoding: "utf8" });
    } else {
      execSync(`pm2 start index.js --name "${name}" --cwd "${cwd}"`, {
        encoding: "utf8",
      });
    }
    execSync("pm2 save", { encoding: "utf8" });
    return true;
  } catch (e) {
    console.error("pm2 start error:", e.message);
    return false;
  }
}

function pm2Stop(name) {
  try {
    execSync(`pm2 stop ${name}`, { encoding: "utf8" });
    execSync("pm2 save", { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function pm2Delete(name) {
  try {
    execSync(`pm2 delete ${name}`, { encoding: "utf8" });
    execSync("pm2 save", { encoding: "utf8" });
  } catch {}
}

// ── Account folder setup ──────────────────────────────────────────────────────
function writeEnv(accountDir, account, cfg) {
  const lines = [
    `PORT=${account.port}`,
    `ACCOUNT_ID=${account.id}`,
    `SYNC_SUPABASE=${account.sync_supabase ? "true" : "false"}`,
    `SUPABASE_URL=${cfg.supabase_url || ""}`,
    `SUPABASE_KEY=${cfg.supabase_key || ""}`,
    `MANAGER_URL=http://localhost:7400`,
  ];
  fs.writeFileSync(path.join(accountDir, ".env"), lines.join("\n"));
}

function setupAccountFolder(account, cfg) {
  const accountDir = path.join(ACCOUNTS_DIR, account.id);
  fs.mkdirSync(accountDir, { recursive: true });

  // Copy template files (never overwrite .env or auth/)
  const templateFiles = fs.readdirSync(TEMPLATE_DIR);
  for (const file of templateFiles) {
    const src = path.join(TEMPLATE_DIR, file);
    const dst = path.join(accountDir, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
    }
  }

  // Write env (always fresh from config)
  writeEnv(accountDir, account, cfg);

  // Install deps if needed
  if (!fs.existsSync(path.join(accountDir, "node_modules"))) {
    console.log(`Installing deps for ${account.id}...`);
    execSync("npm install", { cwd: accountDir, stdio: "inherit" });
  }

  return accountDir;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/config
app.get("/api/config", (req, res) => {
  const cfg = loadConfig();
  res.json({
    supabase_url: cfg.supabase_url || "",
    supabase_key: cfg.supabase_key ? "••••••••" : "",
  });
});

// POST /api/config
app.post("/api/config", (req, res) => {
  const cfg = loadConfig();
  if (req.body.supabase_url !== undefined)
    cfg.supabase_url = req.body.supabase_url;
  if (
    req.body.supabase_key !== undefined &&
    req.body.supabase_key !== "••••••••"
  )
    cfg.supabase_key = req.body.supabase_key;
  saveConfig(cfg);
  res.json({ ok: true });
});

// GET /api/accounts
app.get("/api/accounts", (req, res) => {
  const cfg = loadConfig();
  const accounts = Object.values(cfg.accounts || {});
  const list = accounts.map((acc) => ({
    ...acc,
    pm2_status: pm2Status(`wa-${acc.id}`),
  }));
  res.json(list);
});

// POST /api/accounts — create new account
app.post("/api/accounts", (req, res) => {
  const { id, name, port, sync_supabase } = req.body;
  if (!id || !port)
    return res.status(400).json({ error: "id and port required" });

  const cfg = loadConfig();
  if (cfg.accounts[id])
    return res.status(409).json({ error: "Account ID already exists" });

  const account = {
    id,
    name: name || id,
    port: parseInt(port),
    sync_supabase: !!sync_supabase,
  };
  cfg.accounts[id] = account;
  saveConfig(cfg);

  try {
    const accountDir = setupAccountFolder(account, cfg);
    pm2Start(`wa-${id}`, accountDir);
    res.json({ ok: true, account });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/accounts/:id — edit account
app.put("/api/accounts/:id", (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  if (req.body.name !== undefined) account.name = req.body.name;
  if (req.body.port !== undefined) account.port = parseInt(req.body.port);
  if (req.body.sync_supabase !== undefined)
    account.sync_supabase = !!req.body.sync_supabase;
  cfg.accounts[req.params.id] = account;
  saveConfig(cfg);

  // Rewrite .env with new values, restart
  const accountDir = path.join(ACCOUNTS_DIR, account.id);
  if (fs.existsSync(accountDir)) {
    writeEnv(accountDir, account, cfg);
    pm2Start(`wa-${account.id}`, accountDir);
  }

  res.json({ ok: true, account });
});

// DELETE /api/accounts/:id
app.delete("/api/accounts/:id", (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  pm2Delete(`wa-${req.params.id}`);
  delete cfg.accounts[req.params.id];
  saveConfig(cfg);

  // Optionally remove folder
  if (req.query.purge === "1") {
    fs.rmSync(path.join(ACCOUNTS_DIR, req.params.id), {
      recursive: true,
      force: true,
    });
  }

  res.json({ ok: true });
});

// POST /api/accounts/:id/start
app.post("/api/accounts/:id/start", (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  const accountDir = path.join(ACCOUNTS_DIR, account.id);
  if (!fs.existsSync(accountDir)) setupAccountFolder(account, cfg);

  const ok = pm2Start(`wa-${account.id}`, accountDir);
  res.json({ ok });
});

// POST /api/accounts/:id/stop
app.post("/api/accounts/:id/stop", (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  pm2Stop(`wa-${account.id}`);
  res.json({ ok: true });
});

// POST /api/accounts/:id/restart
app.post("/api/accounts/:id/restart", (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  const accountDir = path.join(ACCOUNTS_DIR, account.id);
  pm2Start(`wa-${account.id}`, accountDir);
  res.json({ ok: true });
});

// POST /api/accounts/:id/logout — wipe auth
app.post("/api/accounts/:id/logout", (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  pm2Stop(`wa-${account.id}`);
  const authDir = path.join(ACCOUNTS_DIR, account.id, "auth");
  fs.rmSync(authDir, { recursive: true, force: true });
  setTimeout(() => {
    const accountDir = path.join(ACCOUNTS_DIR, account.id);
    pm2Start(`wa-${account.id}`, accountDir);
  }, 2000);

  res.json({ ok: true, message: "Auth cleared, restarting for new QR" });
});

// POST /api/update-all — push template/index.js to all instances then restart
app.post("/api/update-all", (req, res) => {
  const cfg = loadConfig();
  const accounts = Object.values(cfg.accounts || {});
  const results = [];

  for (const account of accounts) {
    const accountDir = path.join(ACCOUNTS_DIR, account.id);
    if (!fs.existsSync(accountDir)) {
      results.push({ id: account.id, status: "folder missing" });
      continue;
    }

    try {
      // Copy only index.js (not .env, not auth/)
      fs.copyFileSync(
        path.join(TEMPLATE_DIR, "index.js"),
        path.join(accountDir, "index.js"),
      );
      // Optionally update package.json and reinstall if changed
      const templatePkg = fs.readFileSync(
        path.join(TEMPLATE_DIR, "package.json"),
        "utf8",
      );
      const accountPkg = fs.existsSync(path.join(accountDir, "package.json"))
        ? fs.readFileSync(path.join(accountDir, "package.json"), "utf8")
        : "";
      if (templatePkg !== accountPkg) {
        fs.copyFileSync(
          path.join(TEMPLATE_DIR, "package.json"),
          path.join(accountDir, "package.json"),
        );
        execSync("npm install", { cwd: accountDir });
      }
      pm2Start(`wa-${account.id}`, accountDir);
      results.push({ id: account.id, status: "updated" });
    } catch (e) {
      results.push({ id: account.id, status: "error", error: e.message });
    }
  }

  res.json({ ok: true, results });
});

// GET /api/accounts/:id/status — proxy to instance
app.get("/api/accounts/:id/status", async (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  try {
    const r = await fetch(`http://localhost:${account.port}/status`);
    const data = await r.json();
    res.json({ ...data, pm2_status: pm2Status(`wa-${account.id}`) });
  } catch {
    res.json({ connected: false, pm2_status: pm2Status(`wa-${account.id}`) });
  }
});

// GET /api/accounts/:id/qr — proxy QR from instance
app.get("/api/accounts/:id/qr", async (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  try {
    const r = await fetch(`http://localhost:${account.port}/qr`);
    const data = await r.json();
    res.json(data);
  } catch {
    res.json({ qr: null });
  }
});

// POST /api/accounts/:id/send — test send
app.post("/api/accounts/:id/send", async (req, res) => {
  const cfg = loadConfig();
  const account = cfg.accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });

  const { number, text } = req.body;
  const jid = normalizeToJid(number);
  if (!jid) return res.status(400).json({ error: "Invalid phone number" });

  try {
    const r = await fetch(`http://localhost:${account.port}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jid, text }),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Number normaliser ─────────────────────────────────────────────────────────
function normalizeToJid(input) {
  if (!input) return null;
  // Strip everything except digits
  let digits = input.replace(/\D/g, "");

  // UK: 07xxx → 447xxx
  if (digits.startsWith("07") && digits.length === 11) {
    digits = "44" + digits.slice(1);
  }
  // UK: 7xxx (10 digits) → 447xxx
  if (digits.startsWith("7") && digits.length === 10) {
    digits = "44" + digits;
  }
  // Must have country code now (min 10 digits)
  if (digits.length < 10) return null;

  return `${digits}@s.whatsapp.net`;
}

app.get("/api/normalize", (req, res) => {
  const jid = normalizeToJid(req.query.number);
  res.json({ jid, valid: !!jid });
});

// GET /api/check-port
app.get("/api/check-port", (req, res) => {
  const port = parseInt(req.query.port);
  if (!port) return res.status(400).json({ error: "port required" });
  const net = require("net");
  const server = net.createServer();
  server.once("error", () => res.json({ available: false }));
  server.once("listening", () => {
    server.close();
    res.json({ available: true });
  });
  server.listen(port);
});

// ── Start manager ─────────────────────────────────────────────────────────────
if (!fs.existsSync(ACCOUNTS_DIR))
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

app.listen(7400, () => {
  console.log("Bailey Manager running on http://localhost:7400");
});
