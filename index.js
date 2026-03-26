const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// ─── Config ────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AUTH_DIR = '/data/baileys_auth';
const APPROVALS_FILE = '/data/pending_approvals.json';
const TRAINING_FILE = '/data/training_log.jsonl';
const ASSISTANT_GROUP_FILE = '/data/assistant_group.json';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const logger = pino({ level: 'warn' });

// ─── Logging ───────────────────────────────────────────
const recentLogs = [];
function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  recentLogs.push(entry);
  if (recentLogs.length > 200) recentLogs.shift();
}

// ─── State ─────────────────────────────────────────────
let qrCodeData = null;
let isReady = false;
let sock = null;
let myJid = null;
let assistantGroupJid = null;

// ─── Approval Storage ──────────────────────────────────
function loadApprovals() {
  try {
    if (fs.existsSync(APPROVALS_FILE)) return JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveApprovals(data) {
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(data, null, 2));
}

function nextApprovalId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 3; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function createApproval(from, fromJid, originalMsg, draftReply, isGroup, groupName) {
  const approvals = loadApprovals();
  const id = nextApprovalId();
  approvals[id] = {
    id,
    created: new Date().toISOString(),
    from,
    fromJid,
    originalMsg,
    draftReply,
    isGroup,
    groupName,
    status: 'pending'
  };
  // Clean expired (older than 12 hours)
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [key, val] of Object.entries(approvals)) {
    if (new Date(val.created).getTime() < cutoff) delete approvals[key];
  }
  saveApprovals(approvals);
  return id;
}

function getLatestPending() {
  const approvals = loadApprovals();
  let latest = null;
  for (const a of Object.values(approvals)) {
    if (a.status === 'pending') {
      if (!latest || new Date(a.created) > new Date(latest.created)) latest = a;
    }
  }
  return latest;
}

function getPendingById(id) {
  const approvals = loadApprovals();
  return approvals[id] || null;
}

function resolveApproval(id, action, finalReply) {
  const approvals = loadApprovals();
  if (!approvals[id]) return null;
  approvals[id].status = action;
  approvals[id].finalReply = finalReply;
  approvals[id].resolved = new Date().toISOString();
  saveApprovals(approvals);
  // Log training data
  logTraining(approvals[id]);
  return approvals[id];
}

function logTraining(approval) {
  const entry = {
    id: approval.id,
    timestamp: new Date().toISOString(),
    from: approval.from,
    original: approval.originalMsg,
    draft: approval.draftReply,
    action: approval.status,
    finalReply: approval.finalReply || null
  };
  fs.appendFileSync(TRAINING_FILE, JSON.stringify(entry) + '\n');
}

// ─── Training Examples ─────────────────────────────────
function getTrainingExamples(maxExamples = 8) {
  try {
    if (!fs.existsSync(TRAINING_FILE)) return '';
    const lines = fs.readFileSync(TRAINING_FILE, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return '';

    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Prioritise edits (most valuable), then recent approvals
    const edits = entries.filter(e => e.action === 'edited').slice(-5);
    const approved = entries.filter(e => e.action === 'approved').slice(-5);
    const examples = [...edits, ...approved].slice(-maxExamples);

    if (examples.length === 0) return '';

    let text = '\nHere are examples of how Jarrah actually replies:\n\n';
    for (const ex of examples) {
      text += `Message from ${ex.from}: "${ex.original}"\n`;
      if (ex.action === 'edited') {
        text += `AI draft: "${ex.draft}"\n`;
        text += `Jarrah changed it to: "${ex.finalReply}"\n\n`;
      } else {
        text += `Jarrah approved this reply: "${ex.finalReply}"\n\n`;
      }
    }
    return text;
  } catch (err) {
    log(`Error loading training examples: ${err.message}`);
    return '';
  }
}

// ─── Draft Generation ──────────────────────────────────
async function draftReply(from, message, isGroup, groupName) {
  const examples = getTrainingExamples();
  const context = isGroup ? ` (in group: ${groupName})` : '';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `You are drafting WhatsApp replies on behalf of Jarrah Martin.

Jarrah runs three businesses:
- PEC (Performance Evolution Coaching) — fitness coaching for women 40-60
- TSS (The Sovereign Standard) — helps fitness coaches scale to $50k/month+
- APAW (Apex Property And Wealth) — strategic property ownership

His WhatsApp messages are mostly from sales reps and team members.

Jarrah's tone: direct, casual, strategic. Like a business partner. No fluff, no corporate speak. Short messages. Uses words like "cheers", "nice one", "no worries", "mate". Thinks in systems and outcomes.
${examples}
Now draft a reply to this message:
From: ${from}${context}
Message: ${message}

Rules:
- Keep it short (1-3 sentences max)
- Match Jarrah's casual but direct tone
- If the message is just an update with no question, a brief acknowledgement is fine
- If it needs a decision you're not sure about, say NEEDS_JARRAH instead of guessing

Reply with ONLY the draft text, nothing else.`
    }]
  });

  return response.content[0].text.trim();
}

// ─── Assistant Group ───────────────────────────────────
async function getOrCreateAssistantGroup() {
  // Check if we already have a saved group JID
  try {
    if (fs.existsSync(ASSISTANT_GROUP_FILE)) {
      const data = JSON.parse(fs.readFileSync(ASSISTANT_GROUP_FILE, 'utf8'));
      if (data.groupJid) {
        // Verify group still exists
        try {
          await sock.groupMetadata(data.groupJid);
          log(`Using existing assistant group: ${data.groupJid}`);
          return data.groupJid;
        } catch {
          log('Saved assistant group no longer valid, creating new one');
        }
      }
    }
  } catch {}

  // Create new group
  log('Creating AI Assistant group...');
  const group = await sock.groupCreate('AI Assistant', []);
  const groupJid = group.id;
  fs.writeFileSync(ASSISTANT_GROUP_FILE, JSON.stringify({ groupJid }));
  log(`Created assistant group: ${groupJid}`);

  // Send welcome message
  await sleep(1000);
  await sock.sendMessage(groupJid, {
    text: `*AI Assistant is ready*\n\nI'll send you draft replies here for approval.\n\nReply *ok* to send a draft as-is\nReply *skip* to ignore\nOr type your own version to send that instead`
  });

  return groupJid;
}

// ─── Send Approval Request ─────────────────────────────
async function sendApprovalRequest(approvalId, from, originalMsg, draftReply, isGroup, groupName) {
  if (!assistantGroupJid) {
    log('No assistant group — falling back to Telegram');
    await sendTelegram(`*Draft Reply Needed*\n\nFrom: ${from}\nMessage: ${originalMsg}\n\nDraft: ${draftReply}\n\n(Approve in AI Assistant WhatsApp group)`);
    return;
  }

  const source = isGroup ? `${from} (${groupName})` : from;

  const text = `*#${approvalId}* | ${source}\n\n` +
    `> ${originalMsg}\n\n` +
    `*Draft:*\n${draftReply}\n\n` +
    `Reply *ok* to send | Type your version | *skip* to ignore`;

  await sock.sendMessage(assistantGroupJid, { text });
  log(`Sent approval request #${approvalId} to assistant group`);
}

// ─── Chat Conversation ─────────────────────────────────
const CHAT_HISTORY_FILE = '/data/chat_history.json';

function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
      // Keep last 20 messages for context
      return history.slice(-20);
    }
  } catch {}
  return [];
}

function saveChatHistory(history) {
  // Only keep last 50 messages on disk
  fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(history.slice(-50), null, 2));
}

async function chatWithAI(message) {
  const history = loadChatHistory();

  // Add Jarrah's message
  history.push({ role: 'user', content: message });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 1000,
    system: `You are Jarrah Martin's AI business assistant on WhatsApp.

Jarrah runs three businesses:
- PEC (Performance Evolution Coaching) — fitness coaching for women 40-60, helps them lose fat sustainably
- TSS (The Sovereign Standard) — helps fitness coaches stuck at $10-20k/month scale to $50k/month+ by shifting from freelancer to entrepreneur. This is his main focus.
- APAW (Apex Property And Wealth) — helps people build long-term financial safety through strategic property ownership

Key context:
- PEC is also his proving ground — he systemises it so he can hand the blueprint to TSS clients
- His team includes sales reps, VAs, coaches
- He uses Go High Level, Stripe, Google Sheets, Notion, Slack, Xero, Instagram, Facebook
- He's based in Australia

Communication style: Direct, strategic, like a business partner. Keep it casual but smart. No fluff. Short messages — this is WhatsApp, not email. Use plain language.

You can help with:
- Business strategy, planning, decisions
- Drafting messages, emails, content
- Analysing ideas, offers, pricing
- Research and competitor analysis
- Task planning and prioritisation
- Anything else he asks

If you don't know something specific about his business, ask him rather than guessing.`,
    messages: history.slice(-20) // Send last 20 messages for context
  });

  const reply = response.content[0].text;

  // Add AI response to history
  history.push({ role: 'assistant', content: reply });
  saveChatHistory(history);

  return reply;
}

// ─── Handle Messages in Assistant Group ────────────────
async function handleAssistantGroupMessage(body) {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();

  // Check if it targets a specific approval by ID
  const idMatch = trimmed.match(/^#([A-Z0-9]{3})\s+([\s\S]+)/i);
  if (idMatch) {
    const approval = getPendingById(idMatch[1].toUpperCase());
    if (approval) {
      await handleApprovalAction(approval, idMatch[2].trim());
      return;
    }
  }

  // Check if there's a pending approval and this is a quick action
  const pending = getLatestPending();
  const isApprovalAction = pending && (
    lower === 'ok' || lower === 'yes' || lower === 'send' || lower === 'yep' || lower === 'approved' ||
    lower === 'skip' || lower === 'nah' || lower === "i'll handle it" || lower === 'ill handle it' || lower === 'ignore'
  );

  if (isApprovalAction) {
    await handleApprovalAction(pending, trimmed);
    return;
  }

  // If there's a pending approval and the message doesn't look like a chat question,
  // treat it as an edited reply
  if (pending && !trimmed.endsWith('?') && !lower.startsWith('hey') && !lower.startsWith('can you') && !lower.startsWith('what') && !lower.startsWith('how') && !lower.startsWith('why') && !lower.startsWith('when') && !lower.startsWith('where') && !lower.startsWith('who') && !lower.startsWith('do you') && !lower.startsWith('tell me') && !lower.startsWith('help') && trimmed.length < 200) {
    await handleApprovalAction(pending, trimmed);
    return;
  }

  // Otherwise — it's a chat message for the AI
  log(`Chat message from Jarrah: ${trimmed.substring(0, 80)}`);
  try {
    const reply = await chatWithAI(trimmed);
    await sock.sendMessage(assistantGroupJid, { text: reply });
    log('Sent chat reply');
  } catch (err) {
    log(`Chat error: ${err.message}`);
    await sock.sendMessage(assistantGroupJid, { text: 'Sorry, had a hiccup. Try again.' });
  }
}

async function handleApprovalAction(approval, responseText) {
  const lower = responseText.toLowerCase();

  if (lower === 'ok' || lower === 'yes' || lower === 'send' || lower === 'yep' || lower === 'approved') {
    resolveApproval(approval.id, 'approved', approval.draftReply);
    await sock.sendMessage(approval.fromJid, { text: approval.draftReply });
    await sleep(500);
    await sock.sendMessage(assistantGroupJid, { text: `Sent #${approval.id} to ${approval.from}` });
    log(`Approval #${approval.id}: sent draft to ${approval.from}`);

  } else if (lower === 'skip' || lower === 'nah' || lower === "i'll handle it" || lower === 'ill handle it' || lower === 'ignore') {
    resolveApproval(approval.id, 'skipped', null);
    await sock.sendMessage(assistantGroupJid, { text: `Skipped #${approval.id}` });
    log(`Approval #${approval.id}: skipped`);

  } else {
    resolveApproval(approval.id, 'edited', responseText);
    await sock.sendMessage(approval.fromJid, { text: responseText });
    await sleep(500);
    await sock.sendMessage(assistantGroupJid, { text: `Sent your version for #${approval.id} to ${approval.from}` });
    log(`Approval #${approval.id}: sent Jarrah's edited version to ${approval.from}`);
  }
}

// ─── Utilities ─────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ─── HTTP Server ───────────────────────────────────────
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
      res.end('<html><head><meta http-equiv="refresh" content="5"></head><body style="text-align:center;font-family:sans-serif;padding:40px"><h1>Starting up...</h1></body></html>');
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: isReady, assistantGroup: !!assistantGroupJid }));
  } else if (req.url === '/logs') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(recentLogs.join('\n') || 'No logs yet');
  } else if (req.url === '/approvals') {
    const approvals = loadApprovals();
    const training = fs.existsSync(TRAINING_FILE) ? fs.readFileSync(TRAINING_FILE, 'utf8').trim().split('\n').length : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending: approvals, trainingEntries: training }, null, 2));
  } else if (req.url === '/reset') {
    try {
      if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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
  log(`Server running on port ${process.env.PORT || 3000}`);
});

// ─── WhatsApp Connection ───────────────────────────────
async function startWhatsApp() {
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
    emitOwnEvents: true,
    markOnlineOnConnect: false,
  });

  sock.ev.on('connection.update', async (update) => {
    log(`Connection update: ${JSON.stringify(update)}`);
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('New QR code generated');
      qrCodeData = qr;
      isReady = false;
    }

    if (connection === 'open') {
      log('WhatsApp connected!');
      isReady = true;
      qrCodeData = null;
      myJid = sock.user?.id;
      log(`My JID: ${myJid}`);

      // Set up assistant group
      try {
        assistantGroupJid = await getOrCreateAssistantGroup();
        log(`Assistant group ready: ${assistantGroupJid}`);
      } catch (err) {
        log(`Failed to set up assistant group: ${err.message}`);
      }

      sendTelegram('*Shadow Agent v2 — Connected*\n\nNow drafting replies for your approval.');
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      log(`Disconnected. Status: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut) {
        log('Logged out — clearing session');
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        sendTelegram('*Shadow Agent — Logged Out*\n\nPlease scan QR again.');
        setTimeout(startWhatsApp, 3000);
      } else if (statusCode === 515 || statusCode === 503) {
        setTimeout(startWhatsApp, 30000);
      } else {
        setTimeout(startWhatsApp, 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── Message Handler ───────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (!msg.message) continue;

      const body = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || msg.message.videoMessage?.caption
        || '';

      if (!body) continue;

      const isFromMe = msg.key.fromMe;
      const isGroup = msg.key.remoteJid.endsWith('@g.us');
      const isAssistantGroup = msg.key.remoteJid === assistantGroupJid;

      // ── Jarrah's messages in the AI Assistant group ──
      if (isAssistantGroup && isFromMe) {
        try {
          await handleAssistantGroupMessage(body);
        } catch (err) {
          log(`Error handling assistant group message: ${err.message}`);
        }
        continue;
      }

      // Skip own messages and assistant group messages
      if (isFromMe) continue;
      if (isAssistantGroup) continue;

      // ── Incoming message from someone else ──
      const from = msg.pushName || msg.key.participant || msg.key.remoteJid;

      let groupName = null;
      if (isGroup) {
        try {
          const metadata = await sock.groupMetadata(msg.key.remoteJid);
          groupName = metadata.subject;
        } catch { groupName = 'Unknown Group'; }
      }

      log(`Message from ${from}${isGroup ? ` (${groupName})` : ''}: ${body.substring(0, 80)}`);

      // Draft a reply and send for approval
      try {
        const draft = await draftReply(from, body, isGroup, groupName);

        if (draft === 'NEEDS_JARRAH' || draft.includes('NEEDS_JARRAH')) {
          // AI is not confident — just flag it, no draft
          const source = isGroup ? `${from} (${groupName})` : from;
          if (assistantGroupJid) {
            await sock.sendMessage(assistantGroupJid, {
              text: `*Needs your attention*\n\nFrom: ${source}\n> ${body}\n\n_AI wasn't sure how to reply — handle this one yourself_`
            });
          }
          log(`Message from ${from}: flagged as NEEDS_JARRAH`);
        } else {
          // Create approval and send to assistant group
          const approvalId = createApproval(from, msg.key.remoteJid, body, draft, isGroup, groupName);
          await sleep(1000);
          await sendApprovalRequest(approvalId, from, body, draft, isGroup, groupName);
        }
      } catch (err) {
        log(`Error drafting reply for ${from}: ${err.message}`);
        // Fall back to simple notification
        await sendTelegram(`*WhatsApp message from ${from}*\n\n${body.substring(0, 200)}`);
      }
    }
  });
}

log('Starting WhatsApp Shadow Agent v2 (with approval flow)...');
startWhatsApp().catch(err => log(`Startup error: ${err.message}`));
