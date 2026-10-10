/* Mell chat — бэкенд (Cloudflare Worker, вызывается из worker.js; маршрут задаётся параметром op) */
const crypto = require('crypto');
const S = require('./store');

const COLS = ['users', 'chs', 'msgs', 'reads', 'stk', 'pks', 'emo'];
const MAXDOC = 450e3, MAXF = 25e6, YEAR = 31536000;
const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
class E extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = m => new E(400, m), forb = m => new E(403, m);
const isImg = s => typeof s === 'string' && s.startsWith('data:image/') && s.length <= 320e3;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const rnd = n => crypto.randomBytes(n).toString('hex');

/* ---------- сессии (долгая cookie: вход сохраняется после полного закрытия приложения) ---------- */
const sid = req => {
  const a = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.authorization || '');
  if (a) return a[1];
  const m = /(?:^|;\s*)mell_sid=([a-f0-9]{48})/.exec(req.headers.cookie || ''); return m && m[1];
};
async function who(req) {
  const t = sid(req); if (!t) return null;
  const s = await S.get('sess:' + t); if (!s) return null;
  const v = (await S.get('sv:' + s.u)) || 0;
  return v === s.v ? { u: s.u, t } : null;
}
function cookie(req, res, t, age) {
  res.setHeader('Set-Cookie', `mell_sid=${t}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
}
async function newSession(req, res, u) {
  const t = rnd(24);
  await S.set('sess:' + t, { u, v: (await S.get('sv:' + u)) || 0 }, { ex: YEAR });
  cookie(req, res, t, YEAR);
  return t;
}
async function rl(req, key, max, sec) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const k = 'rl:' + key + ':' + ip, n = await S.incr(k);
  if (n === 1) await S.expire(k, sec);
  if (n > max) throw new E(429, 'Слишком много попыток, подождите несколько минут');
}
/* PBKDF2 (WebCrypto) — в Workers он нативный и быстрый */
const hashPw = async (pw, salt) => {
  const enc = new TextEncoder(), key = await globalThis.crypto.subtle.importKey('raw', enc.encode(String(pw || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(String(salt)), iterations: 100000 }, key, 256);
  return Buffer.from(bits).toString('hex');
};
const samePw = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const UN = /^[a-z0-9_]{3,20}$/;

/* ---------- запись документов + журнал изменений ---------- */
async function bump(c, id) { const n = await S.incr('seq'); await S.zadd('log', n, c + '|' + id); if (n % 500 === 0) S.ztrim('log', 50000).catch(() => {}); }
const putDoc = async (c, id, d) => { await S.hset('d:' + c, id, d); await bump(c, id); };
const delDoc = async (c, id) => { await S.hdel('d:' + c, id); await bump(c, id); };

/* ---------- регистрация / вход ---------- */
async function register(req, res, b) {
  await rl(req, 'reg', 10, 3600);
  const name = str(b.name, 30).trim(), un = str(b.un, 40).trim().toLowerCase(), pw = String(b.pw || '');
  if (!name) throw bad('Введите имя');
  if (!UN.test(un)) throw bad('Username: 3–20 символов a-z, 0-9, _');
  if (pw.length < 6 || pw.length > 200) throw bad('Пароль: минимум 6 символов');
  const u = 'u' + rnd(8);
  if (!(await S.set('un:' + un, u, { nx: true }))) throw new E(409, 'Такой username уже занят');
  const salt = rnd(16);
  await S.set('cred:' + u, { salt, h: await hashPw(pw, salt) });
  /* 100 Drun Coin за регистрацию начисляет сервер — клиент менять coins не может */
  await putDoc('users', u, { name, un, bio: '', coins: 100, cb: 1, ct: [], geoOn: true, t: now() });
  return { uid: u, maxFile: MAXF, token: await newSession(req, res, u) };
}
async function doLogin(req, res, b) {
  await rl(req, 'login', 30, 600);
  const un = str(b.un, 40).trim().toLowerCase(), u = await S.get('un:' + un), fail = bad('Неверный username или пароль');
  if (!u) throw fail;
  const c = await S.get('cred:' + u);
  if (!c || !samePw(await hashPw(b.pw, c.salt), c.h)) throw fail;
  return { uid: u, maxFile: MAXF, token: await newSession(req, res, u) };
}
async function account(req, res, u, b) {
  await rl(req, 'acct', 30, 600);
  if (b.a === 'logout_all') { await S.incr('sv:' + u); cookie(req, res, '', 0); return {}; }
  const c = await S.get('cred:' + u);
  if (!c || !samePw(await hashPw(b.pw, c.salt), c.h)) throw bad('Неверный пароль');
  if (b.a === 'username') {
    const nu = str(b.un, 40).trim().toLowerCase(), doc = await S.hget('d:users', u);
    if (!UN.test(nu)) throw bad('Username: 3–20 символов a-z, 0-9, _');
    if (nu === doc.un) return {};
    if (!(await S.set('un:' + nu, u, { nx: true }))) throw new E(409, 'Такой username уже занят');
    await S.del('un:' + doc.un); await putDoc('users', u, { ...doc, un: nu });
    return {};
  }
  if (b.a === 'password') {
    const np = String(b.npw || ''); if (np.length < 6 || np.length > 200) throw bad('Новый пароль: минимум 6 символов');
    const salt = rnd(16); await S.set('cred:' + u, { salt, h: await hashPw(np, salt) });
    await S.incr('sv:' + u);
    return { token: await newSession(req, res, u) };
  }
  throw bad('Неизвестная операция');
}

/* ---------- доступ к данным ---------- */
async function viewCtx(u) { return { u, me: (await S.hget('d:users', u)) || {}, chs: (await S.hgetall('d:chs')) || {} }; }
function accessible(x, c) { const ch = x.chs[c]; if (c === 'general') return true; return ch ? (ch.mem || []).includes(x.u) : String(c).split('_').includes(x.u); }
/* чужие координаты видны только взаимным друзьям, и только если человек не скрыл геолокацию */
function viewUser(x, id, d) {
  if (id === x.u) return d;
  const mine = (x.me.ct || []).includes(id), theirs = (d.ct || []).includes(x.u), o = { ...d, ct: theirs ? [x.u] : [] };
  if (!(mine && theirs && d.geoOn !== false)) delete o.gl;
  return o;
}
function visible(x, c, id, d) {
  if (d == null) return null;
  if (c === 'users') return viewUser(x, id, d);
  if (c === 'msgs' || c === 'reads') return accessible(x, d.c) ? d : undefined;
  return d;
}
async function snapshot(u, chat, after) {
  const cur = (await S.get('seq')) || 0, x = await viewCtx(u), all = [];
  if (chat && !accessible(x, chat)) return { docs: [], done: true, next: 0 };
  for (const c of chat ? ['msgs', 'reads'] : COLS) {
    const h = (await S.hgetall('d:' + c)) || {};
    for (const id of Object.keys(h).sort()) { const d = h[id]; if (chat && d.c !== chat) continue; const v = visible(x, c, id, d); if (v != null) all.push([c, id, v]); }
  }
  let i = after, bytes = 0; const docs = [];
  for (; i < all.length && docs.length < 400 && bytes < 2.5e6; i++) { docs.push(all[i]); bytes += JSON.stringify(all[i]).length; }
  const r = { docs, done: i >= all.length, next: i };
  if (!after) r.cur = cur;
  return r;
}
async function changes(u, since) {
  const rows = await S.zfrom('log', since + 1, 100);
  if (!rows.length) return { ch: [], cur: since, more: false };
  const cur = rows[rows.length - 1].s, by = {};
  new Set(rows.map(r => r.m)).forEach(k => { const i = k.indexOf('|'); (by[k.slice(0, i)] || (by[k.slice(0, i)] = [])).push(k.slice(i + 1)); });
  const x = await viewCtx(u), ch = [];
  for (const c of Object.keys(by)) {
    const ids = by[c], docs = await S.hmget('d:' + c, ids);
    ids.forEach((id, i) => { const v = visible(x, c, id, docs[i]); if (v !== undefined) ch.push([c, id, v]); });
  }
  return { ch, cur, more: rows.length >= 100 };
}
async function sync(res, u, q) {
  if (q.snap) return res.status(200).json(await snapshot(u, q.chat, +q.after || 0));
  let since = +q.since || 0; const t0 = now();
  for (;;) {
    const sig = await S.lpopall('sig:' + u), seq = (await S.get('seq')) || 0;
    let ch = [], more = false;
    if (seq > since) { const r = await changes(u, since); ch = r.ch; more = r.more; since = r.cur; }
    if (ch.length || sig.length || more || now() - t0 > 7000) return res.status(200).json({ ch, cur: since, more, sig });
    await sleep(1500);
  }
}

/* ---------- правила записи по коллекциям ---------- */
function cleanUser(cur, d) {
  const o = { ...cur };
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (k === 'name') { const s = str(v, 30).trim(); if (s) o.name = s; }
    else if (k === 'bio') o.bio = str(v, 160);
    else if (k === 'gr' || k === 'ar') o[k] = str(v, 300);
    else if (['grOn', 'arOn', 'plus', 'geoOn'].includes(k)) o[k] = !!v;
    else if (['frame', 'bp', 'nc', 'st', 'stA', 'wp'].includes(k)) o[k] = str(v, 40);
    else if (['av', 'ban', 'stImg'].includes(k)) { if (v === '' || v == null) o[k] = ''; else if (isImg(v)) o[k] = v; else throw bad('Картинка слишком большая'); }
    else if (k === 'ct') { if (!Array.isArray(v) || v.length > 1000 || v.some(z => typeof z !== 'string')) throw bad('Некорректный список'); o.ct = [...new Set(v)]; }
    else if (k === 'gl') { if (v === null) o.gl = null; else { const a = +v.a, b = +v.o, t = +v.t; if (!(Math.abs(a) <= 90 && Math.abs(b) <= 180 && t > 0)) throw bad('Некорректная геолокация'); o.gl = { a, o: b, t }; } }
    /* un, coins, cb, id и прочее клиентом не меняются */
  }
  if (o.geoOn === false) o.gl = null;
  return o;
}
const canWrite = (x, c, ch) => c === 'general' || (ch ? (ch.mem || []).includes(x) && (ch.k !== 'c' || ch.o === x) : (() => { const p = String(c).split('_'); return p.length === 2 && p.includes(x); })());
async function fileMeta(f, u) {
  if (!f || typeof f.id !== 'string') return null;
  const r = await S.get('file:' + f.id); return r && r.u === u ? { id: f.id, n: r.n, s: r.s, k: r.k } : null;
}
async function putAuto(c, f, tx) { await putDoc('msgs', 'a' + rnd(8), { c, f, tx, t: now() + 1, au: 1 }); }
async function auto(u, m) { /* приветствие и автоответчик */
  if (m.au || m.c === 'general' || m.c.indexOf('_') < 0 || (await S.hget('d:chs', m.c))) return;
  const o = m.c.split('_').find(x => x !== u); if (!o || o === 'stickers') return;
  const od = await S.hget('d:users', o); if (!od) return;
  if (od.grOn && od.gr && (await S.set('gr:' + m.c + ':' + o, 1, { nx: true }))) return putAuto(m.c, o, od.gr);
  if (od.arOn && od.ar && (await S.set('ar:' + m.c + ':' + o, 1, { nx: true, ex: 300 }))) return putAuto(m.c, o, od.ar);
}
const own = extra => async (u, id, cur, d) => {
  if (cur && cur.o !== u) throw forb('Чужой объект');
  const o = { ...(cur || {}), o: u };
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (k === 'n') o.n = str(v, 40); else if (k === 'pk') o.pk = str(v, 20); else if (k === 'fav') o.fav = v ? 1 : 0; else if (k === 't') o.t = +v || now();
    else if (k === 'i' || k === 'av') { if (v === '' || v == null) o[k] = ''; else if (isImg(v)) o[k] = v; else throw bad('Картинка слишком большая'); }
  }
  if (extra) await extra(u, id, cur, o);
  return { doc: o };
};
const RULES = {
  users: async (u, id, cur, d) => {
    if (id !== u || !cur) throw forb('Можно менять только свой профиль');
    const o = cleanUser(cur, d);
    return { doc: o, after: async () => { if (d.ct) { const a = new Set(cur.ct || []), b = new Set(o.ct || []); for (const z of new Set([...a, ...b])) if (a.has(z) !== b.has(z)) await bump('users', z); } } };
  },
  chs: async (u, id, cur, d, op) => {
    if (!cur || op === 'set') {
      if (cur) throw forb('Уже существует');
      const k = d.k === 'c' ? 'c' : 'g', n = str(d.n, 30).trim(); if (!n) throw bad('Введите название');
      if (d.av && !isImg(d.av)) throw bad('Картинка слишком большая');
      return { doc: { n, k, o: u, mem: [u], t: now(), d: str(d.d, 120), av: d.av || '' } };
    }
    const o = { ...cur };
    if (cur.o === u) {
      if ('n' in d) o.n = str(d.n, 30).trim() || cur.n;
      if ('d' in d) o.d = str(d.d, 120);
      if ('av' in d) { if (d.av && !isImg(d.av)) throw bad('Картинка слишком большая'); o.av = d.av || ''; }
      if ('mem' in d) { if (!Array.isArray(d.mem) || d.mem.length > 5000) throw bad('mem'); o.mem = [...new Set([u, ...d.mem.filter(z => typeof z === 'string')])]; }
    } else if ('mem' in d) {
      if (!Array.isArray(d.mem)) throw bad('mem');
      const old = new Set(cur.mem || []), nw = new Set(d.mem.filter(z => typeof z === 'string'));
      const added = [...nw].filter(z => !old.has(z)), removed = [...old].filter(z => !nw.has(z));
      if (removed.some(z => z !== u)) throw forb('Нельзя удалять других');
      if (added.some(z => z !== u) && (cur.k === 'c' || !old.has(u))) throw forb('Добавлять участников могут участники группы');
      o.mem = [...nw];
    } else throw forb('Нет прав');
    return { doc: o };
  },
  msgs: async (u, id, cur, d, op) => {
    const create = !cur || op === 'set';
    if (create) {
      if (cur) throw forb('Уже существует');
      const c = str(d.c, 200), ch = c === 'general' ? null : await S.hget('d:chs', c);
      if (!c || !canWrite(u, c, ch)) throw forb('Нет доступа к чату');
      const o = { c, f: u, tx: str(d.tx, 2000), t: now(), r: typeof d.r === 'string' ? d.r.slice(0, 100) : null };
      if (d.s) {
        if (d.s.i) { if (!isImg(d.s.i)) throw bad('Стикер слишком большой'); o.s = { i: d.s.i }; }
        else o.s = { e: str(d.s.e, 12), a: str(d.s.a, 12) };
      }
      if (d.fl) { const f = await fileMeta(d.fl, u); if (!f) throw bad('Файл не найден'); o.fl = f; }
      if (d.vm) { o.vm = 1; o.du = Math.min(Math.max(+d.du || 0, 0), 3600); }
      if (!o.tx && !o.s && !o.fl) throw bad('Пустое сообщение');
      return { doc: o, after: () => auto(u, o) };
    }
    const x = await viewCtx(u); if (!accessible(x, cur.c)) throw forb('Нет доступа');
    const o = { ...cur };
    for (const k of Object.keys(d)) {
      if (k === 'tx' || k === 'e') { if (cur.f !== u) throw forb('Чужое сообщение'); if (k === 'tx') o.tx = str(d.tx, 2000); else o.e = 1; }
      else if (k === 'rx' || k === 'ls') {
        const nv = d[k]; if (!nv || typeof nv !== 'object') throw bad('Некорректные данные');
        const old = cur[k] || {}, r = {};
        for (const key of new Set([...Object.keys(old), ...Object.keys(nv)])) {
          if (key === u) { if (key in nv) r[key] = k === 'rx' ? str(nv[key], 12) : (+nv[key] || now()); }
          else if (key in old) r[key] = old[key];
        }
        o[k] = r;
      }
    }
    return { doc: o };
  },
  reads: async (u, id, cur, d) => {
    const c = str(d.c, 200); if (id !== c + '|' + u) throw forb('Нельзя');
    if (!accessible(await viewCtx(u), c)) throw forb('Нет доступа');
    return { doc: { c, u, t: Math.min(+d.t || now(), now() + 5000) } };
  },
  stk: own(),
  pks: own(),
  emo: own(async (u, id, cur, o) => {
    if (!/^[a-z0-9_]{2,16}$/.test(id)) throw bad('Название эмодзи: 2–16 символов a-z 0-9 _');
    if (!cur && !(await S.hget('d:users', u))?.plus) throw forb('Свои эмодзи — в Drun+');
  })
};
const CAN_DELETE = {
  chs: (u, cur) => cur.o === u, msgs: (u, cur) => cur.f === u,
  stk: (u, cur) => cur.o === u, pks: (u, cur) => cur.o === u, emo: (u, cur) => cur.o === u
};
async function write(u, op, b) {
  const c = b.c, id = String(b.id == null ? '' : b.id);
  if (!COLS.includes(c) || !id || id.length > 200) throw bad('Некорректный запрос');
  const cur = await S.hget('d:' + c, id);
  if (op === 'delete') {
    if (!cur) return;
    if (!CAN_DELETE[c] || !CAN_DELETE[c](u, cur)) throw forb('Нет прав на удаление');
    return delDoc(c, id);
  }
  const d = b.d;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('Нет данных');
  if (JSON.stringify(d).length > MAXDOC) throw bad('Слишком большой объём данных');
  if (op === 'update' && !cur) throw bad('Документ не найден');
  const r = await RULES[c](u, id, cur, d, op);
  await putDoc(c, id, r.doc);
  if (r.after) await r.after();
}

/* ---------- файлы ---------- */
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav' };
async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const ch = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAXF + 1024) throw new E(413, 'Файл больше 25 МБ'); ch.push(c); }
  return Buffer.concat(ch);
}
async function upload(req, res, u) {
  await rl(req, 'up', 60, 600);
  let name = 'file'; try { name = decodeURIComponent(req.headers['x-name'] || 'file'); } catch (e) {}
  name = name.replace(/[\\/\0]/g, '_').slice(0, 120) || 'file';
  const buf = await rawBody(req);
  if (!buf.length) throw bad('Пустой файл');
  if (buf.length > MAXF) throw new E(413, 'Файл больше 25 МБ');
  const ext = (name.split('.').pop() || '').toLowerCase();
  let mime = MIME[ext] || 'application/octet-stream';
  if (req.headers['x-voice'] && !mime.startsWith('audio/')) mime = 'audio/webm';
  const k = mime.startsWith('image/') ? 'img' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
  const id = 'f' + rnd(9), url = await S.blobPut('mell/' + id + '/' + (name.replace(/[^\w.\-]/g, '_') || 'file'), buf, mime);
  await S.set('file:' + id, { url, n: name, s: buf.length, k, u, mime });
  return res.status(200).json({ id });
}
async function fileGet(req, res, id) {
  const r = await S.get('file:' + String(id));
  if (!r) return res.status(404).json({ err: 'Файл не найден' });
  const x = await S.blobGet(r.url, req.headers.range);
  const dl = req.query && req.query.dl, safe = r.mime !== 'application/octet-stream';
  res.status(x.status === 206 ? 206 : 200);
  res.setHeader('Content-Type', safe ? r.mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  if (dl || !safe) res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(r.n));
  const cr = x.headers.get && x.headers.get('content-range'); if (cr) res.setHeader('Content-Range', cr);
  res.setHeader('Content-Length', x.body.length);
  res.end(x.body);
}

/* ---------- вход в функцию ---------- */
/* CORS: фронтенд может жить на другом домене (GitHub Pages). ALLOWED_ORIGIN — через запятую, по умолчанию любой.
   Cookie между доменами не нужны (вход по заголовку Authorization), поэтому credentials не включаем. */
function cors(req, res) {
  const list = (process.env.ALLOWED_ORIGIN || '*').split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);
  const o = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', list.includes('*') ? '*' : (o && list.includes(o) ? o : list[0]));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Name, X-Voice, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Access-Control-Max-Age', '86400');
}
module.exports = async (req, res) => {
  try {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const op = q.op, b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    res.setHeader('Cache-Control', 'no-store');
    if (op === 'register') return res.status(200).json(await register(req, res, b));
    if (op === 'login') return res.status(200).json(await doLogin(req, res, b));
    if (op === 'claim') throw bad('Вход по почте больше не поддерживается — создайте аккаунт');
    if (op === 'logout') { const t = sid(req); if (t) await S.del('sess:' + t); cookie(req, res, '', 0); return res.status(200).json({}); }
    /* файл открывается по неугадываемому id (<img>/<video> не умеют слать Authorization) */
    if (op === 'file') return await fileGet(req, res, q.id);
    const a = await who(req);
    if (!a) return res.status(401).json({ err: 'auth' });
    const u = a.u;
    switch (op) {
      case 'me': { await S.expire('sess:' + a.t, YEAR); cookie(req, res, a.t, YEAR); return res.status(200).json({ uid: u, maxFile: MAXF, token: a.t }); }
      case 'sync': return await sync(res, u, q);
      case 'set': case 'update': case 'delete': await write(u, op, b); return res.status(200).json({});
      case 'room': {
        if (b.ev === 'sig' && b.d && typeof b.d.to === 'string' && JSON.stringify(b.d).length < 20000) {
          await S.rpush('sig:' + b.d.to, { ...b.d, from: u }); await S.expire('sig:' + b.d.to, 60);
        }
        return res.status(200).json({});
      }
      case 'account': return res.status(200).json(await account(req, res, u, b));
      case 'upload': return await upload(req, res, u);
      default: return res.status(404).json({ err: 'Не найдено' });
    }
  } catch (e) {
    if (e instanceof E) return res.status(e.code).json({ err: e.message });
    console.error(e);
    return res.status(500).json({ err: 'Ошибка сервера: ' + (e && e.message || '') });
  }
};
