const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'quotes.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS quotes (
  number TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  client_phone_norm TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,          -- JSON: everything else
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | expired | draft
  issued_at TEXT NOT NULL,
  valid_days INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number TEXT NOT NULL,
  phone_entered TEXT,
  ok INTEGER NOT NULL,
  ip TEXT,
  ua TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  phone TEXT,
  ip TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---- helpers ----
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return d;
}

function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function nextNumber() {
  const year = new Date().getFullYear();
  const prefix = getSetting('prefix', 'HM');
  const start = parseInt(getSetting('next_seq', '79'), 10);
  const row = db.prepare(`SELECT number FROM quotes WHERE number LIKE ? ORDER BY number DESC LIMIT 1`).get(`${prefix}-${year}-%`);
  let seq = start;
  if (row) {
    const n = parseInt(row.number.split('-').pop(), 10);
    if (!isNaN(n) && n + 1 > seq) seq = n + 1;
  }
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

function listQuotes() {
  return db.prepare('SELECT number, client_name, client_phone, title, status, issued_at, valid_days, updated_at FROM quotes ORDER BY created_at DESC').all()
    .map(q => ({ ...q, views: db.prepare('SELECT COUNT(*) c FROM views WHERE quote_number=? AND ok=1').get(q.number).c,
                 approved: db.prepare('SELECT signer_name, at FROM approvals WHERE quote_number=? ORDER BY at DESC LIMIT 1').get(q.number) }));
}

function getQuote(number) {
  const q = db.prepare('SELECT * FROM quotes WHERE number=?').get(number);
  if (!q) return null;
  q.data = JSON.parse(q.data);
  return q;
}

function saveQuote(q) {
  const exists = db.prepare('SELECT 1 FROM quotes WHERE number=?').get(q.number);
  const data = JSON.stringify(q.data);
  if (exists) {
    db.prepare(`UPDATE quotes SET client_name=?, client_phone=?, client_phone_norm=?, title=?, data=?, status=?, issued_at=?, valid_days=?, updated_at=datetime('now') WHERE number=?`)
      .run(q.client_name, q.client_phone, normPhone(q.client_phone), q.title, data, q.status, q.issued_at, q.valid_days, q.number);
  } else {
    db.prepare(`INSERT INTO quotes(number, client_name, client_phone, client_phone_norm, title, data, status, issued_at, valid_days) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(q.number, q.client_name, q.client_phone, normPhone(q.client_phone), q.title, data, q.status, q.issued_at, q.valid_days);
  }
}

function deleteQuote(number) {
  db.prepare('DELETE FROM quotes WHERE number=?').run(number);
  db.prepare('DELETE FROM views WHERE quote_number=?').run(number);
  db.prepare('DELETE FROM approvals WHERE quote_number=?').run(number);
}

function logView(number, phone, ok, ip, ua) {
  db.prepare('INSERT INTO views(quote_number, phone_entered, ok, ip, ua) VALUES(?,?,?,?,?)').run(number, phone, ok ? 1 : 0, ip, ua);
}
function addApproval(number, name, phone, ip) {
  db.prepare('INSERT INTO approvals(quote_number, signer_name, phone, ip) VALUES(?,?,?,?)').run(number, name, phone, ip);
  db.prepare(`UPDATE quotes SET status='approved', updated_at=datetime('now') WHERE number=?`).run(number);
}
function getApproval(number) {
  return db.prepare('SELECT * FROM approvals WHERE quote_number=? ORDER BY at DESC LIMIT 1').get(number);
}
function getViews(number) {
  return db.prepare('SELECT * FROM views WHERE quote_number=? ORDER BY at DESC LIMIT 50').all(number);
}

module.exports = { db, normPhone, getSetting, setSetting, nextNumber, listQuotes, getQuote, saveQuote, deleteQuote, logView, addApproval, getApproval, getViews };

// ================= FORMS =================
db.exec(`
CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL,          -- JSON [{text,type:'choice'|'multi'|'text',options:[],required}]
  collect_contact INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',   -- open | closed
  thanks TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id TEXT NOT NULL,
  name TEXT, phone TEXT,
  answers TEXT NOT NULL,            -- JSON array aligned with questions (string or array)
  ip TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
function newFormId() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    let s = ''; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
    if (!db.prepare('SELECT 1 FROM forms WHERE id=?').get(s)) return s;
  }
}
function listForms() {
  return db.prepare('SELECT id, title, status, created_at, updated_at FROM forms ORDER BY created_at DESC').all()
    .map(f => ({ ...f, count: db.prepare('SELECT COUNT(*) c FROM responses WHERE form_id=?').get(f.id).c,
                 last: (db.prepare('SELECT at FROM responses WHERE form_id=? ORDER BY at DESC LIMIT 1').get(f.id) || {}).at }));
}
function getForm(id) {
  const f = db.prepare('SELECT * FROM forms WHERE id=?').get(id);
  if (!f) return null;
  f.questions = JSON.parse(f.questions);
  return f;
}
function saveForm(f) {
  const q = JSON.stringify(f.questions || []);
  if (f.id && db.prepare('SELECT 1 FROM forms WHERE id=?').get(f.id)) {
    db.prepare(`UPDATE forms SET title=?, description=?, questions=?, collect_contact=?, status=?, thanks=?, updated_at=datetime('now') WHERE id=?`)
      .run(f.title, f.description || '', q, f.collect_contact ? 1 : 0, f.status || 'open', f.thanks || '', f.id);
    return f.id;
  }
  const id = newFormId();
  db.prepare('INSERT INTO forms(id, title, description, questions, collect_contact, status, thanks) VALUES(?,?,?,?,?,?,?)')
    .run(id, f.title, f.description || '', q, f.collect_contact ? 1 : 0, f.status || 'open', f.thanks || '');
  return id;
}
function deleteForm(id) {
  db.prepare('DELETE FROM forms WHERE id=?').run(id);
  db.prepare('DELETE FROM responses WHERE form_id=?').run(id);
}
function addResponse(formId, name, phone, answers, ip) {
  db.prepare('INSERT INTO responses(form_id, name, phone, answers, ip) VALUES(?,?,?,?,?)').run(formId, name || null, phone || null, JSON.stringify(answers), ip);
}
function getResponses(formId) {
  return db.prepare('SELECT * FROM responses WHERE form_id=? ORDER BY at DESC').all(formId).map(r => ({ ...r, answers: JSON.parse(r.answers) }));
}
function deleteResponse(id) { db.prepare('DELETE FROM responses WHERE id=?').run(id); }

Object.assign(module.exports, { listForms, getForm, saveForm, deleteForm, addResponse, getResponses, deleteResponse });
