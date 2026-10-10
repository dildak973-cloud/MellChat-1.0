/* Mell chat — клиентская прослойка: db / user / room поверх Netlify Functions (вход по cookie-сессии) */
(function () {
  if (window.claude) return;
  const state = {}, subs = {}, rooms = {};
  const snap = c => ({ docs: Object.entries(state[c] || {}).map(([id, d]) => ({ id, data: () => d })) });
  const fire = c => (subs[c] || []).forEach(f => { try { f(snap(c)); } catch (e) { console.error(e); } });
  let ready = false, started = false, cur = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getJ = async u => {
    const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.reload(); throw new Error('auth'); }
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

  const post = (op, b) => fetch('/api/' + op, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {})
  }).then(async r => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && j.err === 'auth') { location.reload(); }
      throw Object.assign(new Error(j.err || ('Ошибка ' + r.status)), { status: r.status });
    }
    return j;
  });

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
    uid: null, post, connect,
    use: n => Promise.resolve(
      n === 'db' ? DB :
      n === 'user' ? { id: async () => window.claude.uid } :
      n === 'room' ? room : null)
  };
})();
