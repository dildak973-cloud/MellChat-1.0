/* Хранилище на Cloudflare: D1 (данные, SQLite) + R2 (файлы). Интерфейс тот же, что был у Redis. */
let env, ready;
const now = () => Date.now();
const J = JSON.stringify;
const P = s => (s == null ? null : JSON.parse(s));
const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
const rows = async st => (await st.all()).results || [];
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)',
  'CREATE TABLE IF NOT EXISTS h(k TEXT NOT NULL, f TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY(k,f)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS z(k TEXT NOT NULL, m TEXT NOT NULL, s INTEGER NOT NULL, PRIMARY KEY(k,m)) WITHOUT ROWID',
  'CREATE INDEX IF NOT EXISTS z_s ON z(k,s)',
  'CREATE TABLE IF NOT EXISTS l(id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, v TEXT NOT NULL, ts INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS l_k ON l(k)'
];

module.exports = {
  async init(e) {
    env = e;
    if (!env.DB) throw new Error('База D1 не подключена: проверьте binding DB в wrangler.toml');
    if (!ready) ready = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(err => { ready = null; throw err; });
    await ready;
  },
  async get(k) { const r = await q('SELECT v FROM kv WHERE k=?1 AND (exp IS NULL OR exp>?2)', k, now()).first(); return r ? P(r.v) : null; },
  async set(k, v, o) {
    const exp = o && o.ex ? now() + o.ex * 1000 : null;
    if (Math.random() < 0.01) await q('DELETE FROM kv WHERE exp IS NOT NULL AND exp<?1', now()).run();
    if (o && o.nx) {
      const r = await q('INSERT INTO kv(k,v,exp) VALUES(?1,?2,?3) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp WHERE kv.exp IS NOT NULL AND kv.exp<=?4', k, J(v), exp, now()).run();
      return r.meta.changes > 0 ? 'OK' : null;
    }
    await q('INSERT INTO kv(k,v,exp) VALUES(?1,?2,?3) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp', k, J(v), exp).run();
    return 'OK';
  },
  async del(k) { await q('DELETE FROM kv WHERE k=?1', k).run(); },
  async incr(k) {
    const r = await rows(q("INSERT INTO kv(k,v,exp) VALUES(?1,'1',NULL) ON CONFLICT(k) DO UPDATE SET v=CASE WHEN kv.exp IS NOT NULL AND kv.exp<=?2 THEN '1' ELSE CAST(CAST(kv.v AS INTEGER)+1 AS TEXT) END, exp=CASE WHEN kv.exp IS NOT NULL AND kv.exp<=?2 THEN NULL ELSE kv.exp END RETURNING v", k, now()));
    return Number(r[0].v);
  },
  async expire(k, s) { await q('UPDATE kv SET exp=?2 WHERE k=?1', k, now() + s * 1000).run(); },
  async hget(k, f) { const r = await q('SELECT v FROM h WHERE k=?1 AND f=?2', k, f).first(); return r ? P(r.v) : null; },
  async hset(k, f, v) { await q('INSERT INTO h(k,f,v) VALUES(?1,?2,?3) ON CONFLICT(k,f) DO UPDATE SET v=excluded.v', k, f, J(v)).run(); },
  async hdel(k, f) { await q('DELETE FROM h WHERE k=?1 AND f=?2', k, f).run(); },
  async hgetall(k) {
    const r = await rows(q('SELECT f,v FROM h WHERE k=?1', k));
    if (!r.length) return null;
    const o = {}; for (const x of r) o[x.f] = P(x.v); return o;
  },
  async hmget(k, fs) {
    const m = {};
    for (const part of chunks(fs, 90)) {
      const r = await rows(q('SELECT f,v FROM h WHERE k=?1 AND f IN (' + part.map((_, i) => '?' + (i + 2)).join(',') + ')', k, ...part));
      for (const x of r) m[x.f] = P(x.v);
    }
    return fs.map(f => (f in m ? m[f] : null));
  },
  async zadd(k, s, m) { await q('INSERT INTO z(k,m,s) VALUES(?1,?2,?3) ON CONFLICT(k,m) DO UPDATE SET s=excluded.s', k, m, s).run(); },
  async zfrom(k, min, count) { return (await rows(q('SELECT m,s FROM z WHERE k=?1 AND s>=?2 ORDER BY s LIMIT ?3', k, min, count))).map(x => ({ m: String(x.m), s: Number(x.s) })); },
  async ztrim(k, keep) { await q('DELETE FROM z WHERE k=?1 AND s <= (SELECT s FROM z WHERE k=?1 ORDER BY s DESC LIMIT 1 OFFSET ?2)', k, keep).run(); },
  async rpush(k, v) { await q('INSERT INTO l(k,v,ts) VALUES(?1,?2,?3)', k, J(v), now()).run(); },
  async lpopall(k) {
    const r = await rows(q('DELETE FROM l WHERE k=?1 RETURNING id,v,ts', k)), min = now() - 60000;
    return r.sort((a, b) => a.id - b.id).filter(x => x.ts >= min).map(x => P(x.v));
  },
  async blobPut(path, buf, mime) {
    if (!env.FILES) throw new Error('Хранилище файлов R2 не подключено: проверьте binding FILES в wrangler.toml');
    await env.FILES.put(path, buf, { httpMetadata: { contentType: mime } });
    return path;
  },
  async blobGet(key, range) {
    let opt, m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) opt = { range: m[1] === '' ? { suffix: +m[2] } : m[2] === '' ? { offset: +m[1] } : { offset: +m[1], length: +m[2] - +m[1] + 1 } };
    const o = await env.FILES.get(key, opt);
    if (!o) return { status: 404, headers: new Map(), body: Buffer.alloc(0) };
    const body = Buffer.from(await o.arrayBuffer()), h = new Map();
    if (opt && o.range) { const off = o.range.offset != null ? o.range.offset : o.size - body.length; h.set('content-range', `bytes ${off}-${off + body.length - 1}/${o.size}`); return { status: 206, headers: h, body }; }
    return { status: 200, headers: h, body };
  }
};
