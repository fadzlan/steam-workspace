'use strict';
/* Shared state + wishlist / my-list views. Charts live in charts.js. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CATN = ['Genre', 'Theme & mood', 'Players', 'Visuals & audio', 'Features'];
const NOW = Date.now() / 1000;

const SW = {
  st: null, games: [], byId: new Map(), listIds: new Set(), tagName: {}, tagCat: {}, tab: 'list',
  S: { sel: new Set(), mode: 'and', scope: 'all', q: '', type: 'all', sale: 'all', rel: 'all', lst: 'all', cats: new Set([0, 1, 2, 3, 4]), tq: '', sort: 'disc', dir: -1, page: 0,
    bcats: new Set([0, 1, 2, 3, 4]), topn: 90, bsrc: 'wish', psrc: 'wish', pcats: new Set([0, 1, 2, 3, 4]), pn: 60, csrc: 'wish', cn: 120, csale: false },
  charts: {},
};
const S = SW.S;
const PS = 100;

// ---- data ------------------------------------------------------------------------
async function loadState() {
  const st = (SW.st = await api.state());
  SW.tagName = st.tags;
  SW.games = st.games.map((r) => {
    const tags = (r.tagids || []).filter((id) => st.tags[id]);
    for (const id of tags) if (!(id in SW.tagCat)) SW.tagCat[id] = TAGCAT[st.tags[id]] ?? 4;
    return { ...r, tags, all: new Set(tags), shown: new Set(tags.slice(0, 5)), hay: (r.name + ' ' + r.dev + ' ' + r.pub).toLowerCase() };
  });
  SW.byId = new Map(SW.games.map((g) => [g.id, g]));
  SW.listIds = new Set(st.list.map((i) => i.appid));
  SW.cat = (t) => SW.tagCat[t] ?? 4;
  SW.pre = currencyPrefix();
}
function currencyPrefix() {
  for (const g of SW.games) { const m = /^[^\d]*/.exec(g.fFin || ''); if (m && m[0]) return m[0]; }
  return '';
}
const price = (cents) => SW.pre + (cents / 100).toFixed(2);
const inSet = (g) => (S.scope === 'shown' ? g.shown : g.all);
const dstr = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—');

function pass(g, skipTags) {
  if (S.type === 'game' && g.type !== 0) return false;
  if (S.type === 'dlc' && g.type !== 4) return false;
  if (S.sale === 'sale' && g.disc <= 0) return false;
  const un = g.st === 2 || g.rel > NOW;
  if (S.rel === 'out' && un) return false;
  if (S.rel === 'soon' && !un) return false;
  if (S.lst === 'in' && !SW.listIds.has(g.id)) return false;
  if (S.lst === 'out' && SW.listIds.has(g.id)) return false;
  if (S.q && !g.hay.includes(S.q)) return false;
  if (!skipTags && S.sel.size) {
    const s = inSet(g);
    if (S.mode === 'and') { for (const t of S.sel) if (!s.has(t)) return false; }
    else { let ok = false; for (const t of S.sel) if (s.has(t)) { ok = true; break; } if (!ok) return false; }
  }
  return true;
}

// ---- thumbs (cached on disk by the main process) ------------------------------------
const thumb = (g) => `<img loading="lazy" alt="" src="swimg://thumb/${g.id}" data-id="${g.id}" data-gif="${g.gif ? 1 : ''}">`;
document.addEventListener('mouseover', (e) => {
  const i = e.target.closest && e.target.closest('img[data-gif="1"]');
  if (i) { i.dataset.prev = i.src; i.src = `swimg://hover/${i.dataset.id}`; i.classList.add('hov'); }
});
document.addEventListener('mouseout', (e) => {
  const i = e.target.closest && e.target.closest('img[data-prev]');
  if (i && !i.contains(e.relatedTarget)) { i.src = i.dataset.prev; delete i.dataset.prev; i.classList.remove('hov'); }
});

// ---- wishlist table --------------------------------------------------------------------
const COLS = [['', ''], ['name', 'Game'], ['disc', 'Discount', 'num'], ['fin', 'Price', 'num'], ['rp', 'Rating', 'num'], ['rel', 'Release'], ['dev', 'Developer / publisher']];
$('#thead').innerHTML = COLS.map((c) => `<th data-k="${c[0]}" class="${c[2] || ''}">${c[1]}<span class="ar"></span></th>`).join('');
$('#thead').onclick = (e) => {
  const th = e.target.closest('th'); if (!th || !th.dataset.k) return;
  const k = th.dataset.k;
  if (S.sort === k) S.dir *= -1; else { S.sort = k; S.dir = k === 'name' || k === 'dev' || k === 'fin' ? 1 : -1; }
  S.page = 0; renderList();
};
function cmp(a, b) {
  const k = S.sort; let x = a[k], y = b[k];
  if (k === 'fin') { x = a.st === 1 ? 0 : a.fin || 1e9; y = b.st === 1 ? 0 : b.fin || 1e9; }
  if (k === 'rp') { x = a.rc ? a.rp + a.rc / 1e9 : -1; y = b.rc ? b.rp + b.rc / 1e9 : -1; }
  if (k === 'rel') { x = x || (S.dir > 0 ? 1e12 : 0); y = y || (S.dir > 0 ? 1e12 : 0); }
  const r = typeof x === 'string' ? x.localeCompare(y) : x - y;
  return (r || b.rc - a.rc) * S.dir;
}
function chip(g, t, i) {
  const k = SW.cat(t);
  return `<button class="tg k${k} ${i < 5 ? 'sh' : 'ex'}${S.sel.has(t) ? ' on' : ''}" data-t="${t}" title="${CATN[k]}${i < 5 ? ' · shown on Steam' : ' · extra tag'}">${esc(SW.tagName[t])}</button>`;
}
function priceCell(g) {
  if (g.st === 2 && !g.fin) return '<span class="sm">Coming soon</span>';
  if (g.st === 1 || (!g.fin && !g.orig)) return g.st === 1 ? '<span class="sm">Free / n.a.</span>' : '—';
  return (g.disc > 0 ? `<span class="old">${esc(g.fOrig)}</span>` : '') + esc(g.fFin);
}
const ratingCell = (g) => g.rc
  ? `<div class="rv"><span>${g.rp}%</span><span class="rvb"><i style="width:${g.rp}%;background:${g.rp >= 70 ? 'var(--good)' : g.rp >= 40 ? 'var(--mixed)' : 'var(--bad)'}"></i></span><span class="sm">${g.rc.toLocaleString()}</span></div>`
  : '<span class="sm">—</span>';
const starBtn = (g) => `<button class="star${SW.listIds.has(g.id) ? ' on' : ''}" data-star="${g.id}" title="${SW.listIds.has(g.id) ? 'Remove from my list' : 'Add to my list'}">${SW.listIds.has(g.id) ? '★' : '☆'}</button>`;
const gameCell = (g, extra = '') => `<div class="gm"><div class="th">${thumb(g)}</div><div class="gn"><a href="https://store.steampowered.com/app/${g.id}" data-open>${esc(g.name)}</a>${g.type === 4 ? '<span class="badge" style="width:max-content;margin:0">DLC</span>' : ''}${extra}</div></div>`;

function rowHtml(g) {
  return `<tr><td style="width:34px">${starBtn(g)}</td><td>${gameCell(g, `<div class="tags">${g.tags.map((t, i) => chip(g, t, i)).join('')}</div>`)}</td>
 <td class="num">${g.disc > 0 ? `<span class="disc">-${g.disc}%</span>` : '<span class="sm">—</span>'}</td><td class="num">${priceCell(g)}</td><td class="num">${ratingCell(g)}</td>
 <td class="dv" style="white-space:nowrap">${g.st === 2 && !g.rel ? '<span class="sm">TBA</span>' : dstr(g.rel)}</td>
 <td class="dv">${esc(g.dev || '—')}${g.pub && g.pub !== g.dev ? `<div class="sm">${esc(g.pub)}</div>` : ''}</td></tr>`;
}
function emptyMsg() {
  const st = SW.st;
  if (!st.profile) return 'Enter your Steam username above and press <b>Sync</b>.<br>Your wishlist must be public (Steam → Profile → Edit → Privacy → Game details).';
  if (st.status.running) return 'Fetching game data… rows appear as batches arrive.';
  return 'No games match these filters.';
}
let cur = [];
function renderList() {
  cur = SW.games.filter((g) => pass(g)).sort(cmp);
  const pages = Math.max(1, Math.ceil(cur.length / PS)); if (S.page >= pages) S.page = pages - 1;
  const sl = cur.slice(S.page * PS, S.page * PS + PS);
  $('#tb').innerHTML = sl.length ? sl.map(rowHtml).join('') : `<tr><td colspan="7" class="empty">${emptyMsg()}</td></tr>`;
  $('#pinfo').textContent = `${cur.length.toLocaleString()} of ${SW.games.length.toLocaleString()} games · page ${S.page + 1}/${pages}`;
  $('#prev').disabled = S.page === 0; $('#next').disabled = S.page >= pages - 1;
  document.querySelectorAll('#thead th').forEach((th) => { const on = th.dataset.k === S.sort; th.classList.toggle('s', on); th.querySelector('.ar').textContent = on ? (S.dir > 0 ? '▲' : '▼') : ''; });
  renderSel(); renderTagList();
}
function renderSel() {
  const el = $('#selbar');
  el.innerHTML = S.sel.size ? [...S.sel].map((t) => `<button class="tg sh k${SW.cat(t)} x on" data-t="${t}">${esc(SW.tagName[t] || t)}</button>`).join('') + '<button class="btn" id="clr">Clear tags</button>' : '<span class="sm">Click any tag chip or pick from the list to filter.</span>';
  const c = $('#clr'); if (c) c.onclick = () => { S.sel.clear(); S.page = 0; renderList(); };
}
function renderTagList() {
  const cnt = {};
  for (const g of SW.games) { if (!pass(g)) continue; for (const t of inSet(g)) cnt[t] = (cnt[t] || 0) + 1; }
  const q = S.tq.toLowerCase();
  const ids = Object.keys(SW.tagName).map(Number).filter((i) => S.cats.has(SW.cat(i)) && (!q || SW.tagName[i].toLowerCase().includes(q)) && (cnt[i] > 0 || S.sel.has(i)));
  ids.sort((a, b) => (S.sel.has(b) - S.sel.has(a)) || (cnt[b] || 0) - (cnt[a] || 0));
  $('#taglist').innerHTML = ids.slice(0, 300).map((i) => `<button class="tl${S.sel.has(i) ? ' on' : ''}" data-t="${i}"><span class="l"><i class="d" style="background:var(--c${SW.cat(i)})"></i>${esc(SW.tagName[i])}</span><span class="n">${(cnt[i] || 0).toLocaleString()}</span></button>`).join('') || '<span class="sm">No tags.</span>';
}

function catBtns(el, set, fn) {
  el.innerHTML = CATN.map((n, i) => `<button class="cat" data-c="${i}" style="border-color:var(--c${i});color:var(--t${i})" aria-pressed="${set.has(i)}">${n}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('.cat'); if (!b) return; const c = +b.dataset.c; set.has(c) ? set.delete(c) : set.add(c); b.setAttribute('aria-pressed', set.has(c)); fn(); };
}
function seg(sel, key, fn) {
  const el = $(sel);
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S[key] = b.dataset.v; syncSeg(); fn(); };
}
function syncSeg() {
  for (const [id, key] of [['#mode', 'mode'], ['#scope', 'scope'], ['#bscope', 'scope'], ['#bsrc', 'bsrc'], ['#psrc', 'psrc'], ['#csrc', 'csrc']])
    document.querySelectorAll(id + ' button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === S[key]));
}

// ---- my list ---------------------------------------------------------------------------
const MCOLS = ['', 'Game', 'Why buy it', 'Price now', 'Price history (SteamDB)', 'Note', ''];
$('#mhead').innerHTML = MCOLS.map((c) => `<th style="cursor:default">${c}</th>`).join('');
function spark(h, low) {
  if (!h || h.length < 2) return '';
  const W = 110, H = 28, t0 = h[0][0], t1 = Date.now(), mx = Math.max(...h.map((p) => p[1])) || 1;
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W, y = (v) => H - 2 - (v / mx) * (H - 4);
  let d = `M${x(h[0][0]).toFixed(1)},${y(h[0][1]).toFixed(1)}`;
  for (let i = 1; i < h.length; i++) d += `H${x(h[i][0]).toFixed(1)}V${y(h[i][1]).toFixed(1)}`;
  d += `H${W}`;
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="none" stroke="var(--acc)" stroke-width="1.5"/></svg>`;
}
function whyOptions(sel) {
  const ws = SW.st.whys.slice();
  if (sel && !ws.includes(sel)) ws.push(sel);
  return `<option value="">— why? —</option>` + ws.map((w) => `<option${w === sel ? ' selected' : ''}>${esc(w)}</option>`).join('') + '<option value="__new">＋ New reason…</option>';
}
function renderMine() {
  const items = SW.st.list;
  $('#mycount').textContent = items.length;
  const f = $('#mwhy'), prev = f.value || '__all';
  f.innerHTML = '<option value="__all">All reasons</option><option value="__none">No reason yet</option>' + SW.st.whys.map((w) => `<option>${esc(w)}</option>`).join('');
  f.value = [...f.options].some((o) => o.value === prev) ? prev : '__all';
  const rows = items.filter((i) => f.value === '__all' || (f.value === '__none' ? !i.why : i.why === f.value));
  let total = 0;
  $('#mb').innerHTML = rows.map((i) => {
    const g = SW.byId.get(i.appid);
    if (!g) return `<tr><td></td><td>App ${i.appid} <span class="sm">(details pending)</span></td><td colspan="4"></td><td><button class="btn" data-rm="${i.appid}">Remove</button></td></tr>`;
    total += g.fin || 0;
    const hist = i.history
      ? `${spark(i.history)}<div class="sm">Low ${price(i.low)} · ${new Date(i.lowAt).toISOString().slice(0, 10)}${g.fin && g.fin <= i.low ? ' <b style="color:var(--good)">at low</b>' : ''}</div>`
      : `<button class="btn" data-db="${g.id}">Load from SteamDB</button>`;
    return `<tr><td style="width:34px">${starBtn(g)}</td><td>${gameCell(g)}</td>
 <td style="min-width:170px"><select class="why" data-why="${g.id}">${whyOptions(i.why)}</select></td>
 <td class="num">${g.disc > 0 ? `<span class="disc">-${g.disc}%</span> ` : ''}${priceCell(g)}</td>
 <td>${hist}</td><td><input type="text" class="note" data-note="${g.id}" value="${esc(i.note || '')}" placeholder="Note…"></td>
 <td><button class="btn" data-rm="${g.id}">Remove</button></td></tr>`;
  }).join('') || `<tr><td colspan="7" class="empty">${items.length ? 'No games with this reason.' : 'Your list is empty. Click ☆ next to a game on the Wishlist tab.'}</td></tr>`;
  $('#mtotal').textContent = rows.length ? `${rows.length} game${rows.length > 1 ? 's' : ''} · total ${price(total)}` : '';
}

// ---- dialogs -----------------------------------------------------------------------------
const dlg = $('#dlg');
function modal(html, onOpen) {
  dlg.innerHTML = `<div class="dlg">${html}</div>`;
  dlg.showModal();
  if (onOpen) onOpen(dlg);
  return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
}
const info = (title, body) => modal(`<h2>${esc(title)}</h2><div>${body}</div><form method="dialog" class="foot"><button class="btn pri" value="ok">OK</button></form>`);
async function promptText(title, label) {
  let val = '';
  const r = await modal(`<h2>${esc(title)}</h2><label>${esc(label)}<input type="text" id="pt"></label><form method="dialog" class="foot"><button class="btn" value="no">Cancel</button><button class="btn pri" value="ok">Add</button></form>`, (d) => {
    const i = d.querySelector('#pt'); i.focus(); i.onkeydown = (e) => { if (e.key === 'Enter') d.close('ok'); };
    d.addEventListener('close', () => { val = i.value.trim(); }, { once: true });
  });
  return r === 'ok' ? val : '';
}

async function openSettings() {
  const s = SW.st.settings, whys = SW.st.whys.join('\n');
  const cache = await api.cacheInfo().catch(() => ({ files: 0, bytes: 0 }));
  const r = await modal(`<h2>Settings</h2>
 <label>Store country (prices & currency, 2-letter code)<input type="text" id="s-cc" value="${esc(s.country)}" maxlength="2"></label>
 <label class="ck"><input type="checkbox" id="s-fam"${s.excludeFamily ? ' checked' : ''}> Exclude games already in my Steam Family library</label>
 <div class="row"><button class="btn" id="s-login">${s.hasToken ? 'Re-sign in to Steam' : 'Sign in to Steam to read family library'}</button>${s.hasToken ? '<button class="btn" id="s-logout">Sign out</button><span class="sm">signed in (token lasts ~24h)</span>' : ''}</div>
 <label>…or list family members' profiles (usernames or URLs, one per line; their game details must be public)<textarea id="s-mem">${esc(s.familyMembers)}</textarea></label>
 <label>Steam Web API key (optional, reads private-ish libraries more reliably)<input type="text" id="s-key" value="${esc(s.apiKey)}" autocomplete="off"></label>
 <label>Slowness multiplier (1 = default pacing, 2 = twice as slow)<input type="text" id="s-slow" value="${s.slowness}"></label>
 <label>“Why buy” reasons (one per line)<textarea id="s-why">${esc(whys)}</textarea></label>
 <hr>
 <div class="row"><button class="btn" id="s-sdb">Open SteamDB check</button><span class="sm">If SteamDB shows a Cloudflare check, solve it once here.</span></div>
 <div class="row"><button class="btn" id="s-log">Open log folder</button><span class="sm">Attach <code>app.log</code> when reporting a problem. API keys and tokens are scrubbed.</span></div>
 <div class="row"><button class="btn" id="s-clr">Clear image cache</button><span class="sm">${cache.files} files · ${(cache.bytes / 1048576).toFixed(1)} MB</span></div>
 <form method="dialog" class="foot"><button class="btn" value="no">Cancel</button><button class="btn pri" value="ok">Save</button></form>`, (d) => {
    d.querySelector('#s-login').onclick = async () => { try { await api.steamLogin(); d.close('login'); } catch (e) { info('Sign-in failed', esc(e.message)); } };
    const lo = d.querySelector('#s-logout'); if (lo) lo.onclick = async () => { await api.steamLogout(); d.close('login'); };
    d.querySelector('#s-log').onclick = () => api.openLogs().catch((e) => info('Log folder', esc(e.message)));
    d.querySelector('#s-sdb').onclick = () => api.steamdbCheck();
    d.querySelector('#s-clr').onclick = async () => { await api.cacheClear(); d.querySelector('#s-clr').textContent = 'Cleared'; };
  });
  if (r !== 'ok') return;
  const v = (id) => dlg.querySelector(id);
  await api.setSettings({ country: v('#s-cc').value, excludeFamily: v('#s-fam').checked, familyMembers: v('#s-mem').value, apiKey: v('#s-key').value.trim(), slowness: v('#s-slow').value });
  if (SW.st.profile) await api.setWhys(v('#s-why').value.split('\n'));
}

// ---- actions -----------------------------------------------------------------------------
async function runSync(mode) {
  const name = $('#user').value.trim();
  if (!name) return info('Steam username needed', 'Type your Steam username (or profile URL) in the box at the top.');
  await api.setSettings({ username: name });
  const res = await api.sync(mode);
  if (res.removedFromList.length) {
    info('Cleared from your list', `<ul>${res.removedFromList.map((x) => `<li>${esc(x.name)} <span class="sm">${x.bought ? '(now in your library)' : '(no longer on your wishlist)'}</span></li>`).join('')}</ul>`);
  }
}
function setBusy(b) { for (const id of ['#sync', '#prices', '#bought']) $(id).disabled = b; $('#user').disabled = b; }

document.addEventListener('click', (e) => {
  const t = e.target;
  const tg = t.closest('.tg[data-t],.tl[data-t]');
  if (tg && tg.closest('#v-list')) { const id = +tg.dataset.t; S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); S.page = 0; renderList(); return; }
  const st = t.closest('[data-star]');
  if (st) { const id = +st.dataset.star; (SW.listIds.has(id) ? api.listRemove(id) : api.listAdd(id)).catch((er) => info('Error', esc(er.message))); return; }
  const rm = t.closest('[data-rm]'); if (rm) { api.listRemove(+rm.dataset.rm); return; }
  const db = t.closest('[data-db]');
  if (db) { db.disabled = true; db.textContent = 'Loading… (a SteamDB window may open)'; api.steamdbFetch(+db.dataset.db).catch((er) => { info('SteamDB', esc(er.message) + (er.message.includes('Cloudflare') ? '<br>Use Settings → “Open SteamDB check”.' : '')); db.disabled = false; db.textContent = 'Load from SteamDB'; }); return; }
  const a = t.closest('a[data-open]'); if (a) { e.preventDefault(); api.open(a.href); }
});
document.addEventListener('change', async (e) => {
  const w = e.target.closest && e.target.closest('[data-why]');
  if (!w) return;
  const id = +w.dataset.why;
  if (w.value === '__new') {
    const v = await promptText('New reason', 'Why would you buy a game?');
    if (v) { await api.setWhys([...SW.st.whys, v]); await api.listSet(id, { why: v }); } else renderMine();
    return;
  }
  api.listSet(id, { why: w.value });
});
document.addEventListener('input', (e) => { const n = e.target.closest && e.target.closest('[data-note]'); if (n) { clearTimeout(n._t); n._t = setTimeout(() => api.listSet(+n.dataset.note, { note: n.value }), 500); } });
$('#mwhy').onchange = renderMine;
$('#sync').onclick = () => runSync('sync').catch((e) => info('Sync failed', esc(e.message)));
$('#prices').onclick = () => runSync('prices').catch((e) => info('Sync failed', esc(e.message)));
$('#bought').onclick = () => runSync('sync').catch((e) => info('Sync failed', esc(e.message)));
$('#user').onkeydown = (e) => { if (e.key === 'Enter') $('#sync').click(); };
$('#cancel').onclick = () => api.cancel();
$('#cfg').onclick = openSettings;

catBtns($('#cats'), S.cats, renderTagList);
seg('#mode', 'mode', () => { S.page = 0; renderList(); });
seg('#scope', 'scope', () => { S.page = 0; renderList(); });
let tm; const deb = (f) => { clearTimeout(tm); tm = setTimeout(f, 150); };
$('#tq').oninput = (e) => { S.tq = e.target.value; renderTagList(); };
$('#q').oninput = (e) => { S.q = e.target.value.trim().toLowerCase(); S.page = 0; deb(renderList); };
for (const [id, key] of [['#ft', 'type'], ['#fs', 'sale'], ['#fr', 'rel'], ['#fl', 'lst']]) $(id).onchange = (e) => { S[key] = e.target.value; S.page = 0; renderList(); };
$('#prev').onclick = () => { S.page--; renderList(); };
$('#next').onclick = () => { S.page++; renderList(); window.scrollTo(0, 0); };
$('#reset').onclick = () => {
  S.sel.clear(); S.q = ''; S.type = S.sale = S.rel = S.lst = 'all'; S.mode = 'and'; S.scope = 'all'; S.tq = ''; S.page = 0;
  $('#q').value = ''; $('#tq').value = ''; for (const id of ['#ft', '#fs', '#fr', '#fl']) $(id).value = 'all'; syncSeg(); renderList();
};

// ---- chrome (header, progress, tabs) ---------------------------------------------------------
function renderChrome() {
  const st = SW.st, c = st.counts || {};
  $('#stats').textContent = st.profile
    ? `${st.profile.name} · ${SW.games.length.toLocaleString()} wishlisted titles · ${Object.keys(st.tags).length} tags` +
      (c.hiddenOwned ? ` · ${c.hiddenOwned} owned hidden` : '') + (c.hiddenFamily ? ` · ${c.hiddenFamily} in family library hidden` : '') + (c.pending ? ` · ${c.pending} pending` : '') + (c.unavailable ? ` · ${c.unavailable} unavailable on Steam` : '')
    : 'No profile loaded';
  if (document.activeElement !== $('#user')) $('#user').value = st.settings.username || '';
  $('#legend').innerHTML = CATN.map((n, i) => `<span class="it"><i class="sw" style="background:var(--c${i})"></i>${n}</span>`).join('') +
    '<span class="it"><span class="tg sh k1" style="cursor:default">solid</span>shown on Steam</span><span class="it"><span class="tg ex k1" style="cursor:default">outline</span>extra tag</span>';
  $('#warns').innerHTML = (st.status.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
  $('#mycount').textContent = st.list.length;
  onProgress(st.status);
}
function onProgress(s) {
  SW.st && (SW.st.status = s);
  $('#progress').hidden = !s.running;
  setBusy(s.running);
  $('#pmsg').textContent = s.msg;
  const bar = $('.pbar'); bar.classList.toggle('ind', !s.total);
  $('#pfill').style.width = s.total ? Math.round((s.done / s.total) * 100) + '%' : '';
}

function show(tab) {
  SW.tab = tab;
  for (const [id, k] of [['list', 'list'], ['mine', 'mine'], ['bub', 'bub'], ['pd', 'pd'], ['cov', 'cov']]) $('#v-' + id).hidden = tab !== k;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
  try { history.replaceState(null, '', '#' + tab); } catch (_) {}
  renderTab();
}
function renderTab() {
  if (!SW.st) return;
  syncSeg();
  if (SW.tab === 'list') renderList();
  else if (SW.tab === 'mine') renderMine();
  else if (SW.charts[SW.tab]) SW.charts[SW.tab]();
}
document.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.tab); };
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (['bub', 'pd', 'cov'].includes(SW.tab)) renderTab(); }, 200); });
