import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ─── SQLite Setup ─────────────────────────────────────────────────────────────
const db = new Database(path.join(process.cwd(), 'orders.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS pinned_orders (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    username    TEXT,
    code        TEXT,
    amount      INTEGER,
    raw_text    TEXT,
    pinned_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS dp_records (
    username    TEXT PRIMARY KEY,
    amount      INTEGER,
    updated_at  TEXT
  );
`);

console.log('SQLite database ready → orders.db');

const app = express();
app.use(cors());
app.use(express.json());

// Track active TikTok live session in memory
let currentLiveSeller = null; // string e.g. "pawfit.closet"
let currentLiveStatus = 'offline'; // 'offline' | 'connecting' | 'connected'
let recentComments = []; // buffer of recent comments for instant sync on new device connect

// REST endpoint — fetch all saved pinned orders
app.get('/api/pinned-orders', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM pinned_orders ORDER BY pinned_at ASC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST endpoint — fetch all DP records
app.get('/api/dp-records', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM dp_records').all();
    const map = {};
    rows.forEach(r => { map[r.username] = r.amount; });
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST endpoint — save DP record
app.post('/api/dp-records', (req, res) => {
  const { username, amount } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  try {
    db.prepare(`
      INSERT INTO dp_records (username, amount, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
    `).run(username, amount || 0, new Date().toISOString());

    // Broadcast DP update to all connected devices in realtime
    io.emit('dp-updated', { username, amount: amount || 0 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST endpoint — delete a pinned order by id
app.delete('/api/pinned-orders/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM pinned_orders WHERE id = ?').run(req.params.id);
    io.emit('order-cancelled', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ─── Google OAuth2 Setup ──────────────────────────────────────────────────────
let oauth2Client = null;
let sheetsService = null;
let googleUser = null; // { email, name, picture }

const CREDENTIALS_PATH = path.join(process.cwd(), 'google-credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'google-token.json');
const REDIRECT_URI = 'http://localhost:3001/oauth2callback';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

function loadOAuth2Client() {
  try {
    let clientId, clientSecret;

    if (fs.existsSync(CREDENTIALS_PATH)) {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const c = creds.web || creds.installed;
      if (c) {
        clientId = c.client_id;
        clientSecret = c.client_secret;
      }
    } else if (process.env.GOOGLE_CREDENTIALS_JSON) {
      try {
        const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        const c = creds.web || creds.installed;
        if (c) {
          clientId = c.client_id;
          clientSecret = c.client_secret;
        }
      } catch (e) {
        console.error('[Google Sheets] Error parsing GOOGLE_CREDENTIALS_JSON:', e.message);
      }
    } else if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      clientId = process.env.GOOGLE_CLIENT_ID;
      clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    }

    if (!clientId || !clientSecret) {
      console.log('[Google Sheets] No credentials found. Add google-credentials.json or set env vars.');
      return false;
    }

    const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
      (process.env.RENDER_EXTERNAL_URL
        ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/oauth2callback`
        : REDIRECT_URI);

    console.log('[Google Sheets] Using OAuth Redirect URI:', redirectUri);

    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(token);
      sheetsService = google.sheets({ version: 'v4', auth: oauth2Client });
      console.log('[Google Sheets] Loaded saved OAuth token.');

      // Fetch user profile on startup
      (async () => {
        try {
          const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
          const { data } = await oauth2.userinfo.get();
          googleUser = { email: data.email, name: data.name, picture: data.picture };
          console.log('[Google Sheets] Authenticated account:', googleUser.email);
        } catch (e) {
          console.warn('[Google Sheets] Could not fetch user on startup:', e.message);
        }
      })();
    } else if (process.env.GOOGLE_TOKEN_JSON) {
      try {
        const token = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
        oauth2Client.setCredentials(token);
        sheetsService = google.sheets({ version: 'v4', auth: oauth2Client });
        console.log('[Google Sheets] Loaded OAuth token from GOOGLE_TOKEN_JSON env var.');
        (async () => {
          try {
            const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
            const { data } = await oauth2.userinfo.get();
            googleUser = { email: data.email, name: data.name, picture: data.picture };
            console.log('[Google Sheets] Authenticated account:', googleUser.email);
          } catch (e) {}
        })();
      } catch (e) {
        console.error('[Google Sheets] Error parsing GOOGLE_TOKEN_JSON:', e.message);
      }
    }

    return true;
  } catch (err) {
    console.error('[Google Sheets] Failed to load credentials:', err.message);
    return false;
  }
}

loadOAuth2Client();

// ─── OAuth2 Routes ────────────────────────────────────────────────────────────

app.get('/auth/google-url', (req, res) => {
  if (!oauth2Client) {
    loadOAuth2Client();
  }
  if (!oauth2Client) {
    return res.status(400).json({ error: 'No Google credentials configured. Add google-credentials.json to root.' });
  }
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent select_account'
  });
  res.json({ url });
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code || !oauth2Client) {
    return res.send('<script>window.close();</script><p>Error: missing code or credentials.</p>');
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    sheetsService = google.sheets({ version: 'v4', auth: oauth2Client });
    console.log('[Google Sheets] OAuth2 token saved.');

    // Fetch user profile
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data } = await oauth2.userinfo.get();
      googleUser = { email: data.email, name: data.name, picture: data.picture };
      console.log('[Google] Logged in as:', googleUser.email);
    } catch (e) {
      console.warn('[Google] Could not fetch user profile:', e.message);
    }

    // Reset activeSpreadsheetId so the new account does NOT inherit the old account's sheet
    activeSpreadsheetId = null;
    if (fs.existsSync(SPREADSHEET_ID_PATH)) {
      try { fs.unlinkSync(SPREADSHEET_ID_PATH); } catch (e) {}
    }

    io.emit('google-auth-success', { user: googleUser });
    res.send(`<html><body style="font-family:sans-serif;background:#050505;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px">
<h2 style="margin:0">✅ Google connected!</h2>
<p style="color:#aaa;margin:0;font-size:14px">Logged in as ${googleUser?.email || 'Google User'}. You can close this tab.</p>
<script>
  // Tell the parent window auth succeeded (more reliable than socket.io across popups)
  if (window.opener) {
    window.opener.postMessage('google-auth-success', '*');
  }
  setTimeout(() => window.close(), 1200);
</script>
</body></html>`);
  } catch (err) {
    console.error('[Google Sheets] OAuth callback error:', err.message);
    res.send('<p>Error during authentication. Check the console.</p>');
  }
});

app.get('/auth/google-status', (req, res) => {
  res.json({ connected: !!sheetsService, user: googleUser || null });
});

app.get('/auth/google-user', (req, res) => {
  res.json({ user: googleUser || null });
});

// ─── TikTok Session Management ─────────────────────────────────────────────────
// Allows setting TIKTOK_SESSION_ID at runtime (survives until server restart)
// GET  /api/tiktok-session → { hasSession: bool }
// POST /api/tiktok-session { sessionId: "..." } → { ok: true }

app.get('/api/tiktok-session', (req, res) => {
  res.json({ hasSession: !!process.env.TIKTOK_SESSION_ID });
});

app.post('/api/tiktok-session', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  process.env.TIKTOK_SESSION_ID = sessionId.trim();
  console.log('[TikTok] Session ID updated at runtime.');
  res.json({ ok: true });
});

app.delete('/api/tiktok-session', (req, res) => {
  delete process.env.TIKTOK_SESSION_ID;
  console.log('[TikTok] Session ID cleared.');
  res.json({ ok: true });
});

// ─── Euler Stream API Key Management ──────────────────────────────────────────
// The tiktok-live-connector v2 uses Euler Stream as signing server.
// Without a key, you hit the anonymous rate limit quickly on deployed servers.
// Get a free key at https://www.eulerstream.com/pricing

app.get('/api/euler-key', (req, res) => {
  res.json({ hasKey: !!process.env.EULER_API_KEY });
});

app.post('/api/euler-key', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  process.env.EULER_API_KEY = apiKey.trim();
  console.log('[Euler] API key updated at runtime.');
  res.json({ ok: true });
});

app.delete('/api/euler-key', (req, res) => {
  delete process.env.EULER_API_KEY;
  console.log('[Euler] API key cleared.');
  res.json({ ok: true });
});

app.post('/auth/google-disconnect', async (req, res) => {
  try {
    if (oauth2Client && sheetsService) {
      await oauth2Client.revokeCredentials().catch(() => {});
    }
    sheetsService = null;
    googleUser = null;
    activeSpreadsheetId = null;
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
    if (fs.existsSync(SPREADSHEET_ID_PATH)) fs.unlinkSync(SPREADSHEET_ID_PATH);
    console.log('[Google Sheets] Disconnected.');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Sheets Helpers & Structure ────────────────────────────────────────

const SUMMARY_HEADERS = [
  'Buyer Name',
  'Username',
  'Total Items',
  'Items Mined',
  'Total Amount (₱)',
  'DP Paid (₱)',
  'Balance (₱)',
  'Payment Status',
  'Last Updated'
];

const RAW_HEADERS = [
  'Buyer Name',
  'Username',
  'Item Code',
  'Price (₱)',
  'Time',
  'Session Date'
];

let activeSpreadsheetId = null;
const SPREADSHEET_ID_PATH = path.join(process.cwd(), 'active-spreadsheet-id.txt');
if (fs.existsSync(SPREADSHEET_ID_PATH)) {
  activeSpreadsheetId = fs.readFileSync(SPREADSHEET_ID_PATH, 'utf8').trim();
} else if (process.env.SPREADSHEET_ID) {
  activeSpreadsheetId = process.env.SPREADSHEET_ID.trim();
}

function saveSpreadsheetId(id) {
  activeSpreadsheetId = id;
  fs.writeFileSync(SPREADSHEET_ID_PATH, id, 'utf8');
}

// ── Daily spreadsheet registry (dateKey -> spreadsheetId) ───────────────────
const DAILY_REGISTRY_PATH = path.join(process.cwd(), 'daily-spreadsheets.json');
let dailyRegistry = {};

try {
  if (fs.existsSync(DAILY_REGISTRY_PATH)) {
    dailyRegistry = JSON.parse(fs.readFileSync(DAILY_REGISTRY_PATH, 'utf8'));
  }
} catch (e) {
  dailyRegistry = {};
}

function saveDailyRegistry() {
  try {
    fs.writeFileSync(DAILY_REGISTRY_PATH, JSON.stringify(dailyRegistry, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save daily registry:', e.message);
  }
}

/**
 * Returns today's date key and spreadsheet title:
 *   key   -> "10.14.26"
 *   title -> "tiktok sales-10.14.26"
 */
function getDailyDateInfo(dateObj = new Date()) {
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  const yy = String(dateObj.getFullYear()).slice(-2);
  const key = `${mm}.${dd}.${yy}`;
  return { key, title: `tiktok sales-${key}` };
}

/**
 * Gets or creates today's Google Spreadsheet file.
 * Keyed by the logged-in Google account (e.g. pawfitcloset@gmail.com)
 * so each account gets its own spreadsheets created directly in its own Drive.
 */
async function ensureDailySpreadsheet(dateObj = new Date()) {
  if (!sheetsService) throw new Error('Not authenticated with Google Sheets.');

  // Ensure current user email is known
  if (!googleUser || !googleUser.email) {
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data } = await oauth2.userinfo.get();
      googleUser = { email: data.email, name: data.name, picture: data.picture };
    } catch (e) {
      console.warn('[Google Sheets] Could not get user email:', e.message);
    }
  }

  const userKey = (googleUser?.email || 'default').toLowerCase().trim();
  const { key, title } = getDailyDateInfo(dateObj);

  if (!dailyRegistry[userKey] || typeof dailyRegistry[userKey] !== 'object') {
    dailyRegistry[userKey] = {};
  }

  // Check if we already created a spreadsheet file for this user and this date
  const existingId = dailyRegistry[userKey][key];
  if (existingId) {
    try {
      const meta = await sheetsService.spreadsheets.get({ spreadsheetId: existingId });
      const sheets = meta.data.sheets || [];
      const sheetTitles = sheets.map(s => (s.properties?.title || '').toLowerCase());

      const requests = [];
      if (!sheetTitles.includes('buyer summary')) {
        requests.push({ addSheet: { properties: { title: 'buyer summary', index: 0 } } });
      }
      if (!sheetTitles.includes('raw orders')) {
        requests.push({ addSheet: { properties: { title: 'raw orders', index: 1 } } });
      }
      if (requests.length > 0) {
        await sheetsService.spreadsheets.batchUpdate({
          spreadsheetId: existingId,
          requestBody: { requests }
        });
      }

      activeSpreadsheetId = existingId;
      saveSpreadsheetId(existingId);
      return existingId;
    } catch (err) {
      console.warn(`[Google Sheets] Spreadsheet for ${userKey} date ${key} (${existingId}) not accessible: ${err.message}. Creating fresh file in ${userKey}'s Drive.`);
      delete dailyRegistry[userKey][key];
      saveDailyRegistry();
    }
  }

  // Create brand new Google Spreadsheet file directly in the logged-in user's Drive
  console.log(`[Google Sheets] Creating new spreadsheet "${title}" inside account ${userKey}...`);
  const created = await sheetsService.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        { properties: { title: 'buyer summary', index: 0 } },
        { properties: { title: 'raw orders', index: 1 } }
      ]
    }
  });

  const spreadsheetId = created.data.spreadsheetId;
  console.log(`[Google Sheets] Created spreadsheet "${title}" in ${userKey}'s Google Drive -> ID: ${spreadsheetId}`);

  // Initialize header rows on both tabs
  await sheetsService.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: "'buyer summary'!A1:I1", values: [SUMMARY_HEADERS] },
        { range: "'raw orders'!A1:E1", values: [['Buyer Name', 'Username', 'Code', 'Price (₱)', 'Time']] }
      ]
    }
  });

  dailyRegistry[userKey][key] = spreadsheetId;
  saveDailyRegistry();
  activeSpreadsheetId = spreadsheetId;
  saveSpreadsheetId(spreadsheetId);

  return spreadsheetId;
}

/**
 * Compatibility wrapper
 */
async function ensureSheet(spreadsheetId) {
  return ensureDailySpreadsheet();
}

/**
 * Builds aggregated buyer summary rows + grand total
 */
function buildBuyerSummaryData(orders = [], dpRecords = {}) {
  const orderList = Array.isArray(orders)
    ? orders
    : (orders && typeof orders === 'object' ? Object.values(orders) : []);

  const groups = {};
  for (const order of orderList) {
    if (!order || typeof order !== 'object') continue;
    const username = order.username || 'unknown';
    if (!groups[username]) {
      groups[username] = {
        name: order.name || username,
        username: order.username,
        items: [],
        total: 0
      };
    }
    groups[username].items.push(order);
    groups[username].total += Number(order.amount) || 0;
  }

  const today = new Date().toLocaleDateString('en-PH');
  const time = new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });

  // Sort: buyers with pending balance first, then highest total
  const sortedBuyers = Object.values(groups).sort((a, b) => {
    const dpA = Number(dpRecords?.[a.username]) || 0;
    const dpB = Number(dpRecords?.[b.username]) || 0;
    const balA = a.total - dpA;
    const balB = b.total - dpB;
    if (balA !== balB) return balB - balA;
    return b.total - a.total;
  });

  const rows = sortedBuyers.map(g => {
    const dp = Number(dpRecords?.[g.username]) || 0;
    const balance = g.total - dp;
    let status = 'UNPAID';
    if (dp > 0) {
      status = balance <= 0 ? 'PAID' : 'PARTIAL';
    }

    const itemsSummary = g.items.map(it => `${it.code} (₱${it.amount})`).join(', ');

    return [
      g.name,
      g.username,
      g.items.length,
      itemsSummary,
      g.total,
      dp,
      Math.max(0, balance),
      status,
      `${today} ${time}`
    ];
  });

  const totalSales = sortedBuyers.reduce((s, g) => s + g.total, 0);
  const totalDp = sortedBuyers.reduce((s, g) => s + (Number(dpRecords?.[g.username]) || 0), 0);
  const totalBal = Math.max(0, totalSales - totalDp);

  if (rows.length > 0) {
    rows.push([]); // blank separator row
    rows.push([
      '═══ GRAND TOTAL ═══',
      `${sortedBuyers.length} Buyers`,
      orders.length,
      '---',
      totalSales,
      totalDp,
      totalBal,
      totalBal === 0 ? 'ALL PAID' : 'PENDING BALANCES',
      `${today} ${time}`
    ]);
  }

  return rows;
}

/**
 * Updates the 'Buyer Summary' sheet with latest aggregated pouch records
 */
async function syncBuyerSummaryTab(spreadsheetId, orders = [], dpRecords = {}) {
  const summaryRows = buildBuyerSummaryData(orders, dpRecords);

  // Clear existing content (preserve headers at row 1)
  await sheetsService.spreadsheets.values.clear({
    spreadsheetId,
    range: "'buyer summary'!A2:I"
  });

  if (summaryRows.length > 0) {
    await sheetsService.spreadsheets.values.update({
      spreadsheetId,
      range: "'buyer summary'!A2",
      valueInputOption: 'RAW',
      requestBody: { values: summaryRows }
    });
  }
}

/**
 * Automatically appends an order to today's daily spreadsheet file ("tiktok sales-MM.DD.YY")
 * under 'raw orders' tab, and updates 'buyer summary' tab.
 */
async function autoAppendOrder(order, dpAmount = 0, currentOrders = null, currentDpRecords = null) {
  if (!sheetsService) return;
  try {
    const spreadsheetId = await ensureDailySpreadsheet();

    // 1. Append row to 'raw orders'
    await sheetsService.spreadsheets.values.append({
      spreadsheetId,
      range: "'raw orders'!A:E",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          order.name,
          order.username,
          order.code,
          order.amount,
          order.time
        ]]
      }
    });

    const { title } = getDailyDateInfo();
    console.log(`[Google Sheets] Order ${order.code} appended to 'raw orders' in "${title}".`);

    // 2. Refresh 'buyer summary'
    let ordersToSummarize = currentOrders;
    if (!ordersToSummarize || ordersToSummarize.length === 0) {
      try {
        ordersToSummarize = db.prepare('SELECT * FROM pinned_orders ORDER BY pinned_at ASC').all();
      } catch (e) {
        ordersToSummarize = [order];
      }
    }

    const dpToUse = currentDpRecords || (order.username ? { [order.username]: dpAmount } : {});
    await syncBuyerSummaryTab(spreadsheetId, ordersToSummarize, dpToUse);
  } catch (err) {
    console.error('[Google Sheets] autoAppendOrder error:', err.message);
  }
}

app.get('/sheets/info', (req, res) => {
  const { key, title } = getDailyDateInfo();
  const userKey = (googleUser?.email || 'default').toLowerCase().trim();
  const id = dailyRegistry[userKey]?.[key] || activeSpreadsheetId || null;
  res.json({
    spreadsheetId: id,
    title,
    account: googleUser?.email || null,
    url: id
      ? `https://docs.google.com/spreadsheets/d/${id}/edit`
      : null
  });
});

app.post('/sheets/set-id', (req, res) => {
  let { spreadsheetId } = req.body;
  if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

  // If user pasted full Google Sheets URL, extract ID automatically
  const match = spreadsheetId.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    spreadsheetId = match[1];
  }

  saveSpreadsheetId(spreadsheetId);
  res.json({
    ok: true,
    spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
  });
});

app.post('/sheets/append-order', async (req, res) => {
  const { order, dpAmount, orders, dpRecords } = req.body;
  try {
    await autoAppendOrder(order, dpAmount, orders, dpRecords);
    res.json({ ok: true, spreadsheetId: activeSpreadsheetId });
  } catch (err) {
    console.error('[Google Sheets] append-order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full sync: rewrites 'raw orders' with all items AND updates 'buyer summary'
app.post('/sheets/sync', async (req, res) => {
  const { orders, dpRecords } = req.body;
  try {
    const spreadsheetId = await ensureDailySpreadsheet();

    let orderList = null;

    if (Array.isArray(orders)) {
      orderList = orders;
    } else if (orders !== undefined && orders !== null && typeof orders === 'object') {
      orderList = Object.values(orders);
    } else {
      // Fallback to SQLite only if 'orders' was completely omitted
      try {
        orderList = db.prepare('SELECT * FROM pinned_orders ORDER BY pinned_at ASC').all();
      } catch (e) {
        orderList = [];
      }
    }

    // 1. Rewrite 'raw orders'
    const rawRows = (orderList || []).map(order => [
      order.name,
      order.username,
      order.code,
      order.amount,
      order.time
    ]);

    await sheetsService.spreadsheets.values.clear({
      spreadsheetId,
      range: "'raw orders'!A2:E"
    });

    if (rawRows.length > 0) {
      await sheetsService.spreadsheets.values.update({
        spreadsheetId,
        range: "'raw orders'!A2",
        valueInputOption: 'RAW',
        requestBody: { values: rawRows }
      });
    }

    // 2. Rewrite 'buyer summary'
    await syncBuyerSummaryTab(spreadsheetId, orderList, dpRecords);

    res.json({
      ok: true,
      spreadsheetId,
      rawCount: rawRows.length,
      buyerCount: Object.keys(dpRecords || {}).length
    });
  } catch (err) {
    console.error('[Google Sheets] sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings Persistence ───────────────────────────────────────────────────
const SETTINGS_PATH = path.join(process.cwd(), 'print-settings.json');
let appPrintSettings = {
  storeName: 'PAWFIT CLOSET',
  showStoreName: true,
  showBuyerName: true,
  showUsername: true,
  showTime: true,
  showCode: true,
  showPrice: true,
  showFooter: true,
  footerText: 'Thank you for shopping! TikTok Live'
};

try {
  if (fs.existsSync(SETTINGS_PATH)) {
    const loaded = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    appPrintSettings = { ...appPrintSettings, ...loaded };
  }
} catch (e) {
  console.warn('Could not load print settings:', e.message);
}

function saveAppPrintSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(appPrintSettings, null, 2), 'utf8');
  } catch (e) {
    console.error('Could not save print settings:', e.message);
  }
}

app.get('/api/settings', (req, res) => {
  res.json(appPrintSettings);
});

app.post('/api/settings', (req, res) => {
  appPrintSettings = { ...appPrintSettings, ...req.body };
  saveAppPrintSettings();
  res.json({ ok: true, settings: appPrintSettings });
});

// ─── Thermal Printing ─────────────────────────────────────────────────────────

let tiktokLiveConnection = null;

function printThermalInvoice(order) {
  const store = appPrintSettings.showStoreName ? (appPrintSettings.storeName || 'PAWFIT CLOSET') : '';
  let linesArr = [];
  if (store) linesArr.push(store);
  if (appPrintSettings.showBuyerName) linesArr.push(`BUYER: ${order.name || 'Anonymous'}`);
  if (appPrintSettings.showUsername) linesArr.push(`USER:  ${order.username || ''}`);
  if (appPrintSettings.showCode) linesArr.push(`CODE:  ${order.code}`);
  if (appPrintSettings.showPrice) linesArr.push(`PRICE: P${order.amount}`);
  if (appPrintSettings.showTime) linesArr.push(`TIME:  ${order.time || ''}`);
  if (appPrintSettings.showFooter && appPrintSettings.footerText) linesArr.push(appPrintSettings.footerText);

  const receiptText = linesArr.join('\n') + '\n\n';

  const tempFilePath = path.join(process.cwd(), 'temp_receipt.txt');
  const psFilePath = path.join(process.cwd(), 'print_label.ps1');

  const psScript = `
Add-Type -AssemblyName System.Drawing
$printerName = "Xprinter XP-410B"
$pd = New-Object System.Drawing.Printing.PrintDocument
$installedPrinters = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters
if ($installedPrinters -contains $printerName) {
  $pd.PrinterSettings.PrinterName = $printerName
} else {
  Write-Host "Xprinter XP-410B not found, using default printer."
}
$pd.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize("Label", 157, 79)
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(4, 4, 4, 4)
$lines = Get-Content "${tempFilePath.replace(/\\/g, '/')}"
$pd.add_PrintPage({
  param($sender, $e)
  $headerFont = New-Object System.Drawing.Font("Arial", 8, [System.Drawing.FontStyle]::Bold)
  $buyerFont  = New-Object System.Drawing.Font("Arial", 8, [System.Drawing.FontStyle]::Bold)
  $codeFont   = New-Object System.Drawing.Font("Arial", 11, [System.Drawing.FontStyle]::Bold)
  $brush      = [System.Drawing.Brushes]::Black
  $y          = [float]2
  foreach ($line in $lines) {
    if ($line.Trim() -ne "") {
      if ($line -like "*CODE*" -or $line -like "*PRICE*") {
        $e.Graphics.DrawString($line, $codeFont, $brush, [float]3, $y)
        $y += [float]13
      } elseif ($line -like "*BUYER*" -or $line -like "*USER*") {
        $e.Graphics.DrawString($line, $buyerFont, $brush, [float]3, $y)
        $y += [float]11
      } else {
        $e.Graphics.DrawString($line, $headerFont, $brush, [float]3, $y)
        $y += [float]10
      }
    }
  }
  $e.HasMorePages = $false
})
$pd.Print()
Write-Host "Label printed successfully."
`;

  try {
    fs.writeFileSync(tempFilePath, receiptText, 'utf8');
    fs.writeFileSync(psFilePath, psScript, 'utf8');

    exec(`powershell -ExecutionPolicy Bypass -File "${psFilePath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error('Print failed:', error.message);
        if (stderr) console.error('stderr:', stderr);
      } else {
        console.log(`Printed 40x20mm label for ${order.name} (${order.code}).`);
        if (stdout) console.log(stdout);
      }
    });
  } catch (err) {
    console.error('Error writing files:', err.message);
  }
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('google-auth-status', { connected: !!sheetsService });

  // Send initial live status and recent comments to newly connected client
  socket.emit('live-status-sync', {
    status: currentLiveStatus,
    targetUsername: currentLiveSeller || ''
  });

  if (recentComments.length > 0) {
    socket.emit('recent-comments-sync', recentComments);
  }

  // Handle manual pin from any client (phone or laptop)
  socket.on('manual-pin-order', (order) => {
    console.log('[MANUAL_PIN] Received order from client:', order.name, order.code);
    try {
      db.prepare(`
        INSERT OR REPLACE INTO pinned_orders (id, name, username, code, amount, raw_text, pinned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(order.id, order.name, order.username, order.code, order.amount, `${order.code} ${order.amount}`, new Date().toISOString());
    } catch (dbErr) {
      console.error('DB insert error:', dbErr.message);
    }

    // Broadcast to ALL connected devices (laptop & phone)
    io.emit('tiktok-pinned-order', order);
  });

  // Handle manual order cancellation from any client
  socket.on('manual-cancel-order', (payload) => {
    const { id } = payload;
    try {
      db.prepare('DELETE FROM pinned_orders WHERE id = ?').run(id);
    } catch (e) {}
    io.emit('order-cancelled', payload);
  });

  // Handle manual DP update from any client
  socket.on('manual-update-dp', (payload) => {
    const { username, amount } = payload;
    try {
      db.prepare(`
        INSERT INTO dp_records (username, amount, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
      `).run(username, amount || 0, new Date().toISOString());
    } catch (e) {}
    io.emit('dp-updated', { username, amount: amount || 0 });
  });

  // Handle reset data broadcast
  socket.on('manual-reset-data', () => {
    recentComments = [];
    io.emit('data-reset');
  });

  socket.on('print-invoice', (payload) => {
    const order = payload.order || payload;
    const clientSettings = payload.settings || null;
    if (clientSettings) {
      appPrintSettings = { ...appPrintSettings, ...clientSettings };
      saveAppPrintSettings();
    }
    console.log(`Received print request for order: ${order.code} by ${order.name}`);
    printThermalInvoice(order, clientSettings || appPrintSettings);
  });

  socket.on('connect-tiktok', (username) => {
    const cleanUsername = username.replace(/^@+/, '');
    console.log(`Attempting to connect to TikTok live: @${cleanUsername}`);

    currentLiveSeller = cleanUsername;
    currentLiveStatus = 'connecting';
    io.emit('live-status-sync', { status: 'connecting', targetUsername: cleanUsername });

    if (tiktokLiveConnection) {
      try { tiktokLiveConnection.disconnect(); } catch (e) {}
      tiktokLiveConnection = null;
    }

    try {
      const eulerApiKey = process.env.EULER_API_KEY;
      const sessionId = process.env.TIKTOK_SESSION_ID;
      const sessionOpts = sessionId
        ? { session: { cookie: { sessionid: sessionId } } }
        : {};

      tiktokLiveConnection = new TikTokLiveConnection(cleanUsername, {
        processInitialData: true,
        enableExtendedGiftInfo: false,
        fetchRoomInfoOnConnect: true,
        ...(eulerApiKey ? { signApiKey: eulerApiKey } : {}),
        ...sessionOpts,
        webClientOptions: {
          timeout: { request: 20000 }
        }
      });

      console.log(`[TikTok] Connecting to @${cleanUsername} | eulerKey=${eulerApiKey ? '✓' : 'none'} | session=${sessionId ? '✓' : 'none'}`);

      tiktokLiveConnection.connect().then(state => {
        console.log(`[TikTok] Connected to roomId ${state.roomId}`);
        currentLiveStatus = 'connected';
        // Broadcast to ALL clients (phone and laptop)
        io.emit('tiktok-connected', {
          msg: `Successfully connected to @${cleanUsername}`,
          targetUsername: cleanUsername
        });
      }).catch(err => {
        console.error('[TikTok] Failed to connect:', err.message);
        currentLiveStatus = 'offline';
        io.emit('live-status-sync', { status: 'offline', targetUsername: cleanUsername });

        const errMsg = err.message || '';
        let friendlyMsg;

        if (
          errMsg.toLowerCase().includes('rate_limit') ||
          errMsg.toLowerCase().includes('rate limit') ||
          errMsg.toLowerCase().includes('eulerstream') ||
          errMsg.toLowerCase().includes('sign up for a free api key') ||
          errMsg.toLowerCase().includes('too many connections')
        ) {
          friendlyMsg = `⚠️ Euler Stream rate limit! Kailangan ng API key.\n\n1. Pumunta sa eulerstream.com/pricing\n2. Kumuha ng LIBRENG API key\n3. I-set sa Settings → "Euler API Key"\n\nError: ${errMsg}`;
        } else if (
          errMsg.includes('UserOfflineError') ||
          errMsg.toLowerCase().includes('not live') ||
          errMsg.toLowerCase().includes('offline') ||
          errMsg.toLowerCase().includes('not currently')
        ) {
          friendlyMsg = `@${cleanUsername} ay hindi naka-live ngayon. Subukan ulit kapag live na sila.`;
        } else if (errMsg.toLowerCase().includes('not found') || errMsg.toLowerCase().includes('user not found')) {
          friendlyMsg = `@${cleanUsername} ay hindi mahanap. Siguraduhing tama ang username.`;
        } else if (
          errMsg.toLowerCase().includes('getaddrinfo') ||
          errMsg.toLowerCase().includes('econnrefused') ||
          errMsg.toLowerCase().includes('network')
        ) {
          friendlyMsg = `Network error sa server. Error: ${errMsg}`;
        } else {
          friendlyMsg = `Hindi makaconnect sa @${cleanUsername}. Error: ${errMsg}`;
        }

        socket.emit('tiktok-error', friendlyMsg);
      });

      const handleChatData = (data) => {
        const uniqueId = data.uniqueId || data.user?.uniqueId || data.user?.displayId || '';
        const nickname = data.nickname || data.user?.nickname || uniqueId || 'Anonymous';
        const comment = data.comment || data.content || data.text || '';

        if (comment) {
          const chatMsg = {
            id: data.msgId || Math.random().toString(36).substr(2, 9),
            name: nickname,
            username: `@${uniqueId}`,
            text: comment
          };
          recentComments.unshift(chatMsg);
          if (recentComments.length > 100) recentComments.pop();

          // Broadcast to ALL connected clients (laptop & phone)
          io.emit('tiktok-chat', chatMsg);
        }
      };

      tiktokLiveConnection.on(WebcastEvent.CHAT, handleChatData);

      // Fires when comment is pinned on TikTok Live
      tiktokLiveConnection.on(WebcastEvent.ROOM_PIN, (data) => {
        console.log('=== ROOM_PIN EVENT RECEIVED ===', JSON.stringify(data));
        const chat = data.chatMessage || data.comment || data.message || data.pinnedMessage || data.pinMsg || data || {};

        const uniqueId = chat.uniqueId || chat.user?.uniqueId || chat.user?.displayId || data.uniqueId || data.user?.uniqueId || '';
        const nickname = chat.nickname || chat.user?.nickname || chat.name || data.nickname || data.user?.nickname || uniqueId || 'Anonymous';
        const text = chat.content || chat.comment || chat.text || chat.message || chat.displayContent || data.content || data.comment || data.text || '';

        if (!text) {
          console.log('[ROOM_PIN] No text found in pinned event payload.');
          return;
        }

        const orderRegex = /(?:mine|grab|take|get|pouch)?\s*#?([a-zA-Z0-9_-]+)\s+[₱pP]?\s*(\d+)/i;
        const match = text.match(orderRegex);
        if (!match) {
          console.log(`[ROOM_PIN] Pinned comment "${text}" does not match item code and price format.`);
          return;
        }

        const code = match[1].toUpperCase();
        const price = parseInt(match[2], 10);

        const order = {
          id: Math.random().toString(36).substr(2, 9),
          name: nickname,
          username: `@${uniqueId}`,
          code,
          amount: price,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        console.log(`[ROOM_PIN] Order parsed successfully: ${order.name} (${order.code} - ₱${order.amount})`);

        try {
          db.prepare(`
            INSERT OR REPLACE INTO pinned_orders (id, name, username, code, amount, raw_text, pinned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(order.id, order.name, order.username, order.code, order.amount, text, new Date().toISOString());
        } catch (dbErr) {
          console.error('DB insert error:', dbErr.message);
        }

        // Broadcast to ALL connected clients
        io.emit('tiktok-pinned-order', order);
        printThermalInvoice(order);
        autoAppendOrder(order, 0);
      });

      tiktokLiveConnection.on(WebcastEvent.STREAM_END, () => {
        console.log('Stream ended.');
        currentLiveStatus = 'offline';
        io.emit('tiktok-disconnected', 'Stream has ended.');
      });

      tiktokLiveConnection.on(ControlEvent.ERROR, ({ info, exception }) => {
        console.error('TikTok connection error:', info, exception?.message);
      });

    } catch (err) {
      console.error('Error creating connection:', err.message);
      currentLiveStatus = 'offline';
      socket.emit('tiktok-error', `Error: ${err.message}`);
    }
  });

  socket.on('disconnect-tiktok', () => {
    if (tiktokLiveConnection) {
      try { tiktokLiveConnection.disconnect(); } catch (e) {}
      tiktokLiveConnection = null;
      currentLiveStatus = 'offline';
      console.log('Disconnected from TikTok live');
      io.emit('tiktok-disconnected', 'Manually disconnected.');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve built frontend files in production
const distPath = path.join(process.cwd(), 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/sheets') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`TikTok Live Connector server running on port ${PORT}`);
});
