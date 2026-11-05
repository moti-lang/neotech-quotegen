try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const D = require('./db');
const DEFAULTS = require('./defaults');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const BASE_URL = process.env.BASE_URL || ''; // e.g. https://quote.neotechvision.io

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);
// לוג קצר לבקשות המחבר (הטוקן מוסתר) – לאבחון חיבור ל-Claude
app.use((req, res, next) => {
  if (!/^\/(mcp|\.well-known|register|authorize|token)/.test(req.path)) return next();
  const t0 = Date.now();
  const seg = (req.path.split('/')[2] || '');
  const shape = seg ? `seg[len=${seg.length},${seg.slice(0, 4)}…${seg.slice(-4)}]` : '';
  res.on('finish', () => console.log('[mcp-log]', req.method, req.originalUrl.replace(/[0-9a-f]{20,}/g, '<token>'), shape,
    'q=' + (Object.keys(req.query || {}).join(',') || '-'), 'sid=' + (req.get('mcp-session-id') ? 'yes' : 'no'),
    'auth=' + (req.get('authorization') ? 'yes' : 'no'),
    res.statusCode, `${Date.now() - t0}ms`, 'ct=' + (req.get('content-type') || '-'), 'accept=' + (req.get('accept') || '-'),
    'ua=' + (req.get('user-agent') || '-').slice(0, 60)));
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const fmt = (n) => new Intl.NumberFormat('he-IL').format(Math.round(n));
const fmtDate = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`; };
const todayISO = () => new Date().toISOString().slice(0, 10);

function settings() {
  const s = JSON.parse(D.getSetting('settings', 'null')) || {};
  return { ...DEFAULTS, ...s, company: { ...DEFAULTS.company, ...(s.company || {}) } };
}

function compute(q) {
  const S = settings();
  const d = q.data;
  const vat = Number(d.vat ?? S.vat);
  const comps = (d.components || []).map((c, i) => ({ ...c, idx: i + 1, price: Number(c.price || 0), hours: Number(c.hours || 0) }));
  const subtotal = comps.reduce((a, c) => a + c.price, 0);
  const hours = comps.reduce((a, c) => a + c.hours, 0);
  const vatAmt = subtotal * vat / 100;
  const total = subtotal + vatAmt;
  const split = (d.payment_split && d.payment_split.length ? d.payment_split : S.payment_split).map(p => ({ ...p, pct: Number(p.pct), amount: total * Number(p.pct) / 100 }));
  const issued = fmtDate(q.issued_at);
  const expires = new Date(q.issued_at); expires.setDate(expires.getDate() + Number(q.valid_days));
  const C = S.company;
  const joinHe = (arr) => arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' ו-' + arr[arr.length - 1];
  const vars = {
    PAYMENT_SPLIT: joinHe(split.map(p => `${p.pct}% ${p.label}`)),
    PAYMENT_AMOUNTS: `הקמה: ${split.map(p => fmt(p.amount) + ' ₪').join(' + ')} = ${fmt(total)} ₪ כולל מע"מ`,
    COMPANY: C.name, COMPANY_HE: C.name_he, BANK: C.bank, VALID_DAYS: q.valid_days, ISSUED: issued, VAT: vat,
  };
  const terms = (d.terms && d.terms.length ? d.terms : S.terms).map(t => ({ ...t, text: String(t.text).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`) }));
  const stages = d.stages && d.stages.length ? d.stages : S.stages;
  return { q, S, C, comps, subtotal, hours, vat, vatAmt, total, split, terms, stages, issued, expires: fmtDate(expires), expired: expires < new Date(), fmt,
           approval: D.getApproval(q.number), outcomes: d.outcomes || [], description: d.description || '', lineLabel: d.line_label || 'הקמת המערכת' };
}

// ---------- admin auth ----------
function adminAuth(req, res, next) {
  if (req.cookies.adm === sign('admin')) return next();
  if (req.path.startsWith('/admin/login')) return next();
  res.redirect('/admin/login');
}
app.get('/', (_, res) => res.redirect('/admin'));
app.get('/admin/login', (req, res) => res.render('admin/login', { error: null }));
app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.cookie('adm', sign('admin'), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'סיסמה שגויה' });
});
app.get('/admin/logout', (req, res) => { res.clearCookie('adm'); res.redirect('/admin/login'); });
app.use('/admin', adminAuth);

// ---------- admin pages ----------
app.get('/admin', (req, res) => res.render('admin/list', { quotes: D.listQuotes(), baseUrl: BASE_URL || `${req.protocol}://${req.get('host')}`, fmtDate }));

app.get('/admin/new', (req, res) => {
  const S = settings();
  const q = { number: D.nextNumber(), client_name: '', client_phone: '', title: '', status: 'pending', issued_at: todayISO(), valid_days: S.valid_days,
    data: { description: '', line_label: 'הקמת המערכת', components: [{ name: '', desc: '', hours: '', price: '', bullets: [] }], outcomes: [], stages: S.stages, payment_split: S.payment_split, terms: S.terms, vat: S.vat } };
  res.render('admin/edit', { q, isNew: true });
});
app.get('/admin/edit/:number', (req, res) => {
  const q = D.getQuote(req.params.number);
  if (!q) return res.status(404).send('לא נמצא');
  res.render('admin/edit', { q, isNew: false, views: D.getViews(q.number), approval: D.getApproval(q.number) });
});
app.post('/admin/save', (req, res) => {
  const b = req.body;
  if (!b.number || !b.client_name || !b.client_phone || !b.title) return res.status(400).json({ error: 'חסרים שדות חובה: מספר, לקוח, טלפון, כותרת' });
  if (D.normPhone(b.client_phone).length < 9) return res.status(400).json({ error: 'מספר טלפון לא תקין' });
  D.saveQuote({ number: b.number.trim(), client_name: b.client_name.trim(), client_phone: b.client_phone.trim(), title: b.title.trim(),
    status: b.status || 'pending', issued_at: b.issued_at || todayISO(), valid_days: Number(b.valid_days) || 30, data: b.data || {} });
  res.json({ ok: true, number: b.number.trim() });
});
app.post('/admin/delete/:number', (req, res) => { D.deleteQuote(req.params.number); res.redirect('/admin'); });
app.post('/admin/duplicate/:number', (req, res) => {
  const q = D.getQuote(req.params.number); if (!q) return res.status(404).send('לא נמצא');
  const n = D.nextNumber();
  D.saveQuote({ ...q, number: n, status: 'pending', issued_at: todayISO() });
  res.redirect('/admin/edit/' + n);
});
app.get('/admin/preview/:number', (req, res) => {
  const q = D.getQuote(req.params.number); if (!q) return res.status(404).send('לא נמצא');
  res.render('quote', { ...compute(q), preview: true });
});
app.get('/admin/settings', (req, res) => res.render('admin/settings', { S: settings(), nextSeq: D.getSetting('next_seq', '79'), prefix: D.getSetting('prefix', 'HM'), saved: req.query.saved, mcpUrl: `${req.protocol}://${req.get('host')}` + mcp.path }));
app.post('/admin/settings', (req, res) => {
  const b = req.body;
  D.setSetting('settings', JSON.stringify(b.settings || {}));
  if (b.next_seq) D.setSetting('next_seq', b.next_seq);
  if (b.prefix) D.setSetting('prefix', b.prefix);
  res.json({ ok: true });
});

// ---------- client side (phone gate) ----------
const attempts = new Map(); // key -> {n, t}
function tooMany(key) {
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  a.n++; attempts.set(key, a);
  return a.n > 10;
}
const gateCookie = (q) => sign('q:' + q.number + ':' + q.client_phone_norm);

app.get('/quotes/:number', (req, res) => res.redirect(301, '/q/' + req.params.number));
app.get('/q/:number', (req, res) => {
  const q = D.getQuote(req.params.number);
  if (!q || q.status === 'draft') return res.status(404).render('gate', { number: req.params.number, error: 'הצעה לא נמצאה', notFound: true, company: settings().company });
  if (req.cookies['q_' + q.number] === gateCookie(q)) return res.render('quote', { ...compute(q), preview: false });
  res.render('gate', { number: q.number, error: null, notFound: false, company: settings().company });
});
app.post('/q/:number/unlock', (req, res) => {
  const q = D.getQuote(req.params.number);
  if (!q) return res.status(404).send('לא נמצא');
  const phone = D.normPhone(req.body.phone);
  const ok = phone.length >= 9 && phone === q.client_phone_norm;
  D.logView(q.number, req.body.phone, ok, req.ip, req.get('user-agent'));
  if (tooMany(req.ip + ':' + q.number)) return res.status(429).render('gate', { number: q.number, error: 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.', notFound: false, company: settings().company });
  if (!ok) return res.status(401).render('gate', { number: q.number, error: 'מספר הטלפון אינו תואם להצעה זו', notFound: false, company: settings().company });
  res.cookie('q_' + q.number, gateCookie(q), { httpOnly: true, sameSite: 'lax', maxAge: 90 * 864e5 });
  res.redirect('/q/' + q.number);
});
app.post('/q/:number/approve', (req, res) => {
  const q = D.getQuote(req.params.number);
  if (!q || req.cookies['q_' + q.number] !== gateCookie(q)) return res.status(403).json({ error: 'אין גישה' });
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'נא להזין שם מלא' });
  D.addApproval(q.number, name, q.client_phone, req.ip);
  res.json({ ok: true });
});

// ================= FORMS =================
const fmtDT = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }) : '';
const baseOf = (req) => BASE_URL || `${req.protocol}://${req.get('host')}`;

function summarize(form, responses) {
  return form.questions.map((q, i) => {
    if (q.type === 'text') return { ...q, texts: responses.map(r => ({ name: r.name, v: r.answers[i] })).filter(x => x.v) };
    const counts = (q.options || []).map(o => ({ o, n: 0 }));
    let answered = 0;
    responses.forEach(r => {
      const v = r.answers[i]; const arr = Array.isArray(v) ? v : (v ? [v] : []);
      if (arr.length) answered++;
      arr.forEach(x => { const c = counts.find(c => c.o === x); if (c) c.n++; });
    });
    return { ...q, counts, answered };
  });
}

// ================= CLAUDE CONNECTOR (MCP) =================
const { mountMcp } = require('./mcp');
const mcp = mountMcp(app, { D, settings, todayISO, sign, baseOf });

app.get('/admin/forms', (req, res) => res.render('admin/forms', { forms: D.listForms(), baseUrl: baseOf(req), fmtDT }));
app.get('/admin/forms/new', (req, res) => res.render('admin/form-edit', {
  f: { id: '', title: '', description: '', collect_contact: 1, status: 'open', thanks: '',
       questions: [{ text: '', type: 'choice', options: ['', ''], required: true }] }, isNew: true }));
app.get('/admin/forms/edit/:id', (req, res) => {
  const f = D.getForm(req.params.id); if (!f) return res.status(404).send('לא נמצא');
  res.render('admin/form-edit', { f, isNew: false });
});
app.post('/admin/forms/save', (req, res) => {
  const b = req.body;
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'חסרה כותרת לטופס' });
  const questions = (b.questions || []).map(q => ({
    text: String(q.text || '').trim(), type: ['choice', 'multi', 'text'].includes(q.type) ? q.type : 'choice',
    options: (q.options || []).map(o => String(o).trim()).filter(Boolean), required: !!q.required,
  })).filter(q => q.text);
  if (!questions.length) return res.status(400).json({ error: 'צריך לפחות שאלה אחת' });
  const bad = questions.find(q => q.type !== 'text' && q.options.length < 2);
  if (bad) return res.status(400).json({ error: `לשאלה "${bad.text}" צריך לפחות שתי תשובות` });
  const id = D.saveForm({ id: b.id, title: b.title.trim(), description: b.description, questions, collect_contact: b.collect_contact, status: b.status, thanks: b.thanks });
  res.json({ ok: true, id });
});
app.post('/admin/forms/delete/:id', (req, res) => { D.deleteForm(req.params.id); res.redirect('/admin/forms'); });
app.post('/admin/forms/:id/response/:rid/delete', (req, res) => { D.deleteResponse(req.params.rid); res.redirect('/admin/forms/' + req.params.id + '/responses'); });
app.get('/admin/forms/:id/responses', (req, res) => {
  const f = D.getForm(req.params.id); if (!f) return res.status(404).send('לא נמצא');
  const responses = D.getResponses(f.id);
  res.render('admin/form-responses', { f, responses, summary: summarize(f, responses), baseUrl: baseOf(req), fmtDT });
});
app.get('/admin/forms/:id/export.csv', (req, res) => {
  const f = D.getForm(req.params.id); if (!f) return res.status(404).send('לא נמצא');
  const esc = (v) => '"' + String(Array.isArray(v) ? v.join(' | ') : (v ?? '')).replace(/"/g, '""') + '"';
  const head = ['תאריך', ...(f.collect_contact ? ['שם', 'טלפון'] : []), ...f.questions.map(q => q.text)];
  const rows = D.getResponses(f.id).map(r => [fmtDT(r.at), ...(f.collect_contact ? [r.name, r.phone] : []), ...f.questions.map((_, i) => r.answers[i])]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="form-${f.id}.csv"`);
  res.send('\uFEFF' + [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n'));
});

// public form
const submitAttempts = new Map();
app.get('/f/:id', (req, res) => {
  const f = D.getForm(req.params.id);
  if (!f) return res.status(404).render('form-public', { f: null, company: settings().company, error: null, done: false, values: {} });
  res.render('form-public', { f, company: settings().company, error: null, done: false, values: {} });
});
app.post('/f/:id', (req, res) => {
  const f = D.getForm(req.params.id);
  const company = settings().company;
  if (!f) return res.status(404).render('form-public', { f: null, company, error: null, done: false, values: {} });
  if (f.status !== 'open') return res.render('form-public', { f, company, error: null, done: false, values: {} });
  const key = req.ip + ':' + f.id; const a = submitAttempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 10 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (++a.n > 20) { submitAttempts.set(key, a); return res.status(429).render('form-public', { f, company, error: 'יותר מדי שליחות. נסה שוב בעוד כמה דקות.', done: false, values: req.body }); }
  submitAttempts.set(key, a);
  const answers = f.questions.map((q, i) => {
    const v = req.body['q' + i];
    if (q.type === 'multi') return (Array.isArray(v) ? v : (v ? [v] : [])).filter(x => q.options.includes(x));
    if (q.type === 'choice') return q.options.includes(v) ? v : '';
    return String(v || '').trim().slice(0, 3000);
  });
  const missing = f.questions.findIndex((q, i) => q.required && (Array.isArray(answers[i]) ? !answers[i].length : !answers[i]));
  const name = String(req.body.name || '').trim().slice(0, 120), phone = String(req.body.phone || '').trim().slice(0, 30);
  let error = null;
  if (f.collect_contact && (name.length < 2 || D.normPhone(phone).length < 9)) error = 'נא למלא שם מלא ומספר טלפון תקין';
  else if (missing >= 0) error = `נא לענות על השאלה: "${f.questions[missing].text}"`;
  if (error) return res.status(400).render('form-public', { f, company, error, done: false, values: req.body });
  D.addResponse(f.id, name, phone, answers, req.ip);
  res.render('form-public', { f, company, error: null, done: true, values: {} });
});

app.listen(PORT,() => console.log(`QuoteGen running on http://localhost:${PORT}  (admin: /admin)`));
