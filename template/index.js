
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  getContentType,
} = require("@whiskeysockets/baileys");
const express = require("express");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(express.json());

const ACCOUNT_ID = process.env.ACCOUNT_ID || "default";
const PORT = parseInt(process.env.PORT || "3000");
const SYNC_SUPABASE = process.env.SYNC_SUPABASE === "true";

const supabase = SYNC_SUPABASE
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

let sock;
let currentQR = null;
let isConnected = false;

function extractText(msg) {
  const content = msg.message;
  if (!content) return "";
  const type = getContentType(content);
  switch (type) {
    case "conversation": return content.conversation;
    case "extendedTextMessage": return content.extendedTextMessage?.text || "";
    case "imageMessage": return content.imageMessage?.caption || "[Image]";
    case "videoMessage": return content.videoMessage?.caption || "[Video]";
    case "audioMessage": return "[Voice message]";
    case "documentMessage": return `[Document: ${content.documentMessage?.fileName || "file"}]`;
    case "stickerMessage": return "[Sticker]";
    case "locationMessage": return "[Location]";
    default: return `[${type}]`;
  }
}

async function upsertContact(jid, name, phone) {
  if (!supabase) return;
  await supabase.from("WAContacts").upsert(
    { jid, account_id: ACCOUNT_ID, name, phone, updated_at: new Date().toISOString() },
    { onConflict: "jid,account_id" },
  );
}

async function saveMessage(msg, jid, fromMe) {
  if (!supabase) return;
  const text = extractText(msg);
  const timestamp = msg.messageTimestamp
    ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString();
  if (!text) return;
  await supabase.from("WAMessages").upsert(
    { message_id: msg.key.id, account_id: ACCOUNT_ID, jid, from_me: fromMe, text, timestamp, read: fromMe, status: fromMe ? "2" : "1" },
    { onConflict: "message_id,account_id", ignoreDuplicates: false },
  );
  await supabase.from("WAContacts")
    .update({ last_message: text, last_message_at: timestamp })
    .eq("jid", jid).eq("account_id", ACCOUNT_ID);
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  sock = makeWASocket({
    auth: state,
    version: [2, 3000, 1033893291],
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    printQRInTerminal: true,
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { currentQR = qr; isConnected = false; }
    if (connection === "close") {
      isConnected = false; currentQR = null;
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
    } else if (connection === "open") {
      isConnected = true; currentQR = null;
      console.log(`[${ACCOUNT_ID}] Connected!`);
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJidAlt || msg.key.remoteJid;
      if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) continue;
      if (jid.includes("@lid")) continue;
      if (!jid.includes("@s.whatsapp.net")) continue;
      const fromMe = msg.key.fromMe || false;
      const phone = jid.replace("@s.whatsapp.net", "");
      const name = msg.pushName || phone;
      await upsertContact(jid, name, phone);
      await saveMessage(msg, jid, fromMe);
    }
  });
  sock.ev.on("messages.update", async (updates) => {
    if (!supabase) return;
    for (const update of updates) {
      console.log(`[MSG UPDATE] ${update.key.id} → ${JSON.stringify(update.update)}`);
      if (!update.update?.status) continue;
      await supabase.from("WAMessages")
        .update({ status: String(update.update.status) })
        .eq("message_id", update.key.id).eq("account_id", ACCOUNT_ID);
    }
  });
  sock.ev.on("message-receipt.update", async (updates) => {
    if (!supabase) return;
    for (const update of updates) {
      console.log(`[RECEIPT] ${update.key.id} → ${JSON.stringify(update.receipt)}`);
      const status = update.receipt.readTimestamp ? "4" : "3";
      await supabase.from("WAMessages")
        .update({ status })
        .eq("message_id", update.key.id).eq("account_id", ACCOUNT_ID);
    }
  });
}

app.get("/", async (req, res) => {
  if (isConnected) return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2 style="color:#16a34a">Connected — ${ACCOUNT_ID}</h2></body></html>`);
  if (!currentQR) return res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Waiting for QR...</h2></body></html>`);
  const qrImage = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
  res.send(`<html><head><meta http-equiv="refresh" content="30"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Scan with WhatsApp</h2><img src="${qrImage}"/></body></html>`);
});
app.get("/status", (req, res) => res.json({ connected: isConnected, account_id: ACCOUNT_ID, qr: !!currentQR }));
app.get("/qr", async (req, res) => {
  if (!currentQR) return res.json({ qr: null });
  res.json({ qr: await QRCode.toDataURL(currentQR) });
});
app.post("/read", async (req, res) => {
  try {
    const { jid, messageIds } = req.body;
    if (!jid || !messageIds?.length) return res.status(400).json({ error: "jid and messageIds required" });
    if (!isConnected) return res.status(503).json({ error: "Not connected" });
    await sock.readMessages(messageIds.map((id) => ({ remoteJid: jid, id, fromMe: false })));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/send", async (req, res) => {
  try {
    const { jid, text } = req.body;
    if (!jid || !text) return res.status(400).json({ error: "jid and text required" });
    if (!isConnected) return res.status(503).json({ error: "Not connected" });
    const sent = await sock.sendMessage(jid, { text });
    if (supabase) {
      await supabase.from("WAMessages").upsert(
        { message_id: sent.key.id, account_id: ACCOUNT_ID, jid, from_me: true, text, status: "2", timestamp: new Date().toISOString(), read: true },
        { onConflict: "message_id,account_id" },
      );
    }
    res.json({ success: true, messageId: sent.key.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`[${ACCOUNT_ID}] Running on port ${PORT}`);
  connectToWhatsApp();
});