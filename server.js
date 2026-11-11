import express from 'express';
import crypto from 'crypto';
import pg from 'pg';

const { BOT_TOKEN, DATABASE_URL, ADMIN_TOKEN, WEBAPP_URL } = process.env;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!BOT_TOKEN || !DATABASE_URL) { console.error('Нужны BOT_TOKEN и DATABASE_URL'); process.exit(1); }

const db = new pg.Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
const q = (t, p) => db.query(t, p);
const FREE_HUNTS = 5;
const PACKS = { p5: { hunts: 5, stars: 25, title: '5 охот' }, p20: { hunts: 20, stars: 80, title: '20 охот' }, p50: { hunts: 50, stars: 175, title: '50 охот' } };
const RARITY = [['common', 60], ['rare', 25], ['epic', 10], ['legendary', 4], ['mythic', 1]];
const POINTS = { common: 1, rare: 5, epic: 20, legendary: 80, mythic: 300 };

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS users(
    id BIGINT PRIMARY KEY, game_id SERIAL UNIQUE, first_name TEXT, last_name TEXT, username TEXT, photo_url TEXT,
    language TEXT, hunts_used INT DEFAULT 0, hunts_date DATE DEFAULT CURRENT_DATE, bonus_hunts INT DEFAULT 0,
    stars_spent INT DEFAULT 0, total_hunts INT DEFAULT 0, ton_wallet TEXT, banned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS gifts(id SERIAL PRIMARY KEY, name TEXT UNIQUE, emoji TEXT, rarity TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS collection(id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id), gift_id INT REFERENCES gifts(id), created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS history(id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id), type TEXT, description TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS payments(charge_id TEXT PRIMARY KEY, user_id BIGINT, pack TEXT, stars INT, created_at TIMESTAMPTZ DEFAULT now())`);
  const seed = [['Плюшевый мишка','🧸','common'],['Сердечко','💝','common'],['Роза','🌹','common'],['Торт','🎂','common'],['Букет','💐','common'],
    ['Ракета','🚀','rare'],['Шампанское','🍾','rare'],['Кубок','🏆','rare'],['Кольцо','💍','epic'],['Алмаз','💎','epic'],
    ['Корона','👑','legendary'],['Золотой дракон','🐉','legendary'],['Галактический единорог','🦄','mythic']];
  for (const [n, e, r] of seed) await q('INSERT INTO gifts(name,emoji,rarity) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING', [n, e, r]);
}

// ---- Telegram API ----
const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
};

// ---- Проверка подлинности initData ----
function verifyInitData(raw) {
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const u = h.startsWith('tma ') ? verifyInitData(h.slice(4)) : null;
  if (!u) return res.status(401).json({ error: 'Неверные данные Telegram' });
  const { rows } = await q(`INSERT INTO users(id,first_name,last_name,username,photo_url,language) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(id) DO UPDATE SET first_name=$2,last_name=$3,username=$4,photo_url=COALESCE($5,users.photo_url),language=$6,updated_at=now() RETURNING *`,
    [u.id, u.first_name || '', u.last_name || null, u.username || null, u.photo_url || null, u.language_code || null]);
  if (rows[0].banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  req.user = rows[0]; next();
}
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); });

const app = express();
app.use(express.json());
app.use(express.static('public'));

const profileOf = async uid => {
  const { rows: [u] } = await q('SELECT * FROM users WHERE id=$1', [uid]);
  if (u.hunts_date.toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)) { u.hunts_used = 0; await q('UPDATE users SET hunts_used=0,hunts_date=CURRENT_DATE WHERE id=$1', [uid]); }
  const { rows: [c] } = await q('SELECT count(*)::int n FROM collection WHERE user_id=$1', [uid]);
  return { telegram_id: String(u.id), game_id: u.game_id, first_name: u.first_name, last_name: u.last_name, username: u.username, photo_url: u.photo_url,
    collection_count: c.n, total_hunts: u.total_hunts, stars_spent: u.stars_spent, free_hunts_left: Math.max(0, FREE_HUNTS - u.hunts_used), bonus_hunts: u.bonus_hunts, ton_wallet: u.ton_wallet };
};

app.get('/api/me', auth, wrap(async (req, res) => res.json(await profileOf(req.user.id))));

app.post('/api/hunt', auth, wrap(async (req, res) => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows: [u] } = await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    let used = u.hunts_used, bonus = u.bonus_hunts;
    if (u.hunts_date.toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)) used = 0;
    if (used < FREE_HUNTS) used++; else if (bonus > 0) bonus--; else { await c.query('ROLLBACK'); return res.status(400).json({ error: 'Охоты закончились. Купите ещё в магазине или возвращайтесь завтра.' }); }
    let roll = Math.random() * 100, rarity = 'common';
    for (const [r, w] of RARITY) { if (roll < w) { rarity = r; break; } roll -= w; }
    const { rows: [g] } = await c.query('SELECT * FROM gifts WHERE rarity=$1 ORDER BY random() LIMIT 1', [rarity]);
    await c.query('INSERT INTO collection(user_id,gift_id) VALUES($1,$2)', [u.id, g.id]);
    await c.query('UPDATE users SET hunts_used=$2,hunts_date=CURRENT_DATE,bonus_hunts=$3,total_hunts=total_hunts+1 WHERE id=$1', [u.id, used, bonus]);
    await c.query('INSERT INTO history(user_id,type,description) VALUES($1,$2,$3)', [u.id, 'hunt', `Найден подарок: ${g.emoji} ${g.name} (${g.rarity})`]);
    await c.query('COMMIT');
    res.json({ gift: g, profile: await profileOf(u.id) });
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));

app.get('/api/collection', auth, wrap(async (req, res) => {
  const { rows } = await q(`SELECT g.id,g.name,g.emoji,g.rarity,count(*)::int qty FROM collection c JOIN gifts g ON g.id=c.gift_id WHERE c.user_id=$1 GROUP BY g.id ORDER BY g.id`, [req.user.id]);
  res.json(rows);
}));
app.get('/api/history', auth, wrap(async (req, res) => {
  const { rows } = await q('SELECT type,description,created_at FROM history WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]);
  res.json(rows);
}));
app.get('/api/leaderboard', auth, wrap(async (req, res) => {
  const { rows } = await q(`SELECT u.game_id,u.first_name,u.username,
    sum(CASE g.rarity WHEN 'common' THEN 1 WHEN 'rare' THEN 5 WHEN 'epic' THEN 20 WHEN 'legendary' THEN 80 ELSE 300 END)::int score, count(*)::int gifts
    FROM collection c JOIN users u ON u.id=c.user_id JOIN gifts g ON g.id=c.gift_id WHERE NOT u.banned GROUP BY u.id ORDER BY score DESC LIMIT 50`);
  res.json(rows);
}));
app.get('/api/shop', auth, (req, res) => res.json(Object.entries(PACKS).map(([id, p]) => ({ id, ...p }))));

app.post('/api/buy', auth, wrap(async (req, res) => {
  const p = PACKS[req.body.pack]; if (!p) return res.status(400).json({ error: 'Нет такого пакета' });
  const r = await tg('createInvoiceLink', { title: p.title, description: `Дополнительные охоты в GIFT HUNTER: ${p.hunts}`, payload: JSON.stringify({ u: req.user.id, pack: req.body.pack }), currency: 'XTR', prices: [{ label: p.title, amount: p.stars }] });
  if (!r.ok) return res.status(502).json({ error: 'Не удалось создать счёт' });
  res.json({ link: r.result });
}));

app.post('/api/wallet', auth, wrap(async (req, res) => {
  const a = String(req.body.address || '').slice(0, 100);
  await q('UPDATE users SET ton_wallet=$2 WHERE id=$1', [req.user.id, a || null]);
  await q('INSERT INTO history(user_id,type,description) VALUES($1,$2,$3)', [req.user.id, 'wallet', 'TON-кошелёк привязан']);
  res.json({ ok: true });
}));

// ---- Админка ----
const admin = (req, res, next) => {
  const t = req.headers['x-admin-token'] || '';
  if (!ADMIN_TOKEN || t.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN))) return res.status(401).json({ error: 'Нет доступа' });
  next();
};
app.get('/api/admin/stats', admin, wrap(async (req, res) => {
  const { rows: [s] } = await q(`SELECT (SELECT count(*) FROM users)::int total_users,(SELECT count(*) FROM collection)::int gifts,(SELECT coalesce(sum(stars),0) FROM payments)::int stars,(SELECT count(*) FROM payments)::int payments`);
  const { rows: users } = await q('SELECT id::text,game_id,first_name,username,total_hunts,bonus_hunts,stars_spent,banned FROM users ORDER BY created_at DESC LIMIT 100');
  res.json({ ...s, users });
}));
app.post('/api/admin/bonus', admin, wrap(async (req, res) => {
  await q('UPDATE users SET bonus_hunts=bonus_hunts+$2 WHERE id=$1', [req.body.id, Math.max(-1000, Math.min(1000, parseInt(req.body.amount) || 0))]);
  res.json({ ok: true });
}));
app.post('/api/admin/ban', admin, wrap(async (req, res) => { await q('UPDATE users SET banned=$2 WHERE id=$1', [req.body.id, !!req.body.banned]); res.json({ ok: true }); }));

// ---- Бот (long polling) ----
async function handle(upd) {
  if (upd.pre_checkout_query) return tg('answerPreCheckoutQuery', { pre_checkout_query_id: upd.pre_checkout_query.id, ok: true });
  const m = upd.message; if (!m) return;
  if (m.successful_payment) {
    const sp = m.successful_payment; const pl = JSON.parse(sp.invoice_payload); const p = PACKS[pl.pack];
    if (!p || String(pl.u) !== String(m.from.id)) return;
    const ins = await q('INSERT INTO payments(charge_id,user_id,pack,stars) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING charge_id', [sp.telegram_payment_charge_id, m.from.id, pl.pack, sp.total_amount]);
    if (ins.rowCount) {
      await q('UPDATE users SET bonus_hunts=bonus_hunts+$2,stars_spent=stars_spent+$3 WHERE id=$1', [m.from.id, p.hunts, sp.total_amount]);
      await q('INSERT INTO history(user_id,type,description) VALUES($1,$2,$3)', [m.from.id, 'purchase', `Куплено: ${p.title} за ${sp.total_amount} ⭐`]);
      await tg('sendMessage', { chat_id: m.chat.id, text: `✅ Оплата получена: ${p.title}. Удачной охоты!` });
    }
    return;
  }
  if (m.text && m.text.startsWith('/start')) {
    return tg('sendMessage', { chat_id: m.chat.id, text: '🎁 GIFT HUNTER\nОхоться. Собирай. Владей.', reply_markup: { inline_keyboard: [[{ text: '🎯 Начать охоту', web_app: { url: WEBAPP_URL } }]] } });
  }
  if (m.text === '/paysupport') return tg('sendMessage', { chat_id: m.chat.id, text: 'По вопросам оплаты напишите администратору проекта.' });
}
async function poll() {
  await tg('deleteWebhook'); let offset = 0;
  if (WEBAPP_URL) await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: WEBAPP_URL } } });
  await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть GIFT HUNTER' }, { command: 'paysupport', description: 'Поддержка по оплате' }] });
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'pre_checkout_query'] });
      for (const u of r.result || []) { offset = u.update_id + 1; await handle(u).catch(console.error); }
    } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

await initDb();
app.listen(process.env.PORT || 3000, () => console.log('GIFT HUNTER запущен'));
poll();
