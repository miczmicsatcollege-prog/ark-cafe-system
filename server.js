'use strict';
// ARK Cafe ordering system: zero-dependency Node server + SQLite database.
// Requires Node 22.13+ (built-in node:sqlite). Run: node server.js
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { AO, MENU } = require('./menu-data');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const HOST = process.env.HOST || '0.0.0.0';                // use 127.0.0.1 when a reverse proxy (Caddy/nginx) is in front
const TRUST_PROXY = process.env.TRUST_PROXY === '1';       // 1 = read the client IP from X-Forwarded-For (only behind your own proxy)
const DEMO = process.env.DEMO === '1';                     // 1 = also create demo customer/employee accounts and demo orders
const RETAIN_DAYS = +process.env.PROOF_RETENTION_DAYS || 0; // >0 = delete payment screenshots of finished orders after N days
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@arkcafe.ph').trim().toLowerCase();
if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < 8) { console.error('ADMIN_PASSWORD must be at least 8 characters.'); process.exit(1); }
const SECURE = process.env.COOKIE_SECURE === '1';           // set to 1 when served over HTTPS
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'ark-cafe.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const q = (sql, ...a) => db.prepare(sql).get(...a), all = (sql, ...a) => db.prepare(sql).all(...a), run = (sql, ...a) => db.prepare(sql).run(...a);
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---------- helpers ----------
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
const hash = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const verify = (pw, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(pw, s, 64)); };
const str = (v, max, what) => { v = String(v ?? '').trim(); if (!v) bad(what + ' is required.'); if (v.length > max) bad(what + ' is too long.'); return v; };
const email = v => { v = str(v, 120, 'Email').toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) bad('Enter a valid email address.'); return v; };
const pass = v => { v = String(v ?? ''); if (v.length < 8 || v.length > 100) bad('Password must be 8 to 100 characters.'); return v; };
const price = v => { v = Number(v); if (!Number.isInteger(v) || v <= 0 || v > 100000) bad('Prices must be whole numbers above zero.'); return v; };
const getCfg = () => { const c = { name: 'ARK Cafe', hours: '', verify: true, open: true, qr: 'ARK Cafe QR', payinfo: '', qrimg: 0, qrext: '' };
  for (const r of all('SELECT key,value FROM settings')) c[r.key] = JSON.parse(r.value); return c; };
const setCfg = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(v));
const adminCount = () => q("SELECT COUNT(*) n FROM users WHERE role='Admin'").n;

// ---------- seed (first run only) ----------
let firstRunPassword = null;
if (!q('SELECT 1 x FROM users LIMIT 1')) tx(() => {
  const now = Date.now(), D = 86400000, ins = (n, e, p, r, b) => run('INSERT INTO users(name,email,password_hash,birthday,role,created_at) VALUES(?,?,?,?,?,?)', n, e, hash(p), b || null, r, now);
  let adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw) { adminPw = DEMO ? 'admin123' : crypto.randomBytes(9).toString('base64url'); if (!DEMO) firstRunPassword = adminPw; }
  if (DEMO) { ins('Juan Dela Cruz', 'juan@email.com', 'customer123', 'Customer', '2002-01-15'); ins('Maria Santos', 'maria@arkcafe.ph', 'employee123', 'Employee'); }
  ins('Admin User', ADMIN_EMAIL, adminPw, 'Admin');
  const cats = [...new Set(MENU.map(m => m.c))], cid = {};
  cats.forEach((c, i) => { cid[c] = run('INSERT INTO categories(name,position) VALUES(?,?)', c, i).lastInsertRowid; });
  MENU.forEach((m, i) => run('INSERT INTO products(category_id,name,prices,addons,position) VALUES(?,?,?,?,?)', cid[m.c], m.n, JSON.stringify(m.p), m.ao ? 1 : 0, i));
  setCfg('name', 'ARK Cafe'); setCfg('hours', ''); setCfg('verify', true); setCfg('open', true); setCfg('qr', 'ARK Cafe QR'); setCfg('order_seq', DEMO ? 43 : 0);
  const demo = !DEMO ? [] : [['ARK-0040', 'online', 'SEED', 290, 'ready', now - 7200000, [['Spanish Latte', 'Iced', 145, 2]]],
    ['ARK-0041', 'cash', '', 190, 'ready', now - 3 * D, [['Pork BBQ', 'Regular', 199, 1]]],
    ['ARK-0042', 'cash', '', 320, 'ready', now - 12 * D, [['Nachos', 'Regular', 180, 1], ['Caramel Latte', 'Hot', 150, 1]]],
    ['ARK-0043', 'online', '0012 3456 7890', 145, 'pending', now - 60000, [['Spanish Latte', 'Iced', 145, 1]]]];
  for (const [id, pay, ref, total, st, at, items] of demo) {
    run('INSERT INTO orders(id,user_id,payment,reference,total,status,created_at) VALUES(?,?,?,?,?,?,?)', id, 1, pay, ref, total, st, at);
    for (const [n, v, p, qy] of items) run('INSERT INTO order_items(order_id,name,variant,unit_price,qty) VALUES(?,?,?,?,?)', id, n, v, p, qy);
  }
});

if (firstRunPassword) console.log(`\n=== FIRST RUN ===\nAdmin login: ${ADMIN_EMAIL}\nPassword:    ${firstRunPassword}\nShown only once. Sign in and change it under Account.\n=================\n`);

// ---------- sessions, rate limiting ----------
const parseCookies = h => Object.fromEntries((h || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
const userFor = req => { const t = parseCookies(req.headers.cookie).sid; return t ? q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?', t, Date.now()) : null; };
const startSession = (res, uid) => { const t = crypto.randomBytes(32).toString('hex'); run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', t, uid, Date.now() + 7 * 86400000);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${SECURE ? '; Secure' : ''}`); };
const buckets = new Map();
const recent = (key, ms) => { const now = Date.now(), a = (buckets.get(key) || []).filter(t => now - t < ms); buckets.set(key, a); return a; };
const guard = (key, max, ms, count = true) => { const a = recent(key, ms); if (a.length >= max) bad('Too many attempts. Try again in a few minutes.', 429); if (count) a.push(Date.now()); };
const clientIp = req => { if (TRUST_PROXY) { const xf = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean); if (xf.length) return xf[xf.length - 1]; } return req.socket.remoteAddress || '?'; };
const clearCookie = () => 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (SECURE ? '; Secure' : '');
const DUMMY_HASH = hash('not-a-real-password');   // so unknown emails take as long to reject as wrong passwords
const sniff = b => b.length > 12 && (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : null);
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(SECURE ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) };
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, bday: u.birthday || '' });

// ---------- data for the client ----------
function orderRows(where, ...a) {
  const sub = `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT 500`, items = new Map();
  const rows = all(`SELECT * FROM (${sub}) ORDER BY created_at`, ...a);
  for (const it of all(`SELECT order_id oid,name n,variant t,unit_price p,qty q FROM order_items WHERE order_id IN (SELECT id FROM (${sub})) ORDER BY id`, ...a)) {
    if (!items.has(it.oid)) items.set(it.oid, []); items.get(it.oid).push({ n: it.n, t: it.t, p: it.p, q: it.q }); }
  return rows.map(o => ({ id: o.id, uid: o.user_id, pay: o.payment, ref: o.reference || '', proof: o.proof || '', note: o.note || '', total: o.total, status: o.status, at: o.created_at, items: items.get(o.id) || [] }));
}
const ordersFor = u => u.role !== 'Customer' ? orderRows('') : orderRows('WHERE user_id=?', u.id);
function bootstrap(u) {
  const cfg = getCfg(), pub = { name: cfg.name, hours: cfg.hours, verify: cfg.verify, open: cfg.open, qr: cfg.qr, payinfo: cfg.payinfo, qrimg: cfg.qrimg };
  if (!u) return { me: null, cfg: pub, menu: [], cats: [], orders: [], users: [], exp: [] };
  const staff = u.role !== 'Customer';
  return { me: publicUser(u), cfg: pub,
    cats: all('SELECT name FROM categories ORDER BY position').map(r => r.name),
    menu: all('SELECT p.id,p.name n,c.name c,p.prices,p.addons FROM products p JOIN categories c ON c.id=p.category_id ORDER BY c.position,p.position,p.id').map(r => ({ id: r.id, n: r.n, c: r.c, p: JSON.parse(r.prices), ao: !!r.addons })),
    orders: ordersFor(u),
    users: u.role === 'Admin' ? all('SELECT * FROM users ORDER BY id').map(publicUser) : [],
    exp: staff ? all('SELECT item i,amount a,created_at at FROM expenses ORDER BY id DESC LIMIT 200') : [] };
}

// ---------- API routes ----------
const routes = [];
const on = (method, p, roles, fn) => routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, fn });
const NEXT = { pending: 'confirmed', confirmed: 'preparing', preparing: 'ready', ready: 'received' };

on('GET', '/api/bootstrap', null, c => bootstrap(c.u));
on('POST', '/api/login', null, c => {
  const k1 = 'login|' + c.ip + '|' + String(c.body.email || '').toLowerCase(), k2 = 'login|' + c.ip; guard(k1, 8, 600000, false); guard(k2, 30, 600000, false);
  const u = q('SELECT * FROM users WHERE email=?', String(c.body.email || '').trim()), pw = String(c.body.password || '');
  if (!(u ? verify(pw, u.password_hash) : (verify(pw, DUMMY_HASH), false))) { const t = Date.now(); recent(k1, 600000).push(t); recent(k2, 600000).push(t); bad('Incorrect email or password.', 401); }
  startSession(c.res, u.id); return { ok: true };
});
on('POST', '/api/signup', null, c => {
  guard('signup|' + c.ip, 10, 3600000);
  const b = c.body, e = email(b.email);
  if (q('SELECT 1 x FROM users WHERE email=?', e)) bad('That email is already registered.', 409);
  const id = run('INSERT INTO users(name,email,password_hash,birthday,role,created_at) VALUES(?,?,?,?,?,?)', str(b.name, 80, 'Name'), e, hash(pass(b.password)), b.birthday || null, 'Customer', Date.now()).lastInsertRowid;
  startSession(c.res, id); return { ok: true };
});
on('POST', '/api/logout', ['*'], c => { const t = parseCookies(c.req.headers.cookie).sid; run('DELETE FROM sessions WHERE token=?', t); c.res.setHeader('Set-Cookie', clearCookie()); return { ok: true }; });

on('PUT', '/api/account', ['*'], c => {
  const b = c.body, e = email(b.email);
  if (q('SELECT 1 x FROM users WHERE email=? AND id<>?', e, c.u.id)) bad('That email is already registered.', 409);
  run('UPDATE users SET name=?,email=?,birthday=? WHERE id=?', str(b.name, 80, 'Name'), e, b.birthday || null, c.u.id);
  if (b.password) { run('UPDATE users SET password_hash=? WHERE id=?', hash(pass(b.password)), c.u.id); run('DELETE FROM sessions WHERE user_id=? AND token<>?', c.u.id, parseCookies(c.req.headers.cookie).sid || ''); }
  return { ok: true };
});
on('DELETE', '/api/account', ['*'], c => {
  if (c.u.role === 'Admin' && adminCount() < 2) bad('You are the only admin. Create another admin first.');
  run('DELETE FROM users WHERE id=?', c.u.id); c.res.setHeader('Set-Cookie', clearCookie()); return { ok: true };
});

on('POST', '/api/orders', ['Customer'], c => {
  guard('order|' + c.u.id, 20, 3600000);
  const cfg = getCfg(), b = c.body;
  if (!cfg.open) bad('Online ordering is currently turned off.', 403);
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) bad('Your order is empty.');
  if (!['cash', 'online'].includes(b.pay)) bad('Choose a payment method.');
  const note = String(b.note || '').trim().slice(0, 200), lines = [];
  let total = 0;
  for (const it of b.items) {
    const p = q('SELECT * FROM products WHERE id=?', Number(it.id)); if (!p) bad('An item is no longer on the menu.');
    const prices = JSON.parse(p.prices), unit = prices[it.t], qty = Number(it.q);
    if (!unit) bad('Invalid choice for ' + p.name + '.'); if (!Number.isInteger(qty) || qty < 1 || qty > 20) bad('Invalid quantity.');
    const extras = p.addons ? [...new Set(Array.isArray(it.ao) ? it.ao : [])].filter(k => AO[k]) : [];
    const line = unit + extras.reduce((s, k) => s + AO[k], 0);
    lines.push([p.name + (extras.length ? ' + ' + extras.join(', ') : ''), it.t, line, qty]); total += line * qty;
  }
  let ref = '', proof = null, ext = null;
  if (b.pay === 'online') {
    ref = str(b.ref, 60, 'Reference number');
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.proof || '')); if (!m) bad('Upload your payment screenshot (PNG, JPG or WebP).');
    if (m[2].length > 2.8e6) bad('The screenshot is too large (2 MB max).');
    proof = Buffer.from(m[2], 'base64'); ext = sniff(proof) || bad('That file is not a valid PNG, JPG or WebP image.');
  }
  return tx(() => {
    const seq = (JSON.parse(q("SELECT value FROM settings WHERE key='order_seq'")?.value || '0')) + 1; setCfg('order_seq', seq);
    const id = 'ARK-' + String(seq).padStart(4, '0'); let url = null;
    if (proof) { const f = id + '.' + ext; fs.writeFileSync(path.join(DATA, 'uploads', f), proof); url = '/uploads/' + f; }
    run('INSERT INTO orders(id,user_id,payment,reference,proof,note,total,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, c.u.id, b.pay, ref, url, note, total, cfg.verify ? 'pending' : 'confirmed', Date.now());
    for (const [n, v, p, qy] of lines) run('INSERT INTO order_items(order_id,name,variant,unit_price,qty) VALUES(?,?,?,?,?)', id, n, v, p, qy);
    return { id };
  });
});
on('POST', '/api/orders/:id/status', ['*'], c => {
  const o = q('SELECT * FROM orders WHERE id=?', c.params.id); if (!o) bad('Order not found.', 404);
  const staff = c.u.role !== 'Customer', a = c.body.action;
  if (!staff && o.user_id !== c.u.id) bad('Order not found.', 404);
  let next;
  if (a === 'receive') { if (o.status !== 'ready') bad('Only orders that are ready can be marked as received.'); next = 'received'; }
  else if (!staff) bad('Not allowed.', 403);
  else if (a === 'reject') { if (o.status !== 'pending') bad('Only pending orders can be rejected.'); next = 'rejected'; }
  else if (a === 'advance') { next = NEXT[o.status]; if (!next || next === 'received') bad('This order cannot be advanced.'); }
  else bad('Unknown action.');
  run('UPDATE orders SET status=? WHERE id=?', next, o.id); return { status: next };
});

on('POST', '/api/expenses', ['Employee', 'Admin'], c => { run('INSERT INTO expenses(item,amount,user_id,created_at) VALUES(?,?,?,?)', str(c.body.item, 80, 'Item'), price(c.body.amount), c.u.id, Date.now()); return { ok: true }; });
on('PUT', '/api/settings', ['Admin'], c => {
  const b = c.body;
  if ('name' in b) setCfg('name', str(b.name, 60, 'Cafe name'));
  if ('hours' in b) setCfg('hours', String(b.hours).slice(0, 80));
  if ('qr' in b) setCfg('qr', String(b.qr).slice(0, 60));
  if ('payinfo' in b) setCfg('payinfo', String(b.payinfo).trim().slice(0, 120));
  for (const k of ['verify', 'open']) if (k in b) setCfg(k, !!b[k]);
  return { ok: true };
});

const removeQr = () => { for (const e of Object.keys(MIME)) try { fs.unlinkSync(path.join(DATA, 'uploads', 'qr.' + e)); } catch {} };
on('POST', '/api/settings/qr', ['Admin'], c => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(c.body.image || '')); if (!m) bad('Upload a PNG, JPG or WebP image of your QR code.');
  if (m[2].length > 2.8e6) bad('The image is too large (2 MB max).');
  const buf = Buffer.from(m[2], 'base64'), ext = sniff(buf) || bad('That file is not a valid PNG, JPG or WebP image.');
  tx(() => { removeQr(); fs.writeFileSync(path.join(DATA, 'uploads', 'qr.' + ext), buf); setCfg('qrext', ext); setCfg('qrimg', Date.now()); }); return { ok: true };
});
on('DELETE', '/api/settings/qr', ['Admin'], c => { removeQr(); setCfg('qrimg', 0); return { ok: true }; });
on('GET', '/api/orders', ['*'], c => ({ orders: ordersFor(c.u), open: getCfg().open }));   // lightweight refresh used by the app every few seconds

const prices = p => { const o = {}; for (const k of ['Hot', 'Iced', 'Regular']) if (p && p[k]) o[k] = price(p[k]); if (!Object.keys(o).length) bad('Enter at least one price.'); return JSON.stringify(o); };
const catId = n => (q('SELECT id FROM categories WHERE name=?', String(n || '')) || bad('Choose a category.')).id;
on('POST', '/api/products', ['Admin'], c => { run('INSERT INTO products(category_id,name,prices,addons,position) VALUES(?,?,?,0,?)', catId(c.body.category), str(c.body.name, 80, 'Name'), prices(c.body.prices), Date.now()); return { ok: true }; });
on('PUT', '/api/products/:id', ['Admin'], c => { run('UPDATE products SET category_id=?,name=?,prices=? WHERE id=?', catId(c.body.category), str(c.body.name, 80, 'Name'), prices(c.body.prices), +c.params.id); return { ok: true }; });
on('DELETE', '/api/products/:id', ['Admin'], c => { run('DELETE FROM products WHERE id=?', +c.params.id); return { ok: true }; });

on('POST', '/api/categories', ['Admin'], c => {
  const n = str(c.body.name, 60, 'Category name'); if (q('SELECT 1 x FROM categories WHERE name=?', n)) bad('That category already exists.', 409);
  run('INSERT INTO categories(name,position) VALUES(?,?)', n, (q('SELECT MAX(position) m FROM categories').m ?? -1) + 1); return { ok: true };
});
on('PUT', '/api/categories', ['Admin'], c => {
  const n = str(c.body.name, 60, 'Category name'), id = catId(c.body.old);
  if (q('SELECT 1 x FROM categories WHERE name=? AND id<>?', n, id)) bad('That category already exists.', 409);
  run('UPDATE categories SET name=? WHERE id=?', n, id); return { ok: true };
});
on('DELETE', '/api/categories', ['Admin'], c => {
  const id = catId(c.body.name); if (q('SELECT 1 x FROM products WHERE category_id=?', id)) bad('This category still has items. Move or remove them first.');
  run('DELETE FROM categories WHERE id=?', id); return { ok: true };
});
on('POST', '/api/categories/up', ['Admin'], c => {
  const cur = q('SELECT * FROM categories WHERE name=?', String(c.body.name || '')), prev = cur && q('SELECT * FROM categories WHERE position<? ORDER BY position DESC LIMIT 1', cur.position);
  if (cur && prev) tx(() => { run('UPDATE categories SET position=? WHERE id=?', -1, cur.id); run('UPDATE categories SET position=? WHERE id=?', cur.position, prev.id); run('UPDATE categories SET position=? WHERE id=?', prev.position, cur.id); });
  return { ok: true };
});

const ROLES = ['Customer', 'Employee', 'Admin'];
on('POST', '/api/users', ['Admin'], c => {
  const b = c.body, e = email(b.email); if (!ROLES.includes(b.role)) bad('Choose a role.');
  if (q('SELECT 1 x FROM users WHERE email=?', e)) bad('That email is already registered.', 409);
  run('INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)', str(b.name, 80, 'Name'), e, hash(pass(b.password)), b.role, Date.now()); return { ok: true };
});
on('PUT', '/api/users/:id', ['Admin'], c => {
  const b = c.body, id = +c.params.id, u = q('SELECT * FROM users WHERE id=?', id), e = email(b.email); if (!u) bad('User not found.', 404);
  if (!ROLES.includes(b.role)) bad('Choose a role.');
  if (u.role === 'Admin' && b.role !== 'Admin' && adminCount() < 2) bad('There must be at least one admin.');
  if (q('SELECT 1 x FROM users WHERE email=? AND id<>?', e, id)) bad('That email is already registered.', 409);
  run('UPDATE users SET name=?,email=?,role=? WHERE id=?', str(b.name, 80, 'Name'), e, b.role, id);
  if (b.password) { run('UPDATE users SET password_hash=? WHERE id=?', hash(pass(b.password)), id); run('DELETE FROM sessions WHERE user_id=? AND token<>?', id, id === c.u.id ? (parseCookies(c.req.headers.cookie).sid || '') : ''); }
  return { ok: true };
});
on('DELETE', '/api/users/:id', ['Admin'], c => {
  const id = +c.params.id; if (id === c.u.id) bad('You can\u2019t delete the account you\u2019re signed in with.');
  run('DELETE FROM users WHERE id=?', id); return { ok: true };
});

// ---------- HTTP server ----------
const readBody = req => new Promise((ok, no) => { let n = 0; const ch = [];
  req.on('data', d => { n += d.length; if (n > 4e6) { no(new HttpError(413, 'Upload too large.')); req.destroy(); } else ch.push(d); });
  req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch)) : {}); } catch { no(new HttpError(400, 'Invalid request.')); } }); req.on('error', no); });
const send = (res, s, body, type = 'application/json', cache = 'no-store') => { res.writeHead(s, { 'Content-Type': type, 'Cache-Control': cache, ...SEC }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), u = userFor(req);
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/health') { q('SELECT 1 x'); return send(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/logo.png') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'logo.png')), 'image/png', 'public, max-age=86400');
    if (req.method === 'GET' && url.pathname === '/qr') {      // the payment QR is meant to be shown to customers
      const cfg = getCfg(); if (!cfg.qrimg || !MIME[cfg.qrext]) return send(res, 404, { error: 'Not found' });
      try { return send(res, 200, fs.readFileSync(path.join(DATA, 'uploads', 'qr.' + cfg.qrext)), MIME[cfg.qrext]); } catch { return send(res, 404, { error: 'Not found' }); }
    }
    const up = /^\/uploads\/(ARK-\d+\.(png|jpg|webp))$/.exec(url.pathname);
    if (req.method === 'GET' && up) {
      const o = q('SELECT user_id FROM orders WHERE id=?', up[1].split('.')[0]);
      if (!u || !o || (u.role === 'Customer' && o.user_id !== u.id)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, fs.readFileSync(path.join(DATA, 'uploads', up[1])), { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[up[2]]);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) bad('Invalid request.', 415);
    const r = routes.map(r => ({ r, m: r.re.exec(url.pathname) })).find(x => x.m && x.r.method === req.method);
    if (!r) bad('Not found.', 404);
    if (r.r.roles) { if (!u) bad('Please sign in.', 401); if (!r.r.roles.includes('*') && !r.r.roles.includes(u.role)) bad('Not allowed.', 403); }
    const body = req.method === 'GET' ? {} : await readBody(req);
    send(res, 200, r.r.fn({ u, body, params: r.m.groups || {}, req, res, ip: clientIp(req) }) ?? { ok: true });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong.' });
  }
}).listen(PORT, HOST, () => console.log(`ARK Cafe running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));

// ---------- housekeeping: expired sessions, rate-limit memory, old payment screenshots ----------
const maintain = () => {
  try {
    run('DELETE FROM sessions WHERE expires_at<?', Date.now());
    for (const [k, a] of buckets) { const f = a.filter(t => Date.now() - t < 3600000); f.length ? buckets.set(k, f) : buckets.delete(k); }
    if (RETAIN_DAYS > 0) for (const o of all("SELECT id,proof FROM orders WHERE proof IS NOT NULL AND status IN('received','rejected') AND created_at<?", Date.now() - RETAIN_DAYS * 86400000)) {
      try { fs.unlinkSync(path.join(DATA, 'uploads', path.basename(o.proof))); } catch {} run('UPDATE orders SET proof=NULL WHERE id=?', o.id); }
  } catch (e) { console.error('Housekeeping failed:', e); }
};
maintain(); const timer = setInterval(maintain, 3600000); timer.unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch {} process.exit(0); });
