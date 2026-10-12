/**
 * test-db.js
 * Run with:  node test-db.js
 *
 * Inserts two fake pinned orders into orders.db and prints all rows.
 * Safe to run multiple times — uses INSERT OR REPLACE so IDs won't duplicate.
 */

import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const db = new Database(path.join(process.cwd(), 'orders.db'));

// Ensure the table exists
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

// ── Insert fake pinned orders ──────────────────────────────────────────────
const insert = db.prepare(`
  INSERT OR REPLACE INTO pinned_orders (id, name, username, code, amount, raw_text, pinned_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

insert.run('test-001', 'Maria Santos',  '@mariasantos',  'DRESS1', 599, 'DRESS1 599', new Date().toISOString());
insert.run('test-002', 'Jake Reyes',    '@jakereyes',    'SHIRT3', 350, 'SHIRT3 350', new Date().toISOString());

console.log('✅ Two test orders inserted.\n');

// ── Read all rows back ─────────────────────────────────────────────────────
const rows = db.prepare('SELECT * FROM pinned_orders ORDER BY pinned_at DESC').all();

console.log(`📦 All pinned orders in DB (${rows.length} total):\n`);
rows.forEach(r => {
  console.log(`  [${r.id}] ${r.name} (${r.username}) → ${r.code} ₱${r.amount}  |  ${r.pinned_at}`);
});

db.close();
