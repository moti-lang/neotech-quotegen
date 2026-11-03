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
app.get('/admin/settings', (req, res) => res.render('admin/settings', { S: settings(), nextSeq: D.getSetting('next_seq', '79'), prefix: D.getSetting('prefix', 'HM'), saved: req.query.saved }));
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

app.listen(PORT, () => console.log(`QuoteGen running on http://localhost:${PORT}  (admin: /admin)`));
