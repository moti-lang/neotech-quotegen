// מחבר (MCP) ל-Claude: מאפשר ליצור ולערוך הצעות מחיר מתוך צ'אט ב-Claude.
// הכתובת: /mcp/<token>  – הטוקן נגזר מ-SECRET ומוצג במסך ההגדרות (רק למנהל).
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
// מספר שמתקבל גם כטקסט ("9,000") – Claude לפעמים שולח כך
const num = () => z.preprocess(v => (v === '' || v === null) ? undefined : (typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : v), z.number());

function mountMcp(app, { D, settings, todayISO, sign, baseOf }) {
  const token = sign('mcp-connector').slice(0, 40);

  const Component = z.object({
    name: z.string().describe('שם הרכיב'),
    desc: z.string().optional().describe('מה הרכיב עושה, 1–3 משפטים'),
    price: num().describe('מחיר בש"ח לפני מע"מ'),
    hours: num().optional().describe('הערכת שעות (לא חובה)'),
    bullets: z.array(z.string()).optional().describe('נקודות פירוט'),
  });
  const Split = z.object({ pct: num(), label: z.string() });

  const fields = {
    client_name: z.string().optional().describe('שם הלקוח / העסק'),
    client_phone: z.string().optional().describe('טלפון הלקוח – זו הסיסמה שלו לפתיחת ההצעה'),
    title: z.string().optional().describe('כותרת ההצעה, שורה אחת'),
    description: z.string().optional().describe('פסקת תיאור המערכת, 2–5 משפטים בעברית'),
    components: z.array(Component).optional().describe('רשימת הרכיבים המלאה (מחליפה את הקיימת)'),
    outcomes: z.array(z.string()).optional().describe('"בסיום ההקמה" – מה הלקוח מקבל'),
    payment_split: z.array(Split).optional().describe('פריסת תשלומים באחוזים, סכום 100'),
    valid_days: num().optional().describe('תוקף בימים'),
    vat: num().optional().describe('אחוז מע"מ'),
    line_label: z.string().optional().describe('שם השורה בטבלת המחיר (ברירת מחדל: הקמת המערכת)'),
  };

  const links = (req, number) => ({
    edit_link: baseOf(req) + '/admin/edit/' + number,
    client_link: baseOf(req) + '/q/' + number,
  });
  const summary = (q) => {
    const comps = q.data.components || [];
    const sub = comps.reduce((a, c) => a + Number(c.price || 0), 0);
    const vat = Number(q.data.vat ?? 18);
    return { number: q.number, status: q.status, client_name: q.client_name, client_phone: q.client_phone, title: q.title,
      issued_at: q.issued_at, valid_days: q.valid_days, components: comps.length, subtotal_before_vat: sub, total_with_vat: Math.round(sub * (1 + vat / 100)) };
  };
  const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
  const err = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
  const clean = (c) => ({ name: String(c.name).trim(), desc: String(c.desc || '').trim(), price: Math.round(Number(c.price) || 0),
    hours: c.hours ? Number(c.hours) : '', bullets: (c.bullets || []).map(s => String(s).trim()).filter(Boolean) });
  const splitOk = (s) => !s || s.reduce((a, p) => a + Number(p.pct), 0) === 100;

  function build(req) {
    const server = new McpServer({ name: 'quotes', version: '1.0.0' }, {
      instructions: 'מערכת הצעות המחיר של המשתמש. כשהמשתמש מעלה קובץ הצעת מחיר ומבקש להפוך אותו להצעה דיגיטלית: קרא את הקובץ, חלץ לקוח, טלפון, כותרת, תיאור ורכיבים עם מחיר לפני מע"מ, וקרא ל-create_quote. אל תמציא נתונים חסרים – שאל או השאר ריק. אל תכתוב "העוזר הדיגיטלי". ההצעה נוצרת כטיוטה; פרסום ללקוח רק כשהמשתמש מבקש (update_quote עם status=pending). החזר למשתמש את הקישורים.',
    });

    server.registerTool('create_quote', {
      title: 'יצירת הצעת מחיר',
      description: 'יוצר הצעת מחיר חדשה כטיוטה (הלקוח לא רואה אותה עד שמפרסמים). התנאים, השלבים ופרטי החברה נלקחים מברירות המחדל. מחירים בש"ח לפני מע"מ. מחזיר מספר הצעה, קישור לעריכה וקישור ללקוח.',
      inputSchema: { ...fields, client_name: z.string().describe('שם הלקוח / העסק'), title: z.string().describe('כותרת ההצעה'), components: z.array(Component).min(1).describe('רכיבי ההצעה') },
    }, async (a) => {
      if (!splitOk(a.payment_split)) return err('פריסת התשלומים חייבת להסתכם ב-100%.');
      const S = settings(); const number = D.nextNumber();
      D.saveQuote({ number, client_name: a.client_name.trim(), client_phone: (a.client_phone || '').trim(), title: a.title.trim(),
        status: 'draft', issued_at: todayISO(), valid_days: a.valid_days || S.valid_days,
        data: { description: a.description || '', line_label: a.line_label || 'הקמת המערכת', vat: a.vat ?? S.vat,
          components: a.components.map(clean), outcomes: a.outcomes || [], stages: S.stages,
          payment_split: a.payment_split?.length ? a.payment_split : S.payment_split, terms: S.terms, source: 'claude' } });
      const q = D.getQuote(number);
      return ok({ ...summary(q), ...links(req, number), note: q.client_phone ? 'נוצר כטיוטה. לפרסום ללקוח: update_quote עם status=pending.' : 'נוצר כטיוטה. חסר טלפון לקוח – בלעדיו הלקוח לא יוכל לפתוח את ההצעה.' });
    });

    server.registerTool('update_quote', {
      title: 'עדכון הצעת מחיר',
      description: 'מעדכן הצעה קיימת לפי מספר. שולחים רק את השדות שמשתנים. components מחליף את כל רשימת הרכיבים (קרא קודם get_quote). status: draft=טיוטה, pending=פורסם ללקוח וממתין לאישור.',
      inputSchema: { number: z.string().describe('מספר ההצעה, למשל HM-2026-0081'), ...fields,
        status: z.enum(['draft', 'pending', 'expired']).optional().describe('סטטוס ההצעה') },
    }, async (a) => {
      const q = D.getQuote(a.number); if (!q) return err('הצעה ' + a.number + ' לא נמצאה.');
      if (!splitOk(a.payment_split)) return err('פריסת התשלומים חייבת להסתכם ב-100%.');
      const phone = a.client_phone !== undefined ? a.client_phone.trim() : q.client_phone;
      if (a.status === 'pending' && D.normPhone(phone).length < 9) return err('אי אפשר לפרסם בלי טלפון לקוח תקין – הוא הסיסמה לכניסה.');
      for (const k of ['description', 'outcomes', 'payment_split', 'vat', 'line_label']) if (a[k] !== undefined) q.data[k] = a[k];
      if (a.components) q.data.components = a.components.map(clean);
      D.saveQuote({ number: q.number, client_name: (a.client_name ?? q.client_name).trim(), client_phone: phone, title: (a.title ?? q.title).trim(),
        status: a.status || q.status, issued_at: q.issued_at, valid_days: a.valid_days || q.valid_days, data: q.data });
      return ok({ ...summary(D.getQuote(q.number)), ...links(req, q.number) });
    });

    server.registerTool('get_quote', {
      title: 'הצגת הצעת מחיר', description: 'מחזיר את כל פרטי ההצעה, כולל רכיבים, פריסת תשלומים, צפיות ואישור הלקוח.',
      inputSchema: { number: z.string() }, annotations: { readOnlyHint: true },
    }, async ({ number }) => {
      const q = D.getQuote(number); if (!q) return err('הצעה ' + number + ' לא נמצאה.');
      const views = D.getViews(number);
      return ok({ ...summary(q), description: q.data.description, components: (q.data.components || []).map(c => ({ ...c, price: Number(c.price) || 0, hours: Number(c.hours) || 0 })), outcomes: q.data.outcomes,
        payment_split: q.data.payment_split, vat: q.data.vat, approval: D.getApproval(number) || null,
        successful_views: views.filter(v => v.ok).length, last_view: views[0]?.at || null, ...links(req, number) });
    });

    server.registerTool('list_quotes', {
      title: 'רשימת הצעות מחיר', description: 'רשימת ההצעות האחרונות עם סטטוס, סכום, צפיות ואישור.',
      inputSchema: { limit: z.number().optional().describe('כמה להחזיר, ברירת מחדל 20') }, annotations: { readOnlyHint: true },
    }, async ({ limit }) => ok(D.listQuotes().slice(0, limit || 20).map(q => ({ number: q.number, client_name: q.client_name, title: q.title,
      status: q.approved ? 'approved' : q.status, issued_at: q.issued_at, views: q.views, approved_by: q.approved?.signer_name || null }))));

    server.registerTool('get_form_responses', {
      title: 'תשובות לטופס', description: 'בלי form_id: רשימת הטפסים. עם form_id: כל התשובות לטופס.',
      inputSchema: { form_id: z.string().optional() }, annotations: { readOnlyHint: true },
    }, async ({ form_id }) => {
      if (!form_id) return ok(D.listForms().map(f => ({ id: f.id, title: f.title, status: f.status, responses: f.count })));
      const f = D.getForm(form_id); if (!f) return err('טופס לא נמצא.');
      return ok({ title: f.title, questions: f.questions.map(q => q.text),
        responses: D.getResponses(f.id).map(r => ({ at: r.at, name: r.name, phone: r.phone, answers: r.answers })) });
    });
    return server;
  }

  app.post('/mcp/:token', async (req, res) => {
    if (req.params.token !== token) return res.status(404).json({ error: 'not found' });
    try {
      const server = build(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('mcp error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.all('/mcp/:token', (req, res) => res.status(req.params.token === token ? 405 : 404).set('Allow', 'POST').end());

  return { path: '/mcp/' + token };
}

module.exports = { mountMcp };
