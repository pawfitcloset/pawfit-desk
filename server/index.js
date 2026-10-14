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
  )
`);

console.log('SQLite database ready → orders.db');

const app = express();
app.use(cors());
app.use(express.json());

// REST endpoint — fetch all saved pinned orders
app.get('/api/pinned-orders', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM pinned_orders ORDER BY pinned_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST endpoint — delete a pinned order by id
app.delete('/api/pinned-orders/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM pinned_orders WHERE id = ?').run(req.params.id);
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

const CREDENTIALS_PATH = path.join(process.cwd(), 'google-credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'google-token.json');
const REDIRECT_URI = 'http://localhost:3001/oauth2callback';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

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

    const redirectUri = process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/oauth2callback`
      : (process.env.GOOGLE_REDIRECT_URI || REDIRECT_URI);

    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(token);
      sheetsService = google.sheets({ version: 'v4', auth: oauth2Client });
      console.log('[Google Sheets] Loaded saved OAuth token.');
    } else if (process.env.GOOGLE_TOKEN_JSON) {
      try {
        const token = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
        oauth2Client.setCredentials(token);
        sheetsService = google.sheets({ version: 'v4', auth: oauth2Client });
        console.log('[Google Sheets] Loaded OAuth token from GOOGLE_TOKEN_JSON env var.');
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
    prompt: 'consent'
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
    io.emit('google-auth-success');
    res.send('<html><body style="font-family:sans-serif;background:#050505;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✅ Google Sheets connected! You can close this tab.</h2><script>window.close();</script></body></html>');
  } catch (err) {
    console.error('[Google Sheets] OAuth callback error:', err.message);
    res.send('<p>Error during authentication. Check the console.</p>');
  }
});

app.get('/auth/google-status', (req, res) => {
  res.json({ connected: !!sheetsService });
});

app.post('/auth/google-disconnect', async (req, res) => {
  try {
    if (oauth2Client && sheetsService) {
      await oauth2Client.revokeCredentials().catch(() => {});
    }
    sheetsService = null;
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
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

/**
 * Ensures the workbook has:
 *  1. 'Buyer Summary' (tab 0: aggregated pouch view per buyer + totals)
 *  2. 'Raw Orders'   (tab 1: itemized list of every pinned item)
 */
async function ensureSheet(spreadsheetId) {
  if (!sheetsService) throw new Error('Not authenticated with Google Sheets.');

  if (!spreadsheetId) {
    const today = new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    const created = await sheetsService.spreadsheets.create({
      requestBody: {
        properties: { title: `Pawfit Desk Orders – ${today}` },
        sheets: [
          { properties: { title: 'Buyer Summary', index: 0 } },
          { properties: { title: 'Raw Orders', index: 1 } }
        ]
      }
    });
    spreadsheetId = created.data.spreadsheetId;
    console.log('[Google Sheets] Created new spreadsheet with 2 tabs:', spreadsheetId);

    // Initialize headers on both tabs
    await sheetsService.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: "'Buyer Summary'!A1:I1", values: [SUMMARY_HEADERS] },
          { range: "'Raw Orders'!A1:F1", values: [RAW_HEADERS] }
        ]
      }
    });

    return spreadsheetId;
  }

  try {
    const meta = await sheetsService.spreadsheets.get({ spreadsheetId });
    const sheetList = meta.data.sheets || [];
    const titles = sheetList.map(s => s.properties.title);
    const requests = [];

    // Rename legacy 'Summary' -> 'Buyer Summary' if present
    if (titles.includes('Summary') && !titles.includes('Buyer Summary')) {
      const sheetId = sheetList.find(s => s.properties.title === 'Summary').properties.sheetId;
      requests.push({
        updateSheetProperties: {
          properties: { sheetId, title: 'Buyer Summary', index: 0 },
          fields: 'title,index'
        }
      });
    } else if (!titles.includes('Buyer Summary')) {
      requests.push({ addSheet: { properties: { title: 'Buyer Summary', index: 0 } } });
    }

    // Rename legacy 'Orders' -> 'Raw Orders' if present
    if (titles.includes('Orders') && !titles.includes('Raw Orders')) {
      const sheetId = sheetList.find(s => s.properties.title === 'Orders').properties.sheetId;
      requests.push({
        updateSheetProperties: {
          properties: { sheetId, title: 'Raw Orders', index: 1 },
          fields: 'title,index'
        }
      });
    } else if (!titles.includes('Raw Orders')) {
      requests.push({ addSheet: { properties: { title: 'Raw Orders', index: 1 } } });
    }

    if (requests.length > 0) {
      await sheetsService.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests }
      });
    }

    // Ensure headers are written on both tabs
    await sheetsService.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: "'Buyer Summary'!A1:I1", values: [SUMMARY_HEADERS] },
          { range: "'Raw Orders'!A1:F1", values: [RAW_HEADERS] }
        ]
      }
    });
  } catch (err) {
    console.warn('[Google Sheets] Existing sheet not accessible, creating fresh one:', err.message);
    return ensureSheet(null);
  }

  return spreadsheetId;
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
    range: "'Buyer Summary'!A2:I"
  });

  if (summaryRows.length > 0) {
    await sheetsService.spreadsheets.values.update({
      spreadsheetId,
      range: "'Buyer Summary'!A2",
      valueInputOption: 'RAW',
      requestBody: { values: summaryRows }
    });
  }
}

/**
 * Automatically appends a raw order to 'Raw Orders' and updates 'Buyer Summary'
 */
async function autoAppendOrder(order, dpAmount = 0, currentOrders = null, currentDpRecords = null) {
  if (!sheetsService) return;
  try {
    activeSpreadsheetId = await ensureSheet(activeSpreadsheetId);
    saveSpreadsheetId(activeSpreadsheetId);

    const today = new Date().toLocaleDateString('en-PH');

    // 1. Append single item to 'Raw Orders'
    await sheetsService.spreadsheets.values.append({
      spreadsheetId: activeSpreadsheetId,
      range: "'Raw Orders'!A:F",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          order.name,
          order.username,
          order.code,
          order.amount,
          order.time,
          today
        ]]
      }
    });

    console.log(`[Google Sheets] Order ${order.code} appended to 'Raw Orders'.`);

    // 2. Refresh 'Buyer Summary'
    let ordersToSummarize = currentOrders;
    if (!ordersToSummarize || ordersToSummarize.length === 0) {
      try {
        ordersToSummarize = db.prepare('SELECT * FROM pinned_orders ORDER BY pinned_at ASC').all();
      } catch (e) {
        ordersToSummarize = [order];
      }
    }

    const dpToUse = currentDpRecords || (order.username ? { [order.username]: dpAmount } : {});
    await syncBuyerSummaryTab(activeSpreadsheetId, ordersToSummarize, dpToUse);
  } catch (err) {
    console.error('[Google Sheets] autoAppendOrder error:', err.message);
  }
}

app.get('/sheets/info', (req, res) => {
  res.json({
    spreadsheetId: activeSpreadsheetId,
    url: activeSpreadsheetId
      ? `https://docs.google.com/spreadsheets/d/${activeSpreadsheetId}/edit`
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

// Full sync: rewrites 'Raw Orders' with all items AND updates 'Buyer Summary'
app.post('/sheets/sync', async (req, res) => {
  const { orders, dpRecords } = req.body;
  try {
    activeSpreadsheetId = await ensureSheet(activeSpreadsheetId);
    saveSpreadsheetId(activeSpreadsheetId);

    const today = new Date().toLocaleDateString('en-PH');
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

    // 1. Rewrite 'Raw Orders'
    const rawRows = (orderList || []).map(order => [
      order.name,
      order.username,
      order.code,
      order.amount,
      order.time,
      today
    ]);

    await sheetsService.spreadsheets.values.clear({
      spreadsheetId: activeSpreadsheetId,
      range: "'Raw Orders'!A2:F"
    });

    if (rawRows.length > 0) {
      await sheetsService.spreadsheets.values.update({
        spreadsheetId: activeSpreadsheetId,
        range: "'Raw Orders'!A2",
        valueInputOption: 'RAW',
        requestBody: { values: rawRows }
      });
    }

    // 2. Rewrite 'Buyer Summary'
    await syncBuyerSummaryTab(activeSpreadsheetId, orderList, dpRecords);

    res.json({
      ok: true,
      spreadsheetId: activeSpreadsheetId,
      rawCount: rawRows.length,
      buyerCount: Object.keys(dpRecords || {}).length
    });
  } catch (err) {
    console.error('[Google Sheets] sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Thermal Printing ─────────────────────────────────────────────────────────

let tiktokLiveConnection = null;

function printThermalInvoice(order) {
  const receiptText = `PAWFIT CLOSET
BUYER: ${order.name}
USER:  ${order.username}
CODE:  ${order.code}
PRICE: P${order.amount}
\n`;

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

  socket.on('print-invoice', (order) => {
    console.log(`Received print request for order: ${order.code} by ${order.name}`);
    printThermalInvoice(order);
  });

  socket.on('connect-tiktok', (username) => {
    const cleanUsername = username.replace(/^@+/, '');
    console.log(`Attempting to connect to TikTok live: @${cleanUsername}`);

    if (tiktokLiveConnection) {
      try { tiktokLiveConnection.disconnect(); } catch (e) {}
      tiktokLiveConnection = null;
    }

    try {
      tiktokLiveConnection = new TikTokLiveConnection(cleanUsername, {
        processInitialData: true,
        enableExtendedGiftInfo: false
      });

      tiktokLiveConnection.connect().then(state => {
        console.log(`Connected to roomId ${state.roomId}`);
        socket.emit('tiktok-connected', `Successfully connected to @${cleanUsername}`);
      }).catch(err => {
        console.error('Failed to connect:', err.message);
        socket.emit('tiktok-error', `Failed to connect to @${cleanUsername}. Make sure the user is currently live.`);
      });

      const handleChatData = (data) => {
        const uniqueId = data.uniqueId || data.user?.uniqueId || data.user?.displayId || '';
        const nickname = data.nickname || data.user?.nickname || uniqueId || 'Anonymous';
        const comment = data.comment || data.content || data.text || '';

        if (comment) {
          socket.emit('tiktok-chat', {
            id: data.msgId || Math.random().toString(36).substr(2, 9),
            name: nickname,
            username: `@${uniqueId}`,
            text: comment
          });
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

        // Match format: "23 129", "mine 23 129", "mine #23 129", "DRESS1 599"
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

        socket.emit('tiktok-pinned-order', order);
        printThermalInvoice(order);
        autoAppendOrder(order, 0);
      });

      tiktokLiveConnection.on(WebcastEvent.STREAM_END, () => {
        console.log('Stream ended.');
        socket.emit('tiktok-disconnected', 'Stream has ended.');
      });

      tiktokLiveConnection.on(ControlEvent.ERROR, ({ info, exception }) => {
        console.error('TikTok connection error:', info, exception?.message);
      });

    } catch (err) {
      console.error('Error creating connection:', err.message);
      socket.emit('tiktok-error', `Error: ${err.message}`);
    }
  });

  socket.on('disconnect-tiktok', () => {
    if (tiktokLiveConnection) {
      try { tiktokLiveConnection.disconnect(); } catch (e) {}
      tiktokLiveConnection = null;
      console.log('Disconnected from TikTok live');
      socket.emit('tiktok-disconnected', 'Manually disconnected.');
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
