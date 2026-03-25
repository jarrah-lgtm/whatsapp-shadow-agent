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
const logger = pino({ level: 'silent' });

let qrCodeData = null;
let isReady = false;
let sock = null;

// Simple HTTP server to serve QR code for scanning
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (isReady) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>✅ WhatsApp Connected!</h1><p>Shadow Agent is running.</p>');
    } else if (qrCodeData) {
      const qrImage = await qrcode.toDataURL(qrCodeData);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><meta http-equiv="refresh" content="15"></head>
          <body style="text-align:center;font-family:sans-serif;padding:40px">
            <h1>Scan this QR code with WhatsApp</h1>
            <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
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
            <h1>⏳ Starting up...</h1><p>Please wait, refreshing automatically...</p>
          </body>
        </html>
      `);
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: isReady }));
  } else if (req.url === '/reset' && req.method === 'POST') {
    // Emergency reset — clears session and restarts
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Session cleared. Restarting...' }));
      process.exit(0); // Railway will auto-restart
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
  console.log(`QR server running on port ${process.env.PORT || 3000}`);
});

// WhatsApp connection using Baileys
async function startWhatsApp() {
  // Ensure auth directory exists
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`Using WA version: ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Shadow Agent', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    qrTimeout: 60000,
  });

  // Handle QR code
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR code generated — visit /qr to scan');
      qrCodeData = qr;
      isReady = false;
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      isReady = true;
      qrCodeData = null;
      sendTelegram('✅ *Shadow Agent — WhatsApp Connected*\n\nYour WhatsApp monitor is live. I\'ll ping you when messages need action.');
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;

      console.log(`WhatsApp disconnected. Status: ${statusCode}`);

      if (statusCode === reason.loggedOut) {
        // Session expired — clear and start fresh
        console.log('Logged out — clearing session for fresh QR');
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        sendTelegram('⚠️ *Shadow Agent — WhatsApp Logged Out*\n\nPlease scan the QR code again to reconnect.');
        setTimeout(startWhatsApp, 3000);
      } else {
        // Temporary disconnect — try reconnecting
        console.log('Reconnecting in 5 seconds...');
        setTimeout(startWhatsApp, 5000);
      }
    }
  });

  // Save credentials when updated
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip status broadcasts, own messages, and protocol messages
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

      // Debounce — process after 30 seconds of no new messages
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(processBatch, 30000);
    }
  });
}

// Batch messages to avoid spamming Claude on every single message
const messageBatch = [];
let batchTimer = null;

async function processBatch() {
  if (messageBatch.length === 0) return;

  const messages = [...messageBatch];
  messageBatch.length = 0;
  batchTimer = null;

  console.log(`Processing batch of ${messages.length} messages`);

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
      await sendTelegram(`📱 *WhatsApp — Action Needed*\n\n${summary}`);
    }
  } catch (err) {
    console.error('Error processing batch:', err.message);
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
    console.error('Telegram error:', err.message);
  }
}

console.log('Starting WhatsApp Shadow Agent (Baileys)...');
startWhatsApp();
