/* Mell chat — Cloudflare Worker: /api/*, /upload, /f/* обслуживает бэкенд (app.js), всё остальное — статические файлы сайта. */
import handler from './app.js';
import S from './store.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    let op, id, m;
    if ((m = /^\/api\/([^/]+)\/?$/.exec(p))) op = m[1];
    else if (p === '/upload') op = 'upload';
    else if ((m = /^\/f\/([^/]+)$/.exec(p))) { op = 'file'; id = decodeURIComponent(m[1]); }
    else return env.ASSETS.fetch(request);

    const json = (c, o) => new Response(JSON.stringify(o), { status: c, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    try { await S.init(env); } catch (e) { console.error(e); return json(500, { err: 'Ошибка сервера: ' + e.message }); }

    const headers = {}; request.headers.forEach((v, k) => { headers[k] = v; });
    headers['x-forwarded-for'] = headers['cf-connecting-ip'] || headers['x-forwarded-for'] || '';
    headers['x-forwarded-proto'] = url.protocol.slice(0, -1);
    const query = Object.fromEntries(url.searchParams); query.op = op; if (id) query.id = id;
    let body;
    if (request.method === 'POST') {
      if ((headers['content-type'] || '').includes('application/json')) { try { body = await request.json(); } catch (e) { body = {}; } }
      else body = Buffer.from(await request.arrayBuffer());
    }
    const req = { method: request.method, url: p + url.search, headers, query, body };

    let status = 200, fin; const h = new Headers(), done = new Promise(r => { fin = r; });
    const res = {
      status(c) { status = c; return res; },
      setHeader(k, v) { k.toLowerCase() === 'set-cookie' ? h.append(k, v) : h.set(k, v); },
      json(o) { h.set('content-type', 'application/json; charset=utf-8'); fin(new Response(JSON.stringify(o), { status, headers: h })); },
      end(b) { fin(new Response(status === 204 || b == null ? null : b, { status, headers: h })); }
    };
    try { await handler(req, res); } catch (e) { console.error(e); return json(500, { err: 'Ошибка сервера' }); }
    fin(json(500, { err: 'Пустой ответ' }));
    return done;
  }
};
