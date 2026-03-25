const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AUTH_DIR = '/data/baileys_auth';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Capture logs so we can show them on /logs
const recentLogs = [];
function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  recentLogs.push(entry);
  if (recentLogs.length > 100) recentLogs.shift();
}

// Use warn level so we can see Baileys connection errors
const logger = pino({ level: 'warn' });

let qrCodeData = null;
let isReady = false;
let sock = null;

// Simple HTTP server
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (isReady) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>WhatsApp Connected!</h1><p>Shadow Agent is running.</p>');
    } else if (qrCodeData) {
      const qrImage = await qrcode.toDataURL(qrCodeData);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><meta http-equiv="refresh" content="15"></head>
          <body style="text-align:center;font-family:sans-serif;padding:40px">
            <h1>Scan this QR code with WhatsApp</h1>
            <p>Open WhatsApp > Settings > Linked Devices > Link a Device</p>
            <img src="${qrImage}" style="width:300px;height:300px" />
            <p style="color:grey;font-size:14px">This page refreshes automatically every 15 seconds</p>
          </body>
        </html>
      `);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><meta http-equiv="refresh" content="5"></head>
          <body style="text-align:center;font-family:sans-serif;padding:40px">
            <h1>Starting up...</h1><p>Please wait, refreshing automatically...</p>
          </body>
        </html>
      `);
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: isReady }));
  } else if (req.url === '/logs') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(recentLogs.join('\n') || 'No logs yet');
  } else if (req.url === '/reset') {
    // Clear session and restart
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Session cleared. Restarting...' }));
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  } else {
    res.writeHead(302, { Location: '/qr' });
    res.end();
  }
});

server.listen(process.env.PORT || 3000, () => {
  log(`QR server running on port ${process.env.PORT || 3000}`);
});

// WhatsApp connection using Baileys
async function startWhatsApp() {
  // Clear any old auth that might be corrupted
  if (fs.existsSync(AUTH_DIR)) {
    const files = fs.readdirSync(AUTH_DIR);
    log(`Auth dir has ${files.length} files`);
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  log(`Using WA version: ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.6099.109'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    emitOwnEvents: false,
    markOnlineOnConnect: false,
  });

  // Handle connection events
  sock.ev.on('connection.update', async (update) => {
    log(`Connection update: ${JSON.stringify(update)}`);
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('New QR code generated');
      qrCodeData = qr;
      isReady = false;
    }

    if (connection === 'open') {
      log('WhatsApp connected successfully!');
      isReady = true;
      qrCodeData = null;
      sendTelegram('*Shadow Agent — WhatsApp Connected*\n\nYour WhatsApp monitor is live.');
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || 'unknown';

      log(`Disconnected. Status: ${statusCode}, Error: ${errorMsg}`);

      if (statusCode === DisconnectReason.loggedOut) {
        log('Logged out — clearing session');
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        sendTelegram('*Shadow Agent — WhatsApp Logged Out*\n\nPlease scan the QR code again.');
        setTimeout(startWhatsApp, 3000);
      } else if (statusCode === 515 || statusCode === 503) {
        log('Server error from WhatsApp — waiting 30s before retry');
        setTimeout(startWhatsApp, 30000);
      } else {
        log('Reconnecting in 5 seconds...');
        setTimeout(startWhatsApp, 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const body = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || msg.message.videoMessage?.caption
        || '';

      if (!body) continue;

      const isGroup = msg.key.remoteJid.endsWith('@g.us');
      const from = msg.pushName || msg.key.participant || msg.key.remoteJid;

      let groupName = null;
      if (isGroup) {
        try {
          const metadata = await sock.groupMetadata(msg.key.remoteJid);
          groupName = metadata.subject;
        } catch { groupName = 'Unknown Group'; }
      }

      messageBatch.push({
        from,
        number: msg.key.remoteJid,
        body,
        isGroup,
        groupName,
        timestamp: new Date((msg.messageTimestamp || 0) * 1000).toISOString()
      });

      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(processBatch, 30000);
    }
  });
}

const messageBatch = [];
let batchTimer = null;

async function processBatch() {
  if (messageBatch.length === 0) return;

  const messages = [...messageBatch];
  messageBatch.length = 0;
  batchTimer = null;

  log(`Processing batch of ${messages.length} messages`);

  try {
    const messageText = messages.map(m => {
      const source = m.isGroup ? `[Group: ${m.groupName}] ${m.from}` : m.from;
      return `FROM: ${source}\nMESSAGE: ${m.body}\nTIME: ${m.timestamp}`;
    }).join('\n\n---\n\n');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a shadow agent monitoring WhatsApp messages for Jarrah Martin, a fitness business owner (PEC, TSS, APAW).

Review these recent WhatsApp messages and decide if any need action.

MESSAGES:
${messageText}

Respond in this exact format:
ACTION_NEEDED: yes/no
SUMMARY: (if yes, 2-3 bullet points of what needs action and from who — be specific and brief)

Only flag things that genuinely need a response or action: client questions, business enquiries, urgent matters, bookings, payments, complaints. Ignore casual chit-chat, spam, and automated messages.`
      }]
    });

    const text = response.content[0].text;
    const needsAction = text.includes('ACTION_NEEDED: yes');

    if (needsAction) {
      const summaryMatch = text.match(/SUMMARY:([\s\S]+)/);
      const summary = summaryMatch ? summaryMatch[1].trim() : 'Check WhatsApp for recent messages.';
      await sendTelegram(`*WhatsApp — Action Needed*\n\n${summary}`);
    }
  } catch (err) {
    log(`Error processing batch: ${err.message}`);
  }
}

async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    log(`Telegram error: ${err.message}`);
  }
}

log('Starting WhatsApp Shadow Agent (Baileys v6.7.21)...');
startWhatsApp().catch(err => log(`Startup error: ${err.message}`));
