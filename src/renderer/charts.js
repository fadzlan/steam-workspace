'use strict';
/* Tag bubbles, price × discount (tags) and price × discount (covers). Uses globals from app.js. */
const tip = $('#tip');
function showTip(e, html) {
  tip.style.display = 'block'; tip.innerHTML = html;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - 240) + 'px'; tip.style.top = Math.min(e.clientY + 14, innerHeight - 90) + 'px';
}
const hideTip = () => { tip.style.display = 'none'; };
const pool = (src) => (src === 'mine' ? SW.games.filter((g) => SW.listIds.has(g.id)) : SW.games);
const empty = (host, msg) => { host.innerHTML = `<div class="hello">${msg}</div>`; };
function drillToWishlist(tagId) { hideTip(); S.sel = new Set([tagId]); S.page = 0; show('list'); window.scrollTo(0, 0); }

// ---- tag bubbles (area = games with tag; dark core = those also in My list) -------------
SW.charts.bub = function drawBub() {
  const host = $('#bub'), W = host.clientWidth; if (!W) return;
  const games = pool(S.bsrc), cnt = {}, lcnt = {};
  for (const g of games) for (const t of inSet(g)) { cnt[t] = (cnt[t] || 0) + 1; if (SW.listIds.has(g.id)) lcnt[t] = (lcnt[t] || 0) + 1; }
  const ids = Object.keys(cnt).map(Number).filter((i) => S.bcats.has(SW.cat(i))).sort((a, b) => cnt[b] - cnt[a]).slice(0, S.topn);
  if (!ids.length) return empty(host, S.bsrc === 'mine' ? 'Add games to My list (☆ on the Wishlist tab) to see their tags here.' : 'No data yet. Sync your wishlist first.');
  const H = Math.round(Math.min(Math.max(W * 0.8, 420), 820));
  const root = d3.hierarchy({ children: ids.map((i) => ({ i, v: cnt[i], l: lcnt[i] || 0 })) }).sum((d) => d.v || 0);
  d3.pack().size([W, H]).padding(3)(root);
  host.innerHTML = '';
  const svg = d3.select(host).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Bubble chart of tags');
  const n = svg.selectAll('g').data(root.leaves()).join('g').attr('class', 'bubnode').attr('transform', (d) => `translate(${d.x},${d.y})`);
  n.append('circle').attr('r', (d) => d.r).attr('fill', (d) => `var(--c${SW.cat(d.data.i)})`);
  n.filter((d) => d.data.l > 0 && S.bsrc === 'wish').append('circle').attr('class', 'core').attr('r', (d) => Math.max(3, d.r * Math.sqrt(d.data.l / d.data.v)));
  n.filter((d) => d.r > 20).append('text').attr('dy', (d) => (d.r > 30 ? '-0.1em' : '0.32em')).text((d) => { const s = SW.tagName[d.data.i]; const m = Math.floor((d.r * 2) / 6.2); return s.length > m ? s.slice(0, Math.max(m - 1, 2)) + '…' : s; });
  n.filter((d) => d.r > 30).append('text').attr('class', 'c').attr('dy', '1.15em').text((d) => d.data.v.toLocaleString() + (d.data.l && S.bsrc === 'wish' ? ` · ★${d.data.l}` : ''));
  n.on('mousemove', (e, d) => showTip(e, `<b>${esc(SW.tagName[d.data.i])}</b><br>${d.data.v.toLocaleString()} games · ${CATN[SW.cat(d.data.i)]}${d.data.l ? `<br>★ ${d.data.l} in my list` : ''}<br><span class="sm">Click to filter wishlist</span>`))
    .on('mouseleave', hideTip).on('click', (e, d) => drillToWishlist(d.data.i));
};

// ---- shared axes ----------------------------------------------------------------------------
const M = { l: 62, r: 20, t: 14, b: 44 };
function plotScales(W, H, maxDisc, maxPrice, fit) {
  // fit = [minDisc, minPrice]: zoom to the data extent (tag medians cluster tightly); otherwise start at 0.
  if (fit) {
    const dx = Math.max(10, maxDisc - fit[0]), dy = Math.max(2, maxPrice - fit[1]);
    const x0 = Math.max(0, Math.floor((fit[0] - dx * 0.15) / 5) * 5), x1 = Math.min(100, Math.ceil((maxDisc + dx * 0.15) / 5) * 5);
    return { x: d3.scaleLinear().domain([x0, x1]).range([M.l, W - M.r]), y: d3.scaleLinear().domain([Math.max(0, fit[1] - dy * 0.2), maxPrice + dy * 0.2]).range([H - M.b, M.t]) };
  }
  const x = d3.scaleLinear().domain([0, Math.max(40, Math.ceil(maxDisc / 10) * 10)]).range([M.l, W - M.r]);
  const y = d3.scaleSymlog().constant(15).domain([0, Math.max(20, maxPrice) * 1.05]).range([H - M.b, M.t]);
  return { x, y };
}
function drawAxes(svg, W, H, x, y) {
  svg.selectAll('.axes').remove();
  const g = svg.insert('g', ':first-child').attr('class', 'axes');
  const ticksY = y.ticks(8);
  g.append('g').attr('class', 'grid').selectAll('line.v').data(x.ticks(10)).join('line').attr('x1', (d) => x(d)).attr('x2', (d) => x(d)).attr('y1', M.t).attr('y2', H - M.b);
  g.append('g').attr('class', 'grid').selectAll('line.h').data(ticksY).join('line').attr('x1', M.l).attr('x2', W - M.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - M.b})`).call(d3.axisBottom(x).ticks(10).tickFormat((d) => d + '%'));
  g.append('g').attr('class', 'axis').attr('transform', `translate(${M.l},0)`).call(d3.axisLeft(y).tickValues(ticksY).tickFormat((d) => SW.pre + d));
  g.append('text').attr('class', 'axlabel').attr('x', (M.l + W - M.r) / 2).attr('y', H - 8).attr('text-anchor', 'middle').text('Discount');
  g.append('text').attr('class', 'axlabel').attr('transform', `translate(14,${(M.t + H - M.b) / 2}) rotate(-90)`).attr('text-anchor', 'middle').text('Price');
}
const priced = (g) => g.fin > 0 && g.st === 0;

// ---- price × discount, bubbles = tags ----------------------------------------------------------
SW.charts.pd = function drawPD() {
  const host = $('#pdchart'), W = host.clientWidth; if (!W) return;
  const games = pool(S.psrc).filter(priced), by = {};
  for (const g of games) for (const t of g.all) (by[t] ||= { d: [], p: [] }, by[t].d.push(g.disc), by[t].p.push(g.fin / 100));
  const tags = Object.keys(by).map(Number).filter((t) => S.pcats.has(SW.cat(t))).map((t) => ({ t, n: by[t].d.length, d: d3.mean(by[t].d), p: d3.mean(by[t].p) })).sort((a, b) => b.n - a.n).slice(0, S.pn);
  if (!tags.length) return empty(host, S.psrc === 'mine' ? 'Add priced games to My list to plot their tags.' : 'No priced games yet. Sync your wishlist first.');
  const H = Math.round(Math.min(Math.max(W * 0.55, 420), 700));
  const { x, y } = plotScales(W, H, d3.max(tags, (d) => d.d), d3.max(tags, (d) => d.p), [d3.min(tags, (d) => d.d), d3.min(tags, (d) => d.p)]);
  const r = d3.scaleSqrt().domain([1, d3.max(tags, (d) => d.n)]).range([6, 30]);
  host.innerHTML = '';
  const svg = d3.select(host).append('svg').attr('viewBox', `0 0 ${W} ${H}`);
  drawAxes(svg, W, H, x, y);
  const n = svg.append('g').selectAll('g').data(tags.slice().sort((a, b) => b.n - a.n)).join('g').attr('transform', (d) => `translate(${x(d.d)},${y(d.p)})`);
  n.append('circle').attr('class', 'tagdot').attr('r', (d) => r(d.n)).attr('fill', (d) => `var(--c${SW.cat(d.t)})`);
  n.filter((d) => r(d.n) >= 16).append('text').attr('class', 'tagtxt').attr('dy', '0.32em').text((d) => { const s = SW.tagName[d.t], m = Math.floor((r(d.n) * 2) / 6.2); return s.length > m ? s.slice(0, Math.max(m - 1, 2)) + '…' : s; });
  n.on('mousemove', (e, d) => showTip(e, `<b>${esc(SW.tagName[d.t])}</b> <span class="sm">${CATN[SW.cat(d.t)]}</span><br>${d.n} games<br>avg −${Math.round(d.d)}% · ${SW.pre}${d.p.toFixed(2)}<br><span class="sm">Click to filter wishlist</span>`))
    .on('mouseleave', hideTip).on('click', (e, d) => drillToWishlist(d.t));
};

// ---- price × discount, thumbnails = games ----------------------------------------------------------
function rectCollide(w, h) {
  let nodes;
  const f = () => {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j], dx = b.x - a.x, dy = b.y - a.y, ox = w - Math.abs(dx), oy = h - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        if (ox / w < (2.2 * oy) / h) { const s = (dx < 0 ? -1 : 1) * ox * 0.25; a.x -= s; b.x += s; } else { const s = (dy < 0 ? -1 : 1) * oy * 0.25; a.y -= s; b.y += s; }
      }
    }
  };
  f.initialize = (n) => { nodes = n; };
  return f;
}
SW.charts.cov = function drawCov() {
  const host = $('#covchart'), W = host.clientWidth; if (!W) return;
  let games = pool(S.csrc).filter(priced); if (S.csale) games = games.filter((g) => g.disc > 0);
  games = games.sort((a, b) => (SW.listIds.has(b.id) - SW.listIds.has(a.id)) || b.rc - a.rc).slice(0, S.cn);
  if (!games.length) return empty(host, S.csrc === 'mine' ? 'Add priced games to My list to see their covers here.' : 'No priced games yet. Sync your wishlist first.');
  const H = Math.round(Math.min(Math.max(W * 0.62, 480), 800)), CW = 66, CH = 25;
  const { x, y } = plotScales(W, H, d3.max(games, (g) => g.disc), d3.max(games, (g) => g.fin / 100));
  const nodes = games.map((g) => ({ g, x: x(g.disc), y: y(g.fin / 100), tx: x(g.disc), ty: y(g.fin / 100) }));
  const sim = d3.forceSimulation(nodes).force('x', d3.forceX((d) => d.tx).strength(0.06)).force('y', d3.forceY((d) => d.ty).strength(0.7)).force('c', rectCollide(CW + 3, CH + 3)).stop();
  for (let i = 0; i < 260; i++) sim.tick();
  for (const d of nodes) { d.x = Math.min(W - M.r - CW / 2, Math.max(M.l + CW / 2, d.x)); d.y = Math.min(H - M.b - CH / 2, Math.max(M.t + CH / 2, d.y)); }
  host.innerHTML = '';
  const svg = d3.select(host).append('svg').attr('viewBox', `0 0 ${W} ${H}`);
  svg.append('clipPath').attr('id', 'plotclip').append('rect').attr('x', M.l).attr('y', M.t).attr('width', W - M.l - M.r).attr('height', H - M.t - M.b);
  drawAxes(svg, W, H, x, y);
  const content = svg.append('g').attr('clip-path', 'url(#plotclip)').append('g');
  const n = content.selectAll('g.cover').data(nodes).join('g').attr('class', (d) => 'cover' + (SW.listIds.has(d.g.id) ? ' inlist' : '')).attr('transform', (d) => `translate(${d.x - CW / 2},${d.y - CH / 2})`);
  n.append('rect').attr('width', CW).attr('height', CH).attr('rx', 2);
  n.append('image').attr('href', (d) => `swimg://thumb/${d.g.id}`).attr('width', CW).attr('height', CH).attr('preserveAspectRatio', 'xMidYMid slice');
  n.on('mousemove', (e, d) => showTip(e, `<b>${esc(d.g.name)}</b><br>${d.g.disc ? `−${d.g.disc}% · ` : ''}${esc(d.g.fFin)}${d.g.rc ? ` · ${d.g.rp}% (${d.g.rc.toLocaleString()})` : ''}${SW.listIds.has(d.g.id) ? '<br>★ in my list' : ''}<br><span class="sm">Click to open on Steam</span>`))
    .on('mouseleave', hideTip).on('click', (e, d) => api.open(`https://store.steampowered.com/app/${d.g.id}`));
  const z = d3.zoom().scaleExtent([1, 10]).translateExtent([[0, 0], [W, H]]).extent([[0, 0], [W, H]]).on('zoom', (e) => {
    const t = e.transform;
    content.attr('transform', t);
    drawAxes(svg, W, H, t.rescaleX(x), t.rescaleY(y));
  });
  svg.call(z);
};
