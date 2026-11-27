
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');
const { AO, MENU } = require('./menu-data');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DEMO = process.env.DEMO === '1';
const RETAIN_DAYS = +process.env.PROOF_RETENTION_DAYS || 0;

const ADMIN_EMAIL = (
  process.env.ADMIN_EMAIL || 'admin@arkcafe.ph'
).trim().toLowerCase();

const SECURE =
  process.env.COOKIE_SECURE === '1' ||
  process.env.RENDER === 'true';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

if (
  process.env.ADMIN_PASSWORD &&
  process.env.ADMIN_PASSWORD.length < 8
) {
  throw new Error('ADMIN_PASSWORD must be at least 8 characters');
}

// PostgreSQL connection

types.setTypeParser(20, value => {
  const number = Number(value);

  if (!Number.isSafeInteger(number)) {
    throw new Error('Unsafe bigint');
  }

  return number;
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 15000
});

pool.on('error', error => {
  console.error(
    'Database connection error:',
    error.code || error.name
  );
});

const context = new AsyncLocalStorage();

const query = (sql, ...args) => {
  let index = 0;

  return (context.getStore() || pool).query(
    sql.replace(/\?/g, () => '$' + (++index)),
    args
  );
};

const q = async (sql, ...args) => {
  return (await query(sql, ...args)).rows[0];
};

const all = async (sql, ...args) => {
  return (await query(sql, ...args)).rows;
};

const run = async (sql, ...args) => {
  if (
    /^INSERT INTO (users|categories|products|order_items|expenses)\(/i.test(sql)
  ) {
    sql += ' RETURNING id';
  }

  const result = await query(sql, ...args);

  return {
    lastInsertRowid: result.rows[0]?.id,
    changes: result.rowCount
  };
};

const tx = async fn => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await context.run(client, fn);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// Helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message, status = 400) => {
  throw new HttpError(status, message);
};

const hash = password => {
  const salt = crypto.randomBytes(16).toString('hex');

  return salt + ':' +
    crypto.scryptSync(password, salt, 64).toString('hex');
};

const verify = (password, storedHash) => {
  try {
    const [salt, key] = storedHash.split(':');
    const expected = Buffer.from(key, 'hex');
    const actual = crypto.scryptSync(password, salt, 64);

    return expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
};

const str = (value, max, label) => {
  value = String(value ?? '').trim();

  if (!value) {
    bad(label + ' is required.');
  }

  if (value.length > max) {
    bad(label + ' is too long.');
  }

  return value;
};

const email = value => {
  value = str(value, 120, 'Email').toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    bad('Enter a valid email address.');
  }

  return value;
};

const pass = value => {
  value = String(value ?? '');

  if (value.length < 8 || value.length > 100) {
    bad('Password must be 8 to 100 characters.');
  }

  return value;
};

const price = value => {
  value = Number(value);

  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 100000
  ) {
    bad('Prices must be whole numbers above zero.');
  }

  return value;
};

const getCfg = async () => {
  const config = {
    name: 'ARK Cafe',
    hours: '',
    verify: true,
    open: true,
    qr: 'ARK Cafe QR',
    payinfo: '',
    qrimg: 0,
    qrext: ''
  };

  for (const row of await all(
    'SELECT key,value FROM settings'
  )) {
    config[row.key] = JSON.parse(row.value);
  }

  return config;
};

const setCfg = async (key, value) => {
  await run(
    `INSERT INTO settings(key,value)
     VALUES(?,?)
     ON CONFLICT(key)
     DO UPDATE SET value=excluded.value`,
    key,
    JSON.stringify(value)
  );
};

const adminCount = async () => {
  return (
    await q("SELECT COUNT(*) n FROM users WHERE role='Admin'")
  ).n;
};

// Database initialization

async function initialize() {
  await tx(async () => {
    await query(
      'SELECT pg_advisory_xact_lock(9284101)'
    );

    await context.getStore().query(
      fs.readFileSync(
        path.join(__dirname, 'schema.sql'),
        'utf8'
      )
    );

    await query(
      'ALTER TABLE products ALTER COLUMN position TYPE BIGINT'
    );

    await query(`
      CREATE TABLE IF NOT EXISTS uploads (
        name TEXT PRIMARY KEY,
        content BYTEA NOT NULL
      )
    `);

    if (await q('SELECT 1 x FROM users LIMIT 1')) {
      if (!await adminCount()) {
        throw new Error('No admin account in database');
      }

      console.log('Existing PostgreSQL database detected.');

      return;
    }

    if (
      await q('SELECT 1 x FROM orders LIMIT 1') ||
      await q('SELECT 1 x FROM products LIMIT 1')
    ) {
      throw new Error(
        'Database contains records but no users. Restore before starting.'
      );
    }

    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      throw new Error(
        'Set ADMIN_PASSWORD before initializing an empty database'
      );
    }

    const now = Date.now();

    const insertUser = async (
      name,
      mail,
      password,
      role,
      birthday = null
    ) => {
      await run(
        'INSERT INTO users(name,email,password_hash,birthday,role,created_at) VALUES(?,?,?,?,?,?)',
        name,
        mail,
        hash(password),
        birthday,
        role,
        now
      );
    };

    if (DEMO) {
      await insertUser(
        'Juan Dela Cruz',
        'juan@email.com',
        'customer123',
        'Customer',
        '2002-01-15'
      );

      await insertUser(
        'Maria Santos',
        'maria@arkcafe.ph',
        'employee123',
        'Employee'
      );
    }

    await insertUser(
      'Admin User',
      ADMIN_EMAIL,
      adminPassword,
      'Admin'
    );

    const categories = [
      ...new Set(MENU.map(item => item.c))
    ];

    const categoryIds = {};

    for (const [index, category] of categories.entries()) {
      categoryIds[category] = (
        await run(
          'INSERT INTO categories(name,position) VALUES(?,?)',
          category,
          index
        )
      ).lastInsertRowid;
    }

    for (const [index, item] of MENU.entries()) {
      await run(
        'INSERT INTO products(category_id,name,prices,addons,position) VALUES(?,?,?,?,?)',
        categoryIds[item.c],
        item.n,
        JSON.stringify(item.p),
        item.ao ? 1 : 0,
        index
      );
    }

    await setCfg('name', 'ARK Cafe');
    await setCfg('hours', '');
    await setCfg('verify', true);
    await setCfg('open', true);
    await setCfg('qr', 'ARK Cafe QR');
    await setCfg('order_seq', 0);

    console.log(
      'PostgreSQL database initialized successfully.'
    );

    console.log('Admin account created:', ADMIN_EMAIL);
  });
}

// Sessions and security

const parseCookies = header => {
  return Object.fromEntries(
    (header || '')
      .split(';')
      .map(value => value.trim().split('='))
      .filter(value => value[0])
      .map(([key, ...value]) => [
        key,
        value.join('=')
      ])
  );
};

const userFor = async req => {
  const token = parseCookies(req.headers.cookie).sid;

  if (!token) {
    return null;
  }

  return await q(
    `SELECT u.*
     FROM sessions s
     JOIN users u ON u.id=s.user_id
     WHERE s.token=?
     AND s.expires_at>?`,
    token,
    Date.now()
  );
};

const startSession = async (res, userId) => {
  const token = crypto.randomBytes(32).toString('hex');

  await run(
    'INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)',
    token,
    userId,
    Date.now() + 7 * 86400000
  );

  res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${SECURE ? '; Secure' : ''}`
  );
};

const buckets = new Map();

const recent = (key, milliseconds) => {
  const now = Date.now();

  const attempts = (buckets.get(key) || [])
    .filter(time => now - time < milliseconds);

  buckets.set(key, attempts);

  return attempts;
};

const guard = (
  key,
  max,
  milliseconds,
  count = true
) => {
  const attempts = recent(key, milliseconds);

  if (attempts.length >= max) {
    bad(
      'Too many attempts. Try again in a few minutes.',
      429
    );
  }

  if (count) {
    attempts.push(Date.now());
  }
};

const clientIp = req => {
  if (TRUST_PROXY) {
    const forwarded = String(
      req.headers['x-forwarded-for'] || ''
    ).split(',')
      .map(value => value.trim())
      .filter(Boolean);

    if (forwarded.length) {
      return forwarded[forwarded.length - 1];
    }
  }

  return req.socket.remoteAddress || '?';
};

const clearCookie = () => {
  return 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' +
    (SECURE ? '; Secure' : '');
};

const DUMMY_HASH = hash('not-a-real-password');

const sniff = buffer => {
  if (buffer.length <= 12) {
    return null;
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpg';
  }

  if (
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
};

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp'
};

const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(SECURE
    ? { 'Strict-Transport-Security': 'max-age=31536000' }
    : {})
};

const publicUser = user => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  bday: user.birthday || ''
});

// Data for the client

async function orderRows(where, ...args) {
  const sub = `
    SELECT * FROM orders
    ${where}
    ORDER BY created_at DESC
    LIMIT 500
  `;

  const items = new Map();

  const rows = await all(
    `SELECT * FROM (${sub}) AS recent_orders
     ORDER BY created_at`,
    ...args
  );

  for (const item of await all(
    `SELECT order_id oid,name n,variant t,
     unit_price p,qty q
     FROM order_items
     WHERE order_id IN (
       SELECT id FROM (${sub}) AS recent_orders
     )
     ORDER BY id`,
    ...args
  )) {
    if (!items.has(item.oid)) {
      items.set(item.oid, []);
    }

    items.get(item.oid).push({
      n: item.n,
      t: item.t,
      p: item.p,
      q: item.q
    });
  }

  return rows.map(order => ({
    id: order.id,
    uid: order.user_id,
    pay: order.payment,
    ref: order.reference || '',
    proof: order.proof || '',
    note: order.note || '',
    total: order.total,
    status: order.status,
    at: order.created_at,
    items: items.get(order.id) || []
  }));
}

const ordersFor = async user => {
  return user.role !== 'Customer'
    ? await orderRows('')
    : await orderRows('WHERE user_id=?', user.id);
};

async function bootstrap(user) {
  const cfg = await getCfg();

  const pub = {
    name: cfg.name,
    hours: cfg.hours,
    verify: cfg.verify,
    open: cfg.open,
    qr: cfg.qr,
    payinfo: cfg.payinfo,
    qrimg: cfg.qrimg
  };

  if (!user) {
    return {
      me: null,
      cfg: pub,
      menu: [],
      cats: [],
      orders: [],
      users: [],
      exp: []
    };
  }

  const staff = user.role !== 'Customer';

  return {
    me: publicUser(user),
    cfg: pub,

    cats: (
      await all(
        'SELECT name FROM categories ORDER BY position'
      )
    ).map(row => row.name),

    menu: (
      await all(`
        SELECT p.id,p.name n,c.name c,
        p.prices,p.addons
        FROM products p
        JOIN categories c ON c.id=p.category_id
        ORDER BY c.position,p.position,p.id
      `)
    ).map(row => ({
      id: row.id,
      n: row.n,
      c: row.c,
      p: JSON.parse(row.prices),
      ao: !!row.addons
    })),

    orders: await ordersFor(user),

    users: user.role === 'Admin'
      ? (
        await all('SELECT * FROM users ORDER BY id')
      ).map(publicUser)
      : [],

    exp: staff
      ? await all(`
        SELECT item i,amount a,created_at at
        FROM expenses
        ORDER BY id DESC
        LIMIT 200
      `)
      : []
  };
}

// API routes

const routes = [];

const on = (method, route, roles, fn) => {
  routes.push({
    method,
    re: new RegExp(
      '^' +
      route.replace(
        /:(\w+)/g,
        '(?<$1>[^/]+)'
      ) +
      '$'
    ),
    roles,
    fn
  });
};

const NEXT = {
  pending: 'confirmed',
  confirmed: 'preparing',
  preparing: 'ready',
  ready: 'received'
};

on('GET', '/api/bootstrap', null, async c => {
  return await bootstrap(c.u);
});

// Login

on('POST', '/api/login', null, async c => {
  const key1 = 'login|' + c.ip + '|' +
    String(c.body.email || '').toLowerCase();

  const key2 = 'login|' + c.ip;

  guard(key1, 8, 600000, false);
  guard(key2, 30, 600000, false);

  const user = await q(
    'SELECT * FROM users WHERE LOWER(email)=LOWER(?)',
    String(c.body.email || '').trim()
  );

  const password = String(c.body.password || '');

  if (!(
    user
      ? verify(password, user.password_hash)
      : (verify(password, DUMMY_HASH), false)
  )) {
    const time = Date.now();

    recent(key1, 600000).push(time);
    recent(key2, 600000).push(time);

    bad('Incorrect email or password.', 401);
  }

  await startSession(c.res, user.id);

  return { ok: true };
});

// Signup

on('POST', '/api/signup', null, async c => {
  guard('signup|' + c.ip, 10, 3600000);

  const b = c.body;
  const e = email(b.email);

  if (await q(
    'SELECT 1 x FROM users WHERE LOWER(email)=LOWER(?)',
    e
  )) {
    bad('That email is already registered.', 409);
  }

  const id = (
    await run(
      'INSERT INTO users(name,email,password_hash,birthday,role,created_at) VALUES(?,?,?,?,?,?)',
      str(b.name, 80, 'Name'),
      e,
      hash(pass(b.password)),
      b.birthday || null,
      'Customer',
      Date.now()
    )
  ).lastInsertRowid;

  await startSession(c.res, id);

  return { ok: true };
});

// Logout

on('POST', '/api/logout', ['*'], async c => {
  const token = parseCookies(
    c.req.headers.cookie
  ).sid;

  await run(
    'DELETE FROM sessions WHERE token=?',
    token
  );

  c.res.setHeader('Set-Cookie', clearCookie());

  return { ok: true };
});

// Account management

on('PUT', '/api/account', ['*'], async c => {
  const b = c.body;
  const e = email(b.email);

  if (await q(
    'SELECT 1 x FROM users WHERE LOWER(email)=LOWER(?) AND id<>?',
    e,
    c.u.id
  )) {
    bad('That email is already registered.', 409);
  }

  await run(
    'UPDATE users SET name=?,email=?,birthday=? WHERE id=?',
    str(b.name, 80, 'Name'),
    e,
    b.birthday || null,
    c.u.id
  );

  if (b.password) {
    await run(
      'UPDATE users SET password_hash=? WHERE id=?',
      hash(pass(b.password)),
      c.u.id
    );

    await run(
      'DELETE FROM sessions WHERE user_id=? AND token<>?',
      c.u.id,
      parseCookies(c.req.headers.cookie).sid || ''
    );
  }

  return { ok: true };
});

on('DELETE', '/api/account', ['*'], async c => {
  if (
    c.u.role === 'Admin' &&
    await adminCount() < 2
  ) {
    bad(
      'You are the only admin. Create another admin first.'
    );
  }

  await run(
    'DELETE FROM users WHERE id=?',
    c.u.id
  );

  c.res.setHeader('Set-Cookie', clearCookie());

  return { ok: true };
});

// Orders

on('POST', '/api/orders', ['Customer'], async c => {
  guard('order|' + c.u.id, 20, 3600000);

  const cfg = await getCfg();
  const b = c.body;

  if (!cfg.open) {
    bad('Online ordering is currently turned off.', 403);
  }

  if (
    !Array.isArray(b.items) ||
    !b.items.length ||
    b.items.length > 50
  ) {
    bad('Your order is empty.');
  }

  if (!['cash', 'online'].includes(b.pay)) {
    bad('Choose a payment method.');
  }

  const note = String(b.note || '')
    .trim()
    .slice(0, 200);

  const lines = [];
  let total = 0;

  for (const item of b.items) {
    const product = await q(
      'SELECT * FROM products WHERE id=?',
      Number(item.id)
    );

    if (!product) {
      bad('An item is no longer on the menu.');
    }

    const productPrices = JSON.parse(product.prices);
    const unit = productPrices[item.t];
    const qty = Number(item.q);

    if (!Number.isInteger(unit) || unit <= 0) {
      bad('Invalid choice for ' + product.name + '.');
    }

    if (
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 20
    ) {
      bad('Invalid quantity.');
    }

    const extras = product.addons
      ? [
          ...new Set(
            Array.isArray(item.ao) ? item.ao : []
          )
        ].filter(key =>
          Object.hasOwn(AO, key) &&
          Number.isFinite(AO[key])
        )
      : [];

    const line = unit + extras.reduce(
      (sum, key) => sum + AO[key],
      0
    );

    lines.push([
      product.name +
        (extras.length
          ? ' + ' + extras.join(', ')
          : ''),
      item.t,
      line,
      qty
    ]);

    total += line * qty;
  }

  let ref = '';
  let proof = null;
  let ext = null;

  if (b.pay === 'online') {
    ref = str(b.ref, 60, 'Reference number');

    const match =
      /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/
      .exec(String(b.proof || ''));

    if (!match) {
      bad('Upload your payment screenshot (PNG, JPG or WebP).');
    }

    if (match[2].length > 2.8e6) {
      bad('The screenshot is too large (2 MB max).');
    }

    proof = Buffer.from(match[2], 'base64');

    ext = sniff(proof) ||
      bad('That file is not a valid PNG, JPG or WebP image.');
  }

  return await tx(async () => {
    const current = await q(
      "SELECT value FROM settings WHERE key='order_seq' FOR UPDATE"
    );

    const seq = JSON.parse(
      current?.value || '0'
    ) + 1;

    await setCfg('order_seq', seq);

    const id = 'ARK-' + String(seq).padStart(4, '0');

    let url = null;

    if (proof) {
      const filename = id + '.' + ext;

      await run(
        'INSERT INTO uploads(name,content) VALUES(?,?)',
        filename,
        proof
      );

      url = '/uploads/' + filename;
    }

    await run(
      'INSERT INTO orders(id,user_id,payment,reference,proof,note,total,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      c.u.id,
      b.pay,
      ref,
      url,
      note,
      total,
      cfg.verify ? 'pending' : 'confirmed',
      Date.now()
    );

    for (const [name, variant, unitPrice, qty] of lines) {
      await run(
        'INSERT INTO order_items(order_id,name,variant,unit_price,qty) VALUES(?,?,?,?,?)',
        id,
        name,
        variant,
        unitPrice,
        qty
      );
    }

    return { id };
  });
});

on('POST', '/api/orders/:id/status', ['*'], async c => {
  const order = await q(
    'SELECT * FROM orders WHERE id=?',
    c.params.id
  );

  if (!order) {
    bad('Order not found.', 404);
  }

  const staff = c.u.role !== 'Customer';
  const action = c.body.action;

  if (!staff && order.user_id !== c.u.id) {
    bad('Order not found.', 404);
  }

  let next;

  if (action === 'receive') {
    if (order.status !== 'ready') {
      bad('Only orders that are ready can be marked as received.');
    }

    next = 'received';
  } else if (!staff) {
    bad('Not allowed.', 403);
  } else if (action === 'reject') {
    if (order.status !== 'pending') {
      bad('Only pending orders can be rejected.');
    }

    next = 'rejected';
  } else if (action === 'advance') {
    next = NEXT[order.status];

    if (!next || next === 'received') {
      bad('This order cannot be advanced.');
    }
  } else {
    bad('Unknown action.');
  }

  const result = await run(
    'UPDATE orders SET status=? WHERE id=? AND status=?',
    next,
    order.id,
    order.status
  );

  if (!result.changes) {
    bad('Order status changed. Refresh and try again.', 409);
  }

  return { status: next };
});

on('GET', '/api/orders', ['*'], async c => ({
  orders: await ordersFor(c.u),
  open: (await getCfg()).open
}));

// Expenses

on(
  'POST',
  '/api/expenses',
  ['Employee', 'Admin'],
  async c => {
    await run(
      'INSERT INTO expenses(item,amount,user_id,created_at) VALUES(?,?,?,?)',
      str(c.body.item, 80, 'Item'),
      price(c.body.amount),
      c.u.id,
      Date.now()
    );

    return { ok: true };
  }
);

// System settings

on('PUT', '/api/settings', ['Admin'], async c => {
  const b = c.body;

  if ('name' in b) {
    await setCfg(
      'name',
      str(b.name, 60, 'Cafe name')
    );
  }

  if ('hours' in b) {
    await setCfg(
      'hours',
      String(b.hours).slice(0, 80)
    );
  }

  if ('qr' in b) {
    await setCfg(
      'qr',
      String(b.qr).slice(0, 60)
    );
  }

  if ('payinfo' in b) {
    await setCfg(
      'payinfo',
      String(b.payinfo).trim().slice(0, 120)
    );
  }

  for (const key of ['verify', 'open']) {
    if (key in b) {
      await setCfg(key, !!b[key]);
    }
  }

  return { ok: true };
});

// Permanent QR code storage

const removeQr = async () => {
  await run(
    "DELETE FROM uploads WHERE name IN ('qr.png','qr.jpg','qr.webp')"
  );
};

on('POST', '/api/settings/qr', ['Admin'], async c => {
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/
    .exec(String(c.body.image || ''));

  if (!match) {
    bad('Upload a PNG, JPG or WebP image of your QR code.');
  }

  if (match[2].length > 2.8e6) {
    bad('The image is too large (2 MB max).');
  }

  const buffer = Buffer.from(match[2], 'base64');

  const ext = sniff(buffer) ||
    bad('That file is not a valid PNG, JPG or WebP image.');

  await tx(async () => {
    await query(
      'SELECT pg_advisory_xact_lock(9284102)'
    );

    await removeQr();

    await run(
      'INSERT INTO uploads(name,content) VALUES(?,?)',
      'qr.' + ext,
      buffer
    );

    await setCfg('qrext', ext);
    await setCfg('qrimg', Date.now());
  });

  return { ok: true };
});

on('DELETE', '/api/settings/qr', ['Admin'], async c => {
  await tx(async () => {
    await query(
      'SELECT pg_advisory_xact_lock(9284102)'
    );

    await removeQr();
    await setCfg('qrimg', 0);
  });

  return { ok: true };
});

// Product management

const prices = value => {
  const result = {};

  for (const key of ['Hot', 'Iced', 'Regular']) {
    if (value && value[key]) {
      result[key] = price(value[key]);
    }
  }

  if (!Object.keys(result).length) {
    bad('Enter at least one price.');
  }

  return JSON.stringify(result);
};

const catId = async name => {
  const category = await q(
    'SELECT id FROM categories WHERE LOWER(name)=LOWER(?)',
    String(name || '')
  );

  if (!category) {
    bad('Choose a category.');
  }

  return category.id;
};

on('POST', '/api/products', ['Admin'], async c => {
  await run(
    'INSERT INTO products(category_id,name,prices,addons,position) VALUES(?,?,?,0,?)',
    await catId(c.body.category),
    str(c.body.name, 80, 'Name'),
    prices(c.body.prices),
    Date.now()
  );

  return { ok: true };
});

on('PUT', '/api/products/:id', ['Admin'], async c => {
  await run(
    'UPDATE products SET category_id=?,name=?,prices=? WHERE id=?',
    await catId(c.body.category),
    str(c.body.name, 80, 'Name'),
    prices(c.body.prices),
    +c.params.id
  );

  return { ok: true };
});

on('DELETE', '/api/products/:id', ['Admin'], async c => {
  await run(
    'DELETE FROM products WHERE id=?',
    +c.params.id
  );

  return { ok: true };
});

// Category management

on('POST', '/api/categories', ['Admin'], async c => {
  const name = str(c.body.name, 60, 'Category name');

  if (await q(
    'SELECT 1 x FROM categories WHERE LOWER(name)=LOWER(?)',
    name
  )) {
    bad('That category already exists.', 409);
  }

  const max = await q(
    'SELECT MAX(position) m FROM categories'
  );

  await run(
    'INSERT INTO categories(name,position) VALUES(?,?)',
    name,
    (max.m ?? -1) + 1
  );

  return { ok: true };
});

on('PUT', '/api/categories', ['Admin'], async c => {
  const name = str(c.body.name, 60, 'Category name');
  const id = await catId(c.body.old);

  if (await q(
    'SELECT 1 x FROM categories WHERE LOWER(name)=LOWER(?) AND id<>?',
    name,
    id
  )) {
    bad('That category already exists.', 409);
  }

  await run(
    'UPDATE categories SET name=? WHERE id=?',
    name,
    id
  );

  return { ok: true };
});

on('DELETE', '/api/categories', ['Admin'], async c => {
  const id = await catId(c.body.name);

  if (await q(
    'SELECT 1 x FROM products WHERE category_id=?',
    id
  )) {
    bad(
      'This category still has items. Move or remove them first.'
    );
  }

  await run(
    'DELETE FROM categories WHERE id=?',
    id
  );

  return { ok: true };
});

on('POST', '/api/categories/up', ['Admin'], async c => {
  const current = await q(
    'SELECT * FROM categories WHERE LOWER(name)=LOWER(?)',
    String(c.body.name || '')
  );

  const previous = current && await q(
    'SELECT * FROM categories WHERE position<? ORDER BY position DESC LIMIT 1',
    current.position
  );

  if (current && previous) {
    await tx(async () => {
      await run(
        'UPDATE categories SET position=? WHERE id=?',
        -1,
        current.id
      );

      await run(
        'UPDATE categories SET position=? WHERE id=?',
        current.position,
        previous.id
      );

      await run(
        'UPDATE categories SET position=? WHERE id=?',
        previous.position,
        current.id
      );
    });
  }

  return { ok: true };
});

// User management

const ROLES = [
  'Customer',
  'Employee',
  'Admin'
];

on('POST', '/api/users', ['Admin'], async c => {
  const b = c.body;
  const e = email(b.email);

  if (!ROLES.includes(b.role)) {
    bad('Choose a role.');
  }

  if (await q(
    'SELECT 1 x FROM users WHERE LOWER(email)=LOWER(?)',
    e
  )) {
    bad('That email is already registered.', 409);
  }

  await run(
    'INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)',
    str(b.name, 80, 'Name'),
    e,
    hash(pass(b.password)),
    b.role,
    Date.now()
  );

  return { ok: true };
});

on('PUT', '/api/users/:id', ['Admin'], async c => {
  const b = c.body;
  const id = +c.params.id;
  const user = await q(
    'SELECT * FROM users WHERE id=?',
    id
  );

  const e = email(b.email);

  if (!user) {
    bad('User not found.', 404);
  }

  if (!ROLES.includes(b.role)) {
    bad('Choose a role.');
  }

  if (
    user.role === 'Admin' &&
    b.role !== 'Admin' &&
    await adminCount() < 2
  ) {
    bad('There must be at least one admin.');
  }

  if (await q(
    'SELECT 1 x FROM users WHERE LOWER(email)=LOWER(?) AND id<>?',
    e,
    id
  )) {
    bad('That email is already registered.', 409);
  }

  await run(
    'UPDATE users SET name=?,email=?,role=? WHERE id=?',
    str(b.name, 80, 'Name'),
    e,
    b.role,
    id
  );

  if (b.password) {
    await run(
      'UPDATE users SET password_hash=? WHERE id=?',
      hash(pass(b.password)),
      id
    );

    await run(
      'DELETE FROM sessions WHERE user_id=? AND token<>?',
      id,
      id === c.u.id
        ? (
          parseCookies(c.req.headers.cookie).sid || ''
        )
        : ''
    );
  }

  return { ok: true };
});

on('DELETE', '/api/users/:id', ['Admin'], async c => {
  const id = +c.params.id;

  if (id === c.u.id) {
    bad("You can't delete the account you're signed in with.");
  }

  await run(
    'DELETE FROM users WHERE id=?',
    id
  );

  return { ok: true };
});

// HTTP server

const readBody = req => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];

  req.on('data', data => {
    size += data.length;

    if (size > 4e6) {
      reject(
        new HttpError(413, 'Upload too large.')
      );

      req.destroy();
    } else {
      chunks.push(data);
    }
  });

  req.on('end', () => {
    try {
      resolve(
        chunks.length
          ? JSON.parse(Buffer.concat(chunks))
          : {}
      );
    } catch {
      reject(
        new HttpError(400, 'Invalid request.')
      );
    }
  });

  req.on('error', reject);
});

const send = (
  res,
  status,
  body,
  type = 'application/json',
  cache = 'no-store'
) => {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': cache,
    ...SEC
  });

  res.end(
    type === 'application/json'
      ? JSON.stringify(body)
      : body
  );
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const user = await userFor(req);

    if (
      req.method === 'GET' &&
      url.pathname === '/'
    ) {
      return send(
        res,
        200,
        fs.readFileSync(
          path.join(__dirname, 'public', 'index.html')
        ),
        'text/html; charset=utf-8'
      );
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/health'
    ) {
      await q('SELECT 1 x');

      return send(res, 200, { ok: true });
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/logo.png'
    ) {
      return send(
        res,
        200,
        fs.readFileSync(
          path.join(__dirname, 'public', 'logo.png')
        ),
        'image/png',
        'public, max-age=86400'
      );
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/qr'
    ) {
      const cfg = await getCfg();

      if (!cfg.qrimg || !MIME[cfg.qrext]) {
        return send(
          res,
          404,
          { error: 'Not found' }
        );
      }

      const image = await q(
        'SELECT content FROM uploads WHERE name=?',
        'qr.' + cfg.qrext
      );

      if (!image) {
        return send(
          res,
          404,
          { error: 'Not found' }
        );
      }

      return send(
        res,
        200,
        image.content,
        MIME[cfg.qrext]
      );
    }

    const upload =
      /^\/uploads\/(ARK-\d+\.(png|jpg|webp))$/
      .exec(url.pathname);

    if (req.method === 'GET' && upload) {
      const order = await q(
        'SELECT user_id FROM orders WHERE id=?',
        upload[1].split('.')[0]
      );

      if (
        !user ||
        !order ||
        (
          user.role === 'Customer' &&
          order.user_id !== user.id
        )
      ) {
        return send(
          res,
          404,
          { error: 'Not found' }
        );
      }

      const image = await q(
        'SELECT content FROM uploads WHERE name=?',
        upload[1]
      );

      if (!image) {
        return send(
          res,
          404,
          { error: 'Not found' }
        );
      }

      return send(
        res,
        200,
        image.content,
        MIME[upload[2]]
      );
    }

    if (!url.pathname.startsWith('/api/')) {
      return send(
        res,
        404,
        { error: 'Not found' }
      );
    }

    if (
      req.method !== 'GET' &&
      !(req.headers['content-type'] || '')
        .startsWith('application/json')
    ) {
      bad('Invalid request.', 415);
    }

    const route = routes
      .map(r => ({
        r,
        m: r.re.exec(url.pathname)
      }))
      .find(
        item =>
          item.m &&
          item.r.method === req.method
      );

    if (!route) {
      bad('Not found.', 404);
    }

    if (route.r.roles) {
      if (!user) {
        bad('Please sign in.', 401);
      }

      if (
        !route.r.roles.includes('*') &&
        !route.r.roles.includes(user.role)
      ) {
        bad('Not allowed.', 403);
      }
    }

    const body = req.method === 'GET'
      ? {}
      : await readBody(req);

    const result = await route.r.fn({
      u: user,
      body,
      params: route.m.groups || {},
      req,
      res,
      ip: clientIp(req)
    });

    send(
      res,
      200,
      result ?? { ok: true }
    );
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error(
        'Request failed:',
        error.code || error.name
      );
    }

    if (error.code === '23505') {
      return send(
        res,
        409,
        { error: 'Record already exists.' }
      );
    }

    send(
      res,
      error.status || 500,
      {
        error: error.status
          ? error.message
          : 'Something went wrong.'
      }
    );
  }
});

// Housekeeping

const maintain = async () => {
  try {
    await run(
      'DELETE FROM sessions WHERE expires_at<?',
      Date.now()
    );

    for (const [key, attempts] of buckets) {
      const filtered = attempts.filter(
        time => Date.now() - time < 3600000
      );

      if (filtered.length) {
        buckets.set(key, filtered);
      } else {
        buckets.delete(key);
      }
    }

    if (RETAIN_DAYS > 0) {
      const orders = await all(
        `SELECT id,proof
         FROM orders
         WHERE proof IS NOT NULL
         AND status IN('received','rejected')
         AND created_at<?`,
        Date.now() - RETAIN_DAYS * 86400000
      );

      for (const order of orders) {
        await tx(async () => {
          await run(
            'DELETE FROM uploads WHERE name=?',
            path.basename(order.proof)
          );

          await run(
            'UPDATE orders SET proof=NULL WHERE id=?',
            order.id
          );
        });
      }
    }
  } catch (error) {
    console.error(
      'Housekeeping failed:',
      error.code || error.name
    );
  }
};

// Start server

async function main() {
  await initialize();

  server.listen(PORT, HOST, () => {
    console.log(
      'ARK Cafe connected to PostgreSQL and listening on port ' +
      PORT
    );
  });

  await maintain();

  const timer = setInterval(
    maintain,
    3600000
  );

  timer.unref();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    });
  }
}

main().catch(error => {
  console.error(
    'Startup failed:',
    error.code || error.name,
    error.code ? '' : error.message
  );

  process.exit(1);
});
