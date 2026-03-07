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
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

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

const clients = {};
const sessionStatus = {};
const qrCodes = {};

function getSessionIds() {
  const configFile = path.join(SESSIONS_DIR, "sessions.json");
  if (!fs.existsSync(configFile)) return [];
  const data = JSON.parse(fs.readFileSync(configFile, "utf8"));
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

  // INCOMING MESSAGES
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;

    const jid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;

    let text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      "";

    try {
      await supabase.from("WAMessages").insert({
        message_id: msg.key.id,
        account_id: sessionId,
        jid: jid,
        from_me: fromMe,
        text: text,
        status: "received",
        read: fromMe,
        timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
      });

      await supabase.from("WAContacts").upsert(
        {
          account_id: sessionId,
          jid: jid,
          phone: jid.replace("@s.whatsapp.net", ""),
          last_message: text,
          last_message_at: new Date().toISOString(),
        },
        { onConflict: "account_id,jid" },
      );
    } catch (err) {
      console.error("Supabase insert error:", err);
    }
  });

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

        if (shouldReconnect) {
          setTimeout(() => startSession(sessionId), 5000);
        } else {
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

(async () => {
  const ids = getSessionIds();
  for (const s of ids) {
    await startSession(s.id);
  }
})();

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

app.post("/api/sessions", async (req, res) => {
  const { id, port } = req.body;

  const ids = getSessionIds();

  ids.push({ id, port: port || null });

  saveSessionIds(ids);

  await startSession(id);

  res.json({ ok: true });
});

app.post("/api/sessions/:id/send", async (req, res) => {
  const { id } = req.params;
  const { jid, message } = req.body;

  const number = jid ? jid.replace("@s.whatsapp.net", "") : req.body.number;

  if (!clients[id] || sessionStatus[id] !== "connected") {
    return res.status(400).json({ error: "Session not connected" });
  }

  try {
    const waJid = number.replace(/\D/g, "") + "@s.whatsapp.net";

    const result = await clients[id].sendMessage(waJid, { text: message });

    await supabase.from("WAMessages").insert({
      message_id: result.key.id,
      account_id: id,
      jid: waJid,
      from_me: true,
      text: message,
      status: "sent",
      read: true,
      timestamp: new Date().toISOString(),
    });

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
