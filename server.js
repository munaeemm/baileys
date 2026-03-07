//server.js
const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const basicAuth = require("express-basic-auth");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

// Basic auth
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
  app.use(
    basicAuth({
      users: { [process.env.AUTH_USER]: process.env.AUTH_PASS },
      challenge: true,
    }),
  );
}

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = "./sessions";

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// In-memory store of active sockets
const clients = {}; // { sessionId: waSocket }
const sessionStatus = {}; // { sessionId: 'connected' | 'qr' | 'disconnected' }
const qrCodes = {}; // { sessionId: base64QR }

function getSessionIds() {
  const configFile = path.join(SESSIONS_DIR, "sessions.json");
  if (!fs.existsSync(configFile)) return [];
  const data = JSON.parse(fs.readFileSync(configFile, "utf8"));
  // migrate old string format
  return data.map((s) => (typeof s === "string" ? { id: s, port: null } : s));
}

function saveSessionIds(ids) {
  fs.writeFileSync(
    path.join(SESSIONS_DIR, "sessions.json"),
    JSON.stringify(ids),
  );
}

async function startSession(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionPath))
    fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require("pino")({ level: "silent" }),
  });

  clients[sessionId] = sock;
  sessionStatus[sessionId] = "connecting";
  io.emit("status", { sessionId, status: "connecting" });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on(
    "connection.update",
    async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const qrBase64 = await QRCode.toDataURL(qr);
        qrCodes[sessionId] = qrBase64;
        sessionStatus[sessionId] = "qr";
        io.emit("qr", { sessionId, qr: qrBase64 });
        io.emit("status", { sessionId, status: "qr" });
      }

      if (connection === "open") {
        sessionStatus[sessionId] = "connected";
        qrCodes[sessionId] = null;
        io.emit("status", { sessionId, status: "connected" });
        console.log(`[${sessionId}] Connected`);
      }

      if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        sessionStatus[sessionId] = shouldReconnect
          ? "reconnecting"
          : "logged_out";
        io.emit("status", { sessionId, status: sessionStatus[sessionId] });
        console.log(
          `[${sessionId}] Disconnected. Reason: ${reason}. Reconnecting: ${shouldReconnect}`,
        );

        if (shouldReconnect) {
          setTimeout(() => startSession(sessionId), 5000);
        } else {
          // Logged out - clear session files
          fs.rmSync(path.join(SESSIONS_DIR, sessionId), {
            recursive: true,
            force: true,
          });
          delete clients[sessionId];
        }
      }
    },
  );
}

// Start all saved sessions on boot
(async () => {
  const ids = getSessionIds();
  for (const s of ids) {
    await startSession(s.id);
  }
})();

// --- API ---

// Get all sessions
app.get("/api/sessions", (req, res) => {
  const ids = getSessionIds();
  const data = ids.map((s) => ({
    id: s.id,
    port: s.port,
    status: sessionStatus[s.id] || "stopped",
    qr: qrCodes[s.id] || null,
  }));
  res.json(data);
});

// Add new session
app.post("/api/sessions", async (req, res) => {
  const { id, port } = req.body;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id))
    return res.status(400).json({ error: "Invalid session ID" });
  const ids = getSessionIds();
  if (ids.find((s) => s.id === id))
    return res.status(400).json({ error: "Session already exists" });
  ids.push({ id, port: port || null });
  saveSessionIds(ids);
  await startSession(id);
  res.json({ ok: true });
});

// Delete session
app.delete("/api/sessions/:id", (req, res) => {
  const { id } = req.params;
  const ids = getSessionIds().filter((s) => s.id !== id);
  saveSessionIds(ids);
  if (clients[id]) {
    clients[id].end();
    delete clients[id];
  }
  delete sessionStatus[id];
  delete qrCodes[id];
  const sessionPath = path.join(SESSIONS_DIR, id);
  if (fs.existsSync(sessionPath))
    fs.rmSync(sessionPath, { recursive: true, force: true });
  res.json({ ok: true });
});

// Restart session
app.post("/api/sessions/:id/restart", async (req, res) => {
  const { id } = req.params;
  if (clients[id]) {
    try {
      clients[id].end();
    } catch {}
    delete clients[id];
  }
  await startSession(id);
  res.json({ ok: true });
});

// Send message
app.post("/api/sessions/:id/send", async (req, res) => {
  const { id } = req.params;
  const { jid, message } = req.body;
  const number = jid ? jid.replace("@s.whatsapp.net", "") : req.body.number;
  if (!clients[id] || sessionStatus[id] !== "connected") {
    return res.status(400).json({ error: "Session not connected" });
  }
  try {
    const waJid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    await clients[id].sendMessage(waJid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/status", (req, res) => {
  const accountId = req.query.accountId;
  if (accountId) {
    return res.json({
      connected: sessionStatus[accountId] === "connected",
      qr: qrCodes[accountId] || null,
    });
  }
  res.json({
    ok: true,
    connected: Object.values(sessionStatus).some((s) => s === "connected"),
  });
});

server.listen(PORT, () =>
  console.log(`Baileys Manager running on port ${PORT}`),
);
