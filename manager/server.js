const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

// ── Load env ──────────────────────────────────────────────────────────────────
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT        = parseInt(process.env.PORT || '3000');
const ACCOUNT_ID  = process.env.ACCOUNT_ID || 'default';
const SYNC_SUPABASE = process.env.SYNC_SUPABASE === 'true';
const SUPABASE_URL  = process.env.SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || '';
const MANAGER_URL   = process.env.MANAGER_URL || 'http://localhost:7400';

// ── Supabase ──────────────────────────────────────────────────────────────────
let supabase = null;
if (SYNC_SUPABASE && SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log(`[${ACCOUNT_ID}] Supabase sync enabled`);
}

// ── Express for QR + status + send ───────────────────────────────────────────
const app = express();
app.use(express.json());

let currentQR = null;
let sock = null;
let isConnected = false;
let phoneNumber = null;

app.get('/status', (req, res) => {
  res.json({ connected: isConnected, account_id: ACCOUNT_ID, phone: phoneNumber, qr: !!currentQR });
});

app.get('/qr', async (req, res) => {
  if (!currentQR) return res.json({ qr: null });
  try {
    const img = await qrcode.toDataURL(currentQR);
    res.json({ qr: img });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send', async (req, res) => {
  if (!isConnected || !sock) return res.status(503).json({ error: 'Not connected' });
  const { jid, text } = req.body;
  if (!jid || !text) return res.status(400).json({ error: 'jid and text required' });
  try {
    await sock.sendMessage(jid, { text });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`[${ACCOUNT_ID}] HTTP on :${PORT}`));

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractJidPhone(jid) {
  return jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
}

function tsToISO(ts) {
  if (!ts) return null;
  const n = typeof ts === 'object' ? Number(ts.low || ts) : Number(ts);
  return new Date(n * 1000).toISOString();
}

async function upsertContact(jid, name, lastMsg, lastMsgAt) {
  if (!supabase) return;
  const phone = extractJidPhone(jid);
  await supabase.from('WAContacts').upsert({
    jid,
    account_id: ACCOUNT_ID,
    name: name || phone,
    phone,
    last_message: lastMsg || null,
    last_message_at: lastMsgAt || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'jid,account_id' });
}

async function upsertMessage(msg) {
  if (!supabase) return;
  const key = msg.key;
  const jid = key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;

  const msgId    = key.id;
  const fromMe   = key.fromMe || false;
  const ts       = msg.messageTimestamp;
  const isoTs    = tsToISO(ts);
  const content  = msg.message;

  let text = null;
  let mediaType = null;
  let mediaUrl = null;

  if (content?.conversation) {
    text = content.conversation;
  } else if (content?.extendedTextMessage?.text) {
    text = content.extendedTextMessage.text;
  } else if (content?.imageMessage) {
    mediaType = 'image';
    text = content.imageMessage.caption || null;
  } else if (content?.videoMessage) {
    mediaType = 'video';
    text = content.videoMessage.caption || null;
  } else if (content?.audioMessage) {
    mediaType = 'audio';
  } else if (content?.documentMessage) {
    mediaType = 'document';
    text = content.documentMessage.title || null;
  } else if (content?.stickerMessage) {
    mediaType = 'sticker';
  }

  await supabase.from('WAMessages').upsert({
    message_id: msgId,
    account_id: ACCOUNT_ID,
    jid,
    from_me: fromMe,
    text,
    read: fromMe,
    timestamp: isoTs,
    media_type: mediaType || null,
    media_url: mediaUrl || null,
  }, { onConflict: 'message_id,account_id' });

  // Update contact last message
  if (!fromMe && text) {
    const pushName = msg.pushName || null;
    await upsertContact(jid, pushName, text, isoTs);
  }
}

async function registerAccount() {
  if (!supabase) return;
  const serverUrl = `http://localhost:${PORT}`;
  await supabase.from('WAAccounts').upsert({
    account_id: ACCOUNT_ID,
    name: ACCOUNT_ID,
    server_url: serverUrl,
    active: true,
  }, { onConflict: 'account_id' });
}

// ── Main Baileys connect ──────────────────────────────────────────────────────
async function connectToWhatsApp() {
  const authDir = path.join(__dirname, 'auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log(`[${ACCOUNT_ID}] QR ready — scan at http://localhost:${PORT}/qr`);
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      phoneNumber = sock.user?.id?.split(':')[0] || null;
      console.log(`[${ACCOUNT_ID}] Connected as ${phoneNumber}`);
      await registerAccount();
    }

    if (connection === 'close') {
      isConnected = false;
      phoneNumber = null;
      const code = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[${ACCOUNT_ID}] Disconnected (${code}) — reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        // Logged out — clear auth
        fs.rmSync(authDir, { recursive: true, force: true });
        setTimeout(connectToWhatsApp, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!SYNC_SUPABASE || !supabase) return;
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      try {
        await upsertMessage(msg);
      } catch (e) {
        console.error(`[${ACCOUNT_ID}] Supabase upsert error:`, e.message);
      }
    }
  });

  sock.ev.on('contacts.update', async (contacts) => {
    if (!SYNC_SUPABASE || !supabase) return;
    for (const c of contacts) {
      if (c.id && c.notify) {
        await upsertContact(c.id, c.notify, null, null).catch(() => {});
      }
    }
  });
}

connectToWhatsApp();