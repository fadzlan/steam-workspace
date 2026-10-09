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
const pref = (k, d) => { try { return localStorage.getItem('sw-' + k) || d; } catch (_) { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('sw-' + k, v); } catch (_) {} };
S.fam = pref('fam', 'all'); // family filter: all | hide | only | m:<steamid>
S.mtags = pref('mtags', 'shown'); // My list: 'shown' = the 5 Steam shows, 'all' = every tag
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

function famMatch(g) {
  const f = g.fam || [];
  if (S.fam === 'hide') return f.length === 0;
  if (S.fam === 'only') return f.length > 0;
  if (S.fam.startsWith('m:')) return f.includes(S.fam.slice(2));
  return true;
}
const famNames = (g) => (g.fam || []).map((id) => (SW.st.profile.familyNames || {})[id] || 'a family member');

function pass(g, skipTags) {
  if (!famMatch(g)) return false;
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
// Hover preview: SteamDB's micro-trailer (muted, looping) plays over the thumbnail.
document.addEventListener('mouseover', (e) => {
  const i = e.target.closest && e.target.closest('img[data-gif="1"]');
  if (!i || i.parentNode.querySelector('video')) return;
  const v = document.createElement('video');
  Object.assign(v, { src: `swimg://hover/${i.dataset.id}`, muted: true, loop: true, autoplay: true, playsInline: true, className: 'hovervid' });
  v.onerror = () => v.remove();
  i.parentNode.appendChild(v);
  v.play().catch(() => {});
});
document.addEventListener('mouseout', (e) => {
  const th = e.target.closest && e.target.closest('.th');
  if (th && !th.contains(e.relatedTarget)) th.querySelectorAll('video').forEach((v) => v.remove());
});

// ---- wishlist table --------------------------------------------------------------------
// ---- toggleable columns -------------------------------------------------------------------------------
const rel = (ms) => { // "in 12 days" / "8 days ago"
  const d = ms - Date.now(), a = Math.abs(d), m = 6e4, h = 36e5, day = 864e5;
  const t = a < h ? `${Math.max(1, Math.round(a / m))} min` : a < 2 * day ? `${Math.round(a / h)} hours` : `${Math.round(a / day)} days`;
  return d >= 0 ? `in ${t}` : `${t} ago`;
};
const endCell = (g) => (g.disc > 0 && g.end ? `<span title="${new Date(g.end * 1000).toLocaleString()}"${g.end * 1000 < Date.now() ? ' class="sm"' : ''}>${g.end * 1000 < Date.now() ? 'ended ' : ''}${rel(g.end * 1000)}</span>` : '<span class="sm">—</span>');
const savedCell = (g) => (g.disc > 0 && g.orig > g.fin ? `<span class="saved">${price(g.orig - g.fin)}</span>` : '<span class="sm">—</span>');

// id, header, td class, sort key, cell(g, listItem), hidden by default
const LIST_COLS = [
  { id: 'disc', h: 'Discount', cls: 'num', sort: 'disc', cell: (g) => (g.disc > 0 ? `<span class="disc">-${g.disc}%</span>` : '<span class="sm">—</span>') },
  { id: 'fin', h: 'Price', cls: 'num', sort: 'fin', cell: (g) => priceCell(g) },
  { id: 'saved', h: 'Saved', cls: 'num', sort: 'saved', cell: savedCell },
  { id: 'ends', h: 'Sale ends', cls: 'dv', sort: 'end', cell: endCell },
  { id: 'rp', h: 'Rating', cls: 'num', sort: 'rp', cell: (g) => ratingCell(g) },
  { id: 'rel', h: 'Release', cls: 'dv', sort: 'rel', cell: (g) => (g.st === 2 && !g.rel ? '<span class="sm">TBA</span>' : dstr(g.rel)) },
  { id: 'dev', h: 'Developer / publisher', cls: 'dv', sort: 'dev', cell: (g) => `${esc(g.dev || '—')}${g.pub && g.pub !== g.dev ? `<div class="sm">${esc(g.pub)}</div>` : ''}` },
];
const colOn = (table, c) => { const hidden = pref('cols-' + table, null); return hidden === null ? !c.off : !hidden.split(',').includes(c.id); };
function colMenu(table, defs, rerender) {
  const det = $('#colmenu-' + table);
  det.querySelector('.menu').innerHTML = defs.map((c) => `<label class="ck"><input type="checkbox" data-col="${c.id}"${colOn(table, c) ? ' checked' : ''}> ${c.h.replace(/<br>/g, ' ')}${c.note ? ` <span class="sm">(${c.note})</span>` : ''}</label>`).join('');
  det.querySelector('.menu').onchange = (e) => {
    const hidden = defs.filter((c) => !det.querySelector(`[data-col="${c.id}"]`).checked).map((c) => c.id);
    setPref('cols-' + table, hidden.join(',') || '-'); // '-' = nothing hidden (an empty value would mean "no choice yet")
    rerender();
  };
}
document.addEventListener('click', (e) => document.querySelectorAll('details.colmenu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; }));
const listCols = () => LIST_COLS.filter((c) => colOn('list', c));
function renderHead() {
  $('#thead').innerHTML = '<th data-k=""></th><th data-k="name">Game<span class="ar"></span></th>' + listCols().map((c) => `<th data-k="${c.sort}" class="${c.cls === 'num' ? 'num' : ''}">${c.h}<span class="ar"></span></th>`).join('');
}
$('#thead').onclick = (e) => {
  const th = e.target.closest('th'); if (!th || !th.dataset.k) return;
  const k = th.dataset.k;
  if (S.sort === k) S.dir *= -1; else { S.sort = k; S.dir = k === 'name' || k === 'dev' || k === 'fin' || k === 'end' ? 1 : -1; }
  S.page = 0; renderList();
};
function cmp(a, b) {
  const k = S.sort; let x = a[k], y = b[k];
  if (k === 'fin') { x = a.st === 1 ? 0 : a.fin || 1e9; y = b.st === 1 ? 0 : b.fin || 1e9; }
  if (k === 'end') { x = a.disc > 0 && a.end ? a.end : (S.dir > 0 ? 1e12 : 0); y = b.disc > 0 && b.end ? b.end : (S.dir > 0 ? 1e12 : 0); }
  if (k === 'saved') { x = a.disc > 0 ? a.orig - a.fin : 0; y = b.disc > 0 ? b.orig - b.fin : 0; }
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
  if (g.st === 1 || (!g.fin && !g.orig)) return g.st === 1 ? '<span class="sm">Free</span>' : '—';
  return (g.disc > 0 ? `<span class="old">${esc(g.fOrig)}</span>` : '') + esc(g.fFin);
}
const ratingCell = (g) => g.rc
  ? `<div class="rv"><span>${g.rp}%</span><span class="rvb"><i style="width:${g.rp}%;background:${g.rp >= 70 ? 'var(--good)' : g.rp >= 40 ? 'var(--mixed)' : 'var(--bad)'}"></i></span><span class="sm">${g.rc.toLocaleString()}</span></div>`
  : '<span class="sm">—</span>';
const starBtn = (g) => `<button class="star${SW.listIds.has(g.id) ? ' on' : ''}" data-star="${g.id}" title="${SW.listIds.has(g.id) ? 'Remove from my list' : 'Add to my list'}">${SW.listIds.has(g.id) ? '★' : '☆'}</button>`;
const famBadge = (g) => (g.fam && g.fam.length ? `<span class="famb" title="Owned in your Steam Family library">👪 ${esc(famNames(g).join(', '))}</span>` : '');
const gameCell = (g, extra = '') => `<div class="gm"><div class="th">${thumb(g)}</div><div class="gn"><a href="https://store.steampowered.com/app/${g.id}" data-open>${esc(g.name)}</a>${g.type === 4 ? '<span class="badge" style="width:max-content;margin:0">DLC</span>' : ''}${famBadge(g)}${extra}</div></div>`;

function rowHtml(g, cols) {
  return `<tr><td style="width:34px">${starBtn(g)}</td><td>${gameCell(g, `<div class="tags">${g.tags.map((t, i) => chip(g, t, i)).join('')}</div>`)}</td>` +
    cols.map((c) => `<td class="${c.cls}"${c.id === 'rel' ? ' style="white-space:nowrap"' : ''}>${c.cell(g)}</td>`).join('') + '</tr>';
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
  const cols = listCols();
  renderHead();
  $('#tb').innerHTML = sl.length ? sl.map((g) => rowHtml(g, cols)).join('') : `<tr><td colspan="${cols.length + 2}" class="empty">${emptyMsg()}</td></tr>`;
  $('#pinfo').textContent = `${cur.length.toLocaleString()} of ${SW.games.length.toLocaleString()} games · page ${S.page + 1}/${pages}`;
  $('#prev').disabled = S.page === 0; $('#next').disabled = S.page >= pages - 1;
  document.querySelectorAll('#thead th').forEach((th) => { const on = th.dataset.k === S.sort; th.classList.toggle('s', on); const ar = th.querySelector('.ar'); if (ar) ar.textContent = on ? (S.dir > 0 ? '▲' : '▼') : ''; });
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
  for (const [id, key] of [['#mode', 'mode'], ['#scope', 'scope'], ['#bscope', 'scope'], ['#bsrc', 'bsrc'], ['#psrc', 'psrc'], ['#csrc', 'csrc'], ['#mtags', 'mtags']])
    document.querySelectorAll(id + ' button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === S[key]));
}

// ---- collapsible tag filter ----------------------------------------------------------------------------
function applyTagsPanel() {
  const off = pref('tagsoff', '') === '1';
  $('#v-list .layout').classList.toggle('tagsoff', off);
  const b = $('#tagtoggle');
  b.textContent = off ? '»' : '«';
  b.title = off ? 'Show tag filter' : 'Hide tag filter';
  b.setAttribute('aria-expanded', String(!off));
}
$('#tagtoggle').onclick = () => { setPref('tagsoff', pref('tagsoff', '') === '1' ? '' : '1'); applyTagsPanel(); };
applyTagsPanel();

// ---- my list ---------------------------------------------------------------------------
// (header/cells for My list are built in renderMine from MINE_COLS below)
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
const MINE_COLS = [
  { id: 'why', h: 'Why buy it', cls: 'c-why', cell: (g, i) => `<select class="why" data-why="${g.id}">${whyOptions(i.why)}</select>` },
  { id: 'price', h: 'Price now', cls: 'num', cell: (g) => `${g.disc > 0 ? `<span class="disc">-${g.disc}%</span> ` : ''}${priceCell(g)}` },
  { id: 'saved', h: 'Saved', cls: 'num', cell: savedCell },
  { id: 'ends', h: 'Sale ends', cls: 'dv', cell: endCell },
  { id: 'hist', h: 'Price history<br>(SteamDB)', cls: 'c-hist', cell: (g, i) => histCell(g, i) },
  { id: 'note', h: 'Note', cls: 'c-note', cell: (g, i) => `<textarea class="note" rows="4" data-note="${g.id}" placeholder="Note…">${esc(i.note || '')}</textarea>` },
];
const mineCols = () => MINE_COLS.filter((c) => colOn('mine', c));
function histCell(g, i) {
  // the SteamDB data was fetched during a sale that has since ended: it no longer reflects the price
  const stale = i.saleEnd && Date.now() / 1000 > i.saleEnd && (i.dbAt || 0) / 1000 < i.saleEnd;
  if (!i.history) return `<button class="btn" data-db="${g.id}">Load from SteamDB</button>`;
  return `${spark(i.history)}<div class="sm">${i.more ? '2-year low' : 'Low'} ${price(i.low)}${g.fin && g.fin <= i.low ? ' <b style="color:var(--good)">at low</b>' : ''}<br>${new Date(i.lowAt).toISOString().slice(0, 10)}</div>` +
    (stale ? `<button class="btn warn" data-db="${g.id}" title="The sale this data was fetched during has ended, so it is out of date">Sale ended · update</button>`
           : `<button class="btn tiny" data-db="${g.id}" title="Refresh from SteamDB${i.dbAt ? ' (last fetched ' + new Date(i.dbAt).toLocaleString() + ')' : ''}">↻ refresh</button>`);
}
function renderMine() {
  const items = SW.st.list;
  $('#mycount').textContent = items.length;
  const f = $('#mwhy'), prev = f.value || '__all';
  f.innerHTML = '<option value="__all">All reasons</option><option value="__none">No reason yet</option>' + SW.st.whys.map((w) => `<option>${esc(w)}</option>`).join('');
  f.value = [...f.options].some((o) => o.value === prev) ? prev : '__all';
  const rows = items.filter((i) => f.value === '__all' || (f.value === '__none' ? !i.why : i.why === f.value));
  const cols = mineCols();
  $('#mhead').innerHTML = '<th></th><th>Game</th>' + cols.map((c) => `<th class="${c.cls}" style="cursor:default">${c.h}</th>`).join('') + '<th></th>';
  let total = 0;
  $('#mb').innerHTML = rows.map((i) => {
    const g = SW.byId.get(i.appid);
    if (!g) return `<tr><td></td><td>App ${i.appid} <span class="sm">(details pending)</span></td><td colspan="${cols.length}"></td><td><button class="btn" data-rm="${i.appid}">Remove</button></td></tr>`;
    total += g.fin || 0;
    const tags = g.tags.map((t, k) => [t, k]).filter(([, k]) => S.mtags === 'all' || k < 5).map(([t, k]) => chip(g, t, k)).join('');
    return `<tr><td style="width:34px">${starBtn(g)}</td><td>${gameCell(g)}<div class="tags mtags">${tags}</div></td>` +
      cols.map((c) => `<td class="${c.cls}">${c.cell(g, i)}</td>`).join('') + `<td><button class="btn" data-rm="${g.id}">Remove</button></td></tr>`;
  }).join('') || `<tr><td colspan="${cols.length + 3}" class="empty">${items.length ? 'No games with this reason.' : 'Your list is empty. Click ☆ next to a game on the Wishlist tab.'}</td></tr>`;
  $('#mtotal').textContent = rows.length ? `${rows.length} game${rows.length > 1 ? 's' : ''} · total ${price(total)}` : '';
}
colMenu('list', LIST_COLS, () => renderList());
colMenu('mine', MINE_COLS, () => renderMine());

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
 <label class="ck"><input type="checkbox" id="s-fam"${s.useFamily ? ' checked' : ''}> Read my Steam Family library (adds 👪 badges and a Family filter on the Wishlist tab)</label>
 <div class="row"><button class="btn" id="s-login">${s.hasToken ? 'Re-sign in to Steam' : 'Sign in to Steam to read family library'}</button>${s.hasToken ? '<button class="btn" id="s-logout">Sign out</button><span class="sm">signed in (token lasts ~24h)</span>' : ''}</div>
 <label>…or list family members' profiles (usernames or URLs, one per line; their game details must be public)<textarea id="s-mem">${esc(s.familyMembers)}</textarea></label>
 <label>Steam Web API key (optional, reads private-ish libraries more reliably)<input type="text" id="s-key" value="${esc(s.apiKey)}" autocomplete="off"></label>
 <label>Firecrawl API key (optional, replaces the SteamDB browser window)<input type="text" id="s-fc" value="${esc(s.firecrawlKey || '')}" autocomplete="off" placeholder="fc-…"></label>
 <label class="ck"><input type="checkbox" id="s-usefc"${s.useFirecrawl ? ' checked' : ''}> Use Firecrawl for SteamDB (about 2 credits per game; no browser window or Cloudflare check)</label>
 <div class="row"><button class="btn" id="s-fctest">Test Firecrawl</button><span class="sm" id="s-fcres">Uses 1 credit.</span></div>
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
    d.querySelector('#s-fctest').onclick = async () => {
      const out = d.querySelector('#s-fcres'), key = d.querySelector('#s-fc').value.trim();
      if (!key) { out.textContent = 'Enter the API key first.'; return; }
      out.textContent = 'Testing…';
      try { await api.setSettings({ firecrawlKey: key }); const r = await api.firecrawlTest(); out.textContent = (r.ok ? '✓ ' : '⚠ ') + r.message; } catch (e) { out.textContent = '✗ ' + e.message; }
    };
    d.querySelector('#s-sdb').onclick = () => api.steamdbCheck();
    d.querySelector('#s-clr').onclick = async () => { await api.cacheClear(); d.querySelector('#s-clr').textContent = 'Cleared'; };
  });
  if (r !== 'ok') return;
  const v = (id) => dlg.querySelector(id);
  await api.setSettings({ country: v('#s-cc').value, useFamily: v('#s-fam').checked, familyMembers: v('#s-mem').value, apiKey: v('#s-key').value.trim(), firecrawlKey: v('#s-fc').value.trim(), useFirecrawl: v('#s-usefc').checked, slowness: v('#s-slow').value });
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

function showUnavailable() {
  const un = SW.st.unavailable || [];
  info(`${un.length} wishlist item${un.length === 1 ? '' : 's'} unavailable on Steam`,
    `<p class="sm">Steam returns no store data for these: they were delisted, removed, region-locked or are hidden. They stay on your Steam wishlist; the app just can't show them. They are re-checked about once a week.</p>
     <ul class="unlist">${un.map((g) => `<li><span>${esc(g.name || 'App ' + g.id)} <span class="sm">#${g.id}</span></span>
       <span><a href="https://store.steampowered.com/app/${g.id}" data-open>Store</a> · <a href="https://steamdb.info/app/${g.id}/" data-open>SteamDB</a></span></li>`).join('')}</ul>`);
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('#unavail')) { e.preventDefault(); showUnavailable(); return; }
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

// ---- theme: System (follow the OS) / Light / Dark -----------------------------------------------------------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
}
$('#theme').value = pref('theme', 'system');
$('#theme').onchange = (e) => { setPref('theme', e.target.value); applyTheme(e.target.value); };
seg('#mtags', 'mtags', () => { setPref('mtags', S.mtags); renderMine(); });

catBtns($('#cats'), S.cats, renderTagList);
seg('#mode', 'mode', () => { S.page = 0; renderList(); });
seg('#scope', 'scope', () => { S.page = 0; renderList(); });
let tm; const deb = (f) => { clearTimeout(tm); tm = setTimeout(f, 150); };
$('#tq').oninput = (e) => { S.tq = e.target.value; renderTagList(); };
$('#q').oninput = (e) => { S.q = e.target.value.trim().toLowerCase(); S.page = 0; deb(renderList); };
$('#ffam').onchange = (e) => { S.fam = e.target.value; setPref('fam', S.fam); S.page = 0; renderTab(); };
for (const [id, key] of [['#ft', 'type'], ['#fs', 'sale'], ['#fr', 'rel'], ['#fl', 'lst']]) $(id).onchange = (e) => { S[key] = e.target.value; S.page = 0; renderList(); };
$('#prev').onclick = () => { S.page--; renderList(); };
$('#next').onclick = () => { S.page++; renderList(); window.scrollTo(0, 0); };
$('#reset').onclick = () => {
  S.sel.clear(); S.q = ''; S.type = S.sale = S.rel = S.lst = S.fam = 'all'; setPref('fam', 'all'); if (!$('#ffam').hidden) $('#ffam').value = 'all'; S.mode = 'and'; S.scope = 'all'; S.tq = ''; S.page = 0;
  $('#q').value = ''; $('#tq').value = ''; for (const id of ['#ft', '#fs', '#fr', '#fl']) $(id).value = 'all'; syncSeg(); renderList();
};

// ---- chrome (header, progress, tabs) ---------------------------------------------------------
function renderFamilyFilter() {
  const el = $('#ffam'), st = SW.st;
  el.hidden = !(st.settings.useFamily && st.profile && st.profile.familyKnown);
  if (el.hidden) { S.fam = 'all'; return; }
  const names = st.profile.familyNames || {};
  const owners = new Set(SW.games.flatMap((g) => g.fam || []));
  el.innerHTML = '<option value="all">Family: show all</option><option value="hide">Hide family-owned</option><option value="only">Only family-owned</option>' +
    [...owners].filter((id) => id !== '?').map((id) => `<option value="m:${id}">Owned by ${esc(names[id] || id)}</option>`).join('');
  if (![...el.options].some((o) => o.value === S.fam)) S.fam = 'all';
  el.value = S.fam;
}

// ---- SteamDB background loader -----------------------------------------------------------------------------------
let bgDismissed = '';
const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function renderBg() {
  const b = SW.st.bg || { running: false }, bar = $('#bgbar');
  $('#bgbtn').textContent = b.running ? 'Stop background load' : 'Load SteamDB in background';
  $('#bgscope').disabled = !!b.running;
  const key = `${b.scope}|${b.done}|${b.failed}|${b.blocked ? b.blocked.kind : ''}`;
  const pct = b.total ? Math.round(((b.done + b.failed) / b.total) * 100) : 0;
  if (b.running) {
    bar.hidden = false;
    bar.innerHTML = `<div class="pmsg"><span>SteamDB background load: ${b.done + b.failed} of ${b.total}${b.failed ? ` (${b.failed} without data)` : ''} · ${b.next ? 'next game in <b id="bgcd"></b>' : `loading ${esc(b.name)}…`}</span><button class="btn" id="bgstop">Stop</button></div><div class="pbar"><i style="width:${pct}%"></i></div>`;
  } else if (b.blocked) {
    bar.hidden = false;
    bar.innerHTML = `<div class="pmsg"><span>SteamDB background load stopped: ${esc(b.blocked.msg)} (${b.done} loaded so far). ${b.blocked.kind === 'challenge' ? 'Open the SteamDB page, solve the check, then resume.' : ''}</span><span class="row">${b.blocked.kind === 'firecrawl' ? '<button class="btn" id="bgsettings">Open Settings</button>' : '<button class="btn" id="bgcheck">Open SteamDB page</button>'}<button class="btn pri" id="bgresume">Resume</button></span></div>`;
  } else if ((b.done || b.failed) && bgDismissed !== key) {
    bar.hidden = false;
    bar.innerHTML = `<div class="pmsg"><span>SteamDB background load finished: ${b.done} loaded${b.failed ? `, ${b.failed} had no data` : ''}.</span><button class="btn" id="bgdismiss" data-key="${esc(key)}">Dismiss</button></div>`;
  } else bar.hidden = true;
}
setInterval(() => { const el = $('#bgcd'), b = SW.st && SW.st.bg; if (el && b && b.next) el.textContent = mmss(b.next - Date.now()); }, 1000);
$('#bgscope').value = pref('bgscope', 'mine');
$('#bgscope').onchange = (e) => setPref('bgscope', e.target.value);
const bgStart = () => api.bgStart($('#bgscope').value).catch((e) => info('SteamDB', esc(e.message)));
$('#bgbtn').onclick = () => (SW.st.bg && SW.st.bg.running ? api.bgStop() : bgStart());
$('#bgbar').onclick = (e) => {
  const id = e.target.id;
  if (id === 'bgstop') api.bgStop();
  else if (id === 'bgresume') { api.bgStart((SW.st.bg && SW.st.bg.scope) || $('#bgscope').value).catch((er) => info('SteamDB', esc(er.message))); }
  else if (id === 'bgcheck') api.steamdbCheck();
  else if (id === 'bgsettings') openSettings();
  else if (id === 'bgdismiss') { bgDismissed = e.target.dataset.key; renderBg(); }
};

function renderChrome() {
  const st = SW.st, c = st.counts || {};
  const un = st.unavailable || [];
  const tip = un.slice(0, 25).map((g) => g.name || 'App ' + g.id).join('\n') + (un.length > 25 ? `\n… and ${un.length - 25} more` : '');
  $('#stats').innerHTML = st.profile
    ? esc(`${st.profile.name} · ${SW.games.length.toLocaleString()} wishlisted titles · ${Object.keys(st.tags).length} tags` +
      (c.hiddenOwned ? ` · ${c.hiddenOwned} owned hidden` : '') + (c.familyOwned ? ` · ${c.familyOwned} in family library` : '') + (c.pending ? ` · ${c.pending} pending` : '')) +
      (c.unavailable ? ` · <a href="#" id="unavail" class="statlink" title="${esc(tip)}">${c.unavailable} unavailable on Steam</a>` : '')
    : 'No profile loaded';
  renderFamilyFilter();
  renderBg();
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
