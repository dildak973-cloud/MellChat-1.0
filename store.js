/* Хранилище: Upstash Redis (данные) + Vercel Blob (файлы).
   Для локальных тестов: MELL_FAKE=1 — всё в памяти. */
let impl;

function real() {
  const { Redis } = require('@upstash/redis');
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis не подключён: добавьте Upstash Redis во вкладке Storage проекта на Vercel');
  const r = new Redis({ url, token });
  return {
    get: k => r.get(k),
    set: (k, v, o) => r.set(k, v, o || {}),
    del: k => r.del(k),
    incr: k => r.incr(k),
    expire: (k, s) => r.expire(k, s),
    hget: (k, f) => r.hget(k, f),
    hset: (k, f, v) => r.hset(k, { [f]: v }),
    hdel: (k, f) => r.hdel(k, f),
    hgetall: k => r.hgetall(k),
    hmget: async (k, fs) => { const o = (await r.hmget(k, ...fs)) || {}; return fs.map(f => (o[f] === undefined ? null : o[f])); },
    zadd: (k, score, member) => r.zadd(k, { score, member }),
    zfrom: async (k, min, count) => {
      const a = await r.zrange(k, min, '+inf', { byScore: true, offset: 0, count, withScores: true });
      const out = []; for (let i = 0; i < a.length; i += 2) out.push({ m: String(a[i]), s: Number(a[i + 1]) });
      return out;
    },
    ztrim: (k, keep) => r.zremrangebyrank(k, 0, -(keep + 1)),
    rpush: (k, v) => r.rpush(k, v),
    lpopall: async k => { const l = await r.lrange(k, 0, -1); if (l.length) await r.del(k); return l; },
    blobPut: async (path, buf, mime) => {
      if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Хранилище файлов не подключено: добавьте Vercel Blob во вкладке Storage');
      const { put } = require('@vercel/blob');
      const x = await put(path, buf, { access: 'public', contentType: mime, addRandomSuffix: true });
      return x.url;
    },
    blobGet: async (url, range) => {
      const x = await fetch(url, { headers: range ? { range } : {} });
      return { status: x.status, headers: x.headers, body: Buffer.from(await x.arrayBuffer()) };
    }
  };
}

function fake() {
  const m = new Map(), exp = new Map(), blobs = new Map();
  const alive = k => { const e = exp.get(k); if (e && e < Date.now()) { m.delete(k); exp.delete(k); } };
  const cl = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    async get(k) { alive(k); return cl(m.has(k) ? m.get(k) : null); },
    async set(k, v, o) { alive(k); if (o && o.nx && m.has(k)) return null; m.set(k, cl(v)); if (o && o.ex) exp.set(k, Date.now() + o.ex * 1000); else exp.delete(k); return 'OK'; },
    async del(k) { m.delete(k); exp.delete(k); },
    async incr(k) { alive(k); const n = (m.get(k) || 0) + 1; m.set(k, n); return n; },
    async expire(k, s) { exp.set(k, Date.now() + s * 1000); },
    async hget(k, f) { const h = m.get(k); return h && f in h ? cl(h[f]) : null; },
    async hset(k, f, v) { const h = m.get(k) || {}; h[f] = cl(v); m.set(k, h); },
    async hdel(k, f) { const h = m.get(k); if (h) delete h[f]; },
    async hgetall(k) { const h = m.get(k); return h && Object.keys(h).length ? cl(h) : null; },
    async hmget(k, fs) { const h = m.get(k) || {}; return fs.map(f => (f in h ? cl(h[f]) : null)); },
    async zadd(k, s, mem) { const z = m.get(k) || []; z.push([s, mem]); z.sort((a, b) => a[0] - b[0]); m.set(k, z); },
    async zfrom(k, min, count) { const z = m.get(k) || []; return z.filter(x => x[0] >= min).slice(0, count).map(x => ({ s: x[0], m: x[1] })); },
    async ztrim() {},
    async rpush(k, v) { alive(k); const l = m.get(k) || []; l.push(cl(v)); m.set(k, l); },
    async lpopall(k) { alive(k); const l = m.get(k) || []; m.delete(k); return l; },
    async blobPut(path, buf) { const u = 'fake://' + path; blobs.set(u, Buffer.from(buf)); return u; },
    async blobGet(url) { const b = blobs.get(url); return { status: 200, headers: new Map(), body: b }; }
  };
}

const get = () => impl || (impl = process.env.MELL_FAKE ? fake() : real());
module.exports = new Proxy({}, { get: (_, k) => (...a) => get()[k](...a) });
