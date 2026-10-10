/* Mell chat — клиентская прослойка: db / user / room поверх API (вход по токену в localStorage, работает с GitHub Pages) */
(function () {
  if (window.claude) return;
  const state = {}, subs = {}, rooms = {};
  const snap = c => ({ docs: Object.entries(state[c] || {}).map(([id, d]) => ({ id, data: () => d })) });
  const fire = c => (subs[c] || []).forEach(f => { try { f(snap(c)); } catch (e) { console.error(e); } });
  let ready = false, started = false, cur = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /* адрес бэкенда (config.js); пусто = тот же домен */
  /* адрес можно задать и вручную: открыть сайт как  ...?api=https://ваш-проект.vercel.app  (запомнится в браузере) */
  try { const q = new URLSearchParams(location.search).get('api'); if (q != null) { q ? localStorage.setItem('mell_api', q) : localStorage.removeItem('mell_api'); } } catch (e) {}
  const API = ((window.MELL_CFG && window.MELL_CFG.api) || (function () { try { return localStorage.getItem('mell_api') || ''; } catch (e) { return ''; } })()).replace(/\/+$/, '');
  const NOAPI = 'Не указан адрес сервера (API_URL). Сайт на GitHub Pages не принимает запросы — впишите адрес Vercel в config.js или откройте сайт как ?api=https://ваш-проект.vercel.app';
  const TK = 'mell_token';
  const tok = {
    get() { try { return localStorage.getItem(TK) || ''; } catch (e) { return ''; } },
    set(v) { try { v ? localStorage.setItem(TK, v) : localStorage.removeItem(TK); } catch (e) {} }
  };
  const hdr = (h) => { const t = tok.get(); return Object.assign({}, h || {}, t ? { Authorization: 'Bearer ' + t } : {}); };
  const getJ = async u => {
    const r = await fetch(API + u, { headers: hdr(), cache: 'no-store' });
    if (r.status === 401) { tok.set(''); location.reload(); throw new Error('auth'); }
    if (!r.ok) throw new Error('Ошибка ' + r.status);
    return r.json();
  };
  const isMem = d => !!(d && (d.mem || []).includes(window.claude.uid));

  // Загружает документы по страницам (весь снимок или содержимое одного чата)
  async function pages(q) {
    let after = 0, c0 = 0; const out = [];
    for (;;) {
      const r = await getJ('/api/sync?snap=1' + q + '&after=' + after);
      if (r.cur != null) c0 = r.cur;
      out.push(...r.docs);
      if (r.done) return { docs: out, cur: c0 };
      after = r.next;
    }
  }
  function put(c, id, doc, changed) {
    const m = state[c] || (state[c] = {});
    if (c === 'chs') { // доступ к чату открылся или закрылся
      const was = isMem(m[id]), now = isMem(doc);
      if (was && !now) ['msgs', 'reads'].forEach(k => { Object.keys(state[k] || {}).forEach(i => { if (state[k][i].c === id) { delete state[k][i]; changed.add(k); } }); });
      if (!was && now) loadChat(id);
    }
    if (doc) m[id] = doc; else delete m[id];
    changed.add(c);
  }
  async function loadChat(id) {
    try {
      const { docs } = await pages('&chat=' + encodeURIComponent(id));
      const changed = new Set();
      docs.forEach(([c, i, d]) => { if (d) { (state[c] || (state[c] = {}))[i] = d; changed.add(c); } });
      changed.forEach(fire);
    } catch (e) { console.error(e); }
  }

  async function connect() {
    if (started) return; started = true;
    for (;;) {
      try {
        const snapR = await pages('');
        Object.keys(state).forEach(k => delete state[k]);
        snapR.docs.forEach(([c, id, d]) => { if (d) (state[c] || (state[c] = {}))[id] = d; });
        cur = snapR.cur; ready = true;
        Object.keys(subs).forEach(fire);
        break;
      } catch (e) { await sleep(3000); }
    }
    for (;;) { // long-poll изменений и сигналов звонков
      try {
        const r = await getJ('/api/sync?since=' + cur);
        const changed = new Set();
        r.ch.forEach(([c, id, d]) => put(c, id, d, changed));
        cur = r.cur;
        changed.forEach(fire);
        (r.sig || []).forEach(d => (rooms.sig || []).forEach(f => { try { f(d); } catch (e) { console.error(e); } }));
        if (!r.more && document.hidden) await sleep(4000);
      } catch (e) { await sleep(3000); }
    }
  }

  const post = (op, b) => fetch(API + '/api/' + op, {
    method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify(b || {})
  }).then(async r => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && j.err === 'auth') { tok.set(''); location.reload(); }
      throw Object.assign(new Error(r.status === 405 || r.status === 404 && !API ? NOAPI : (j.err || ('Ошибка ' + r.status))), { status: r.status });
    }
    if (j.token) tok.set(j.token);                 // вход / регистрация / смена пароля
    if (op === 'logout' || op === 'account' && b && b.a === 'logout_all') tok.set('');
    return j;
  });
  /* текущая сессия: токен продлевается на сервере при каждом открытии */
  const me = async () => {
    if (!tok.get()) return null;
    try {
      const r = await fetch(API + '/api/me', { headers: hdr(), cache: 'no-store' });
      if (r.status === 401) { tok.set(''); return null; }
      if (!r.ok) return null;
      const j = await r.json(); if (j.token) tok.set(j.token); return j;
    } catch (e) { return null; }
  };

  const DB = {
    collection: c => ({
      onSnapshot: f => { (subs[c] || (subs[c] = [])).push(f); if (ready) f(snap(c)); },
      doc: id => ({
        set: d => post('set', { c, id, d }),
        update: d => post('update', { c, id, d }),
        delete: () => post('delete', { c, id })
      })
    })
  };
  const room = {
    emit: (ev, d) => post('room', { ev, d }),
    on: (ev, f) => { (rooms[ev] || (rooms[ev] = [])).push(f); }
  };
  window.claude = {
    uid: null, post, connect, me, api: API, token: tok.get,
    fileUrl: (id, dl) => API + '/f/' + encodeURIComponent(id) + (dl ? '?dl=1' : ''),
    upload: (file, voice, onprog) => new Promise((ok, no) => {
      const x = new XMLHttpRequest(); x.open('POST', API + '/upload');
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.setRequestHeader('X-Name', encodeURIComponent(file.name || 'file'));
      if (voice) x.setRequestHeader('X-Voice', '1');
      const t = tok.get(); if (t) x.setRequestHeader('Authorization', 'Bearer ' + t);
      if (onprog) x.upload.onprogress = onprog;
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} x.status === 200 ? ok(j) : no(new Error(j.err || ('Ошибка ' + x.status))); };
      x.onerror = () => no(new Error('Нет связи с сервером')); x.send(file);
    }),
    use: n => Promise.resolve(
      n === 'db' ? DB :
      n === 'user' ? { id: async () => window.claude.uid } :
      n === 'room' ? room : null)
  };
})();
