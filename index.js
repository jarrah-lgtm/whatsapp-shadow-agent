const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

let qrCodeData = null;
let isReady = false;

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
      res.end('<h1>⏳ Starting up...</h1><p>Please refresh in a few seconds.</p>');
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: isReady }));
  } else {
    res.writeHead(302, { Location: '/qr' });
    res.end();
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`QR server running on port ${process.env.PORT || 3000}`);
});

// WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/data/wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

client.on('qr', (qr) => {
  console.log('QR code generated — visit /qr to scan');
  qrCodeData = qr;
  isReady = false;
});

client.on('ready', () => {
  console.log('✅ WhatsApp client ready!');
  isReady = true;
  qrCodeData = null;
  sendTelegram('✅ *Shadow Agent — WhatsApp Connected*\n\nYour WhatsApp monitor is live. I\'ll ping you when messages need action.');
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp disconnected:', reason);
  isReady = false;
  sendTelegram('⚠️ *Shadow Agent — WhatsApp Disconnected*\n\nReason: ' + reason + '\n\nReconnecting...');
});

// Batch messages to avoid spamming Claude on every single message
const messageBatch = [];
let batchTimer = null;

client.on('message', async (msg) => {
  // Skip status updates and very old messages
  if (msg.isStatus || msg.type === 'e2e_notification') return;

  const contact = await msg.getContact();
  const chat = await msg.getChat();

  messageBatch.push({
    from: contact.pushname || contact.name || msg.from,
    number: msg.from,
    body: msg.body,
    isGroup: chat.isGroup,
    groupName: chat.isGroup ? chat.name : null,
    timestamp: new Date(msg.timestamp * 1000).toISOString()
  });

  // Debounce — process after 30 seconds of no new messages
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(processBatch, 30000);
});

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

console.log('Starting WhatsApp Shadow Agent...');
client.initialize();
