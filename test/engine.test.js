'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/main/engine');
const { Throttle } = require('../src/main/throttle');
const { normalizeItem } = require('../src/main/steam');

function fakeSteam({ owned = [], wishlist = [1, 2, 3, 4] } = {}) {
  const calls = [];
  return {
    calls,
    resolveProfile: async (n) => ({ steamid: n === 'bob' ? '76561190000000002' : '76561190000000001', name: n }),
    getWishlist: async () => wishlist.map((appid) => ({ appid, added: appid })),
    getTagList: async () => ({ 19: 'Action', 21: 'Adventure' }),
    getOwned: async (id) => (id.endsWith('2') ? [3] : owned),
    getFamilyLibrary: async () => null,
    getItems: async (ids) => { calls.push(ids); return ids.map((id) => ({ id, name: 'G' + id, tagids: [19], disc: 10, orig: 1000, fin: 900, st: 0, at: Date.now(), mt: '' })); },
  };
}
const mk = (steam, settings = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  const e = new Engine({ dir, steam, steamdb: null });
  e.setSettings({ username: 'alice', ...settings });
  return e;
};

test('sync fetches details once and caches them', async () => {
  const s = fakeSteam();
  const e = mk(s);
  await e.sync();
  assert.equal(e.getState().games.length, 4);
  await e.sync();
  assert.equal(s.calls.length, 1, 'second sync reuses cache');
  await e.sync('prices');
  assert.equal(s.calls.length, 2, 'prices mode refetches');
});

test('owned games are cleared from wishlist and buying list', async () => {
  const s = fakeSteam();
  const e = mk(s);
  await e.sync();
  e.listAdd(2);
  e.listAdd(1);
  s.getOwned = async () => [2];
  const r = await e.sync();
  assert.deepEqual(r.removedFromList.map((x) => x.appid), [2]);
  const st = e.getState();
  assert.ok(!st.games.some((g) => g.id === 2));
  assert.deepEqual(st.list.map((i) => i.appid), [1]);
});

test('family library: owners are tracked per game and shown, never hidden', async () => {
  const e = mk(fakeSteam(), { useFamily: true, familyMembers: 'bob' });
  await e.sync();
  const st = e.getState();
  const g3 = st.games.find((g) => g.id === 3);
  assert.ok(g3, 'family-owned games stay visible (the UI filters them)');
  assert.deepEqual(g3.fam, ['76561190000000002']);
  assert.equal(st.profile.familyNames['76561190000000002'], 'bob');
  assert.deepEqual(st.games.find((g) => g.id === 1).fam, []);
  assert.equal(st.counts.familyOwned, 1);
});

test('family library via signed-in token reports owners and skips your own games', async () => {
  const s = fakeSteam();
  s.getFamilyLibrary = async () => [{ appid: 1, owners: ['76561190000000001'] }, { appid: 2, owners: ['76561190000000001', '76561190000000009'] }];
  const e = mk(s, { useFamily: true, familyToken: 'tok', familyTokenAt: Date.now() });
  await e.sync();
  const st = e.getState();
  assert.deepEqual(st.games.find((g) => g.id === 1).fam, []);
  assert.deepEqual(st.games.find((g) => g.id === 2).fam, ['76561190000000009']);
});

test('old excludeFamily setting migrates to useFamily', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ username: 'a', excludeFamily: true }));
  const e = new Engine({ dir, steam: fakeSteam(), steamdb: null });
  assert.equal(e.settings.useFamily, true);
  assert.equal('excludeFamily' in e.settings, false);
});

test('why reasons persist per list item', async () => {
  const e = mk(fakeSteam());
  await e.sync();
  e.listAdd(1);
  e.listSet(1, { why: 'Great price' });
  e.setWhys(['A', 'A', ' B ', '']);
  assert.equal(e.getState().list[0].why, 'Great price');
  assert.deepEqual(e.getState().whys, ['A', 'B']);
});

test('throttle spaces requests per host', async () => {
  const t = new Throttle(() => 1);
  const stamps = [];
  await Promise.all([1, 2, 3].map(() => t.run('h', 60, async () => stamps.push(Date.now()))));
  assert.ok(stamps[1] - stamps[0] >= 45 && stamps[2] - stamps[1] >= 45);
});

test('sale end date comes from active_discounts', () => {
  const n = normalizeItem({ success: 1, appid: 5, name: 'X', best_purchase_option: { discount_pct: 30, final_price_in_cents: '700', original_price_in_cents: '1000', active_discounts: [{ discount_end_date: 1792688400 }] } });
  assert.equal(n.end, 1792688400);
  assert.equal(normalizeItem({ success: 1, appid: 6, name: 'Y', best_purchase_option: { discount_pct: 0, active_discounts: [{ discount_end_date: 5 }] } }).end, 0);
});

test('normalizeItem maps store response', () => {
  const n = normalizeItem({ success: 1, appid: 5, name: 'X', type: 0, tags: [{ tagid: 1 }], best_purchase_option: { discount_pct: 50, original_price_in_cents: '2000', final_price_in_cents: '1000', formatted_final_price: 'RM10' }, reviews: { summary_filtered: { percent_positive: 90, review_count: 12 } }, release: { is_coming_soon: true } });
  assert.deepEqual([n.id, n.disc, n.orig, n.fin, n.rp, n.rc, n.st, n.tagids], [5, 50, 2000, 1000, 90, 12, 2, [1]]);
  assert.ok(normalizeItem({ success: 2, id: 9 }).gone);
});

test('games Steam no longer returns are "unavailable", not pending, and retried weekly', async () => {
  const s = fakeSteam();
  const base = s.getItems;
  s.getItems = async (ids) => (await base(ids)).filter((g) => g.id !== 4);
  const e = mk(s);
  await e.sync();
  const c = e.getState().counts;
  assert.equal(c.pending, 0);
  assert.equal(c.unavailable, 1);
  assert.deepEqual(e.getState().unavailable.map((g) => g.id), [4]);
  const n = s.calls.length;
  await new Promise((r) => setTimeout(r, 5));
  await e.sync('prices');
  assert.equal(s.calls.length, n + 1, 'prices mode refetches visible games');
  e.apps[4].at = Date.now();
  await e.sync();
  assert.equal(s.calls.length, n + 1, 'unavailable games are not refetched within a week');
});

test('log redacts secrets', () => {
  const { redact } = require('../src/main/log');
  assert.equal(redact('GET /x?key=ABC123&steamid=1'), 'GET /x?key=***&steamid=1');
  assert.equal(redact('?access_token=eyJ.x.y'), '?access_token=***');
});

test('images fall back to hashed asset URLs when the legacy path 404s', async () => {
  const fs = require('fs');
  const { Images } = require('../src/main/images');
  const { setFetch } = require('../src/main/http');
  const { assetUrl } = require('../src/main/steam');
  const seen = [];
  setFetch(async (url) => {
    seen.push(url);
    return url.includes('store_item_assets') ? new Response(Buffer.from('jpg'), { status: 200 }) : new Response('', { status: 404 });
  });
  const s = fakeSteam();
  s.getItems = async (ids) => ids.map((id) => ({ id, name: 'G' + id, ia: 'steam/apps/' + id + '/${FILENAME}?t=1', isc: 'abc/capsule_231x87.jpg', ih: 'def/header.jpg' }));
  const e = mk(s);
  await e.sync();
  delete e.apps[1].isc; delete e.apps[1].ih; delete e.apps[1].ia; // pretend cached before assets were stored
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swi-'));
  const img = new Images(dir, new Throttle(() => 0), () => null, (id) => e.assetUrls(id));
  const file = await img.get('thumb', 1);
  assert.ok(file && fs.existsSync(file));
  assert.ok(seen.some((u) => u.startsWith('https://shared.steamstatic.com/store_item_assets/steam/apps/1/abc/capsule_231x87.jpg')));
  assert.equal(assetUrl({ ia: 'x/${FILENAME}', }, 'y.jpg'), 'https://shared.steamstatic.com/store_item_assets/x/y.jpg');
  assert.equal(await img.get('thumb', 1), file, 'second call is served from disk');
  setFetch((...a) => fetch(...a));
});

test('SteamDB parsing helpers', () => {
  const { parseHistory, microtrailerUrl, CHALLENGE_TITLE } = require('../src/main/steamdb-parse');
  const h = parseHistory({ success: true, data: { history: [{ x: 1000, y: 12.5, d: 0, f: 'RM12.50' }, { x: 2000, y: 6.25, d: 50 }, { x: 3000, y: 0 }, { x: 4000, y: 12.5 }] } });
  assert.deepEqual([h.low, h.lowAt, h.history.length, h.history[0][1]], [625, 2000, 3, 1250]);
  assert.equal(h.history[1][2], 50);
  assert.equal(parseHistory({ success: false, error: 'x' }), null);
  assert.equal(parseHistory({ success: true, data: { history: [] } }), null);
  const mt = JSON.stringify({ video: { 'video/mp4': 'a/movie.mp4', 'video/webm': 'a/movie.webm' }, time: 77 });
  assert.equal(microtrailerUrl('https://cdn/', mt), 'https://cdn/store_trailers/a/movie.webm?t=77');
  assert.equal(microtrailerUrl('', mt), null);
  assert.equal(microtrailerUrl('https://cdn/', 'not json'), null);
  assert.ok(CHALLENGE_TITLE.test('Just a moment...') && !CHALLENGE_TITLE.test('Quake 4 · SteamDB'));
});

function fakeDb(behaviour) {
  const calls = [];
  return {
    calls,
    fetchApp: async (id) => { calls.push(id); return behaviour(id, calls.length); },
    showChallenge() {},
  };
}
const dbOk = () => ({ history: [[1, 100, 0]], low: 100, lowAt: 1, more: false, gif: null });
async function bgEngine(behaviour, scope = 'mine') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  const e = new Engine({ dir, steam: fakeSteam(), steamdb: fakeDb(behaviour) });
  e.setSettings({ username: 'alice' });
  e.bgDelayMs = () => 5;
  await e.sync();
  return e;
}
const waitStopped = async (e) => { while (e.bg.running) await new Promise((r) => setTimeout(r, 5)); };

test('background SteamDB load works through My list, then stops', async () => {
  const e = await bgEngine(dbOk);
  e.listAdd(1); e.listAdd(2);
  e.bgStart('mine');
  await waitStopped(e);
  assert.deepEqual(e.steamdb.calls, [1, 2]);
  assert.equal(e.bg.done, 2);
  assert.equal(e.bg.blocked, null);
  assert.equal(e.getState().bg.abort, undefined);
  assert.deepEqual(e.bgQueue('mine'), [], 'loaded games are not queued again');
});

test('background load: wishlist scopes queue My list first, "sale" only discounted games', async () => {
  const e = await bgEngine(dbOk);
  e.apps[3].disc = 0;
  e.listAdd(4);
  assert.deepEqual(e.bgQueue('mine'), [4]);
  assert.equal(e.bgQueue('sale')[0], 4);
  assert.ok(!e.bgQueue('sale').includes(3));
  assert.ok(e.bgQueue('all').includes(3));
});

test('background load stops and reports a block when SteamDB needs a check', async () => {
  const e = await bgEngine((id, n) => { if (n === 2) throw Object.assign(new Error('check not completed'), { challenge: true }); return dbOk(); });
  e.listAdd(1); e.listAdd(2); e.listAdd(3);
  e.bgStart('mine');
  await waitStopped(e);
  assert.equal(e.bg.running, false, 'start button can be used again');
  assert.equal(e.bg.blocked.kind, 'challenge');
  assert.equal(e.bg.done, 1);
  e.bgStart('mine'); // resume
  await waitStopped(e);
  assert.equal(e.bg.done, 2, 'resume continues with the game that was blocked, then the next');
  assert.deepEqual(e.steamdb.calls, [1, 2, 2, 3]);
});

test('background load skips games SteamDB has nothing for and can be stopped', async () => {
  const e = await bgEngine((id) => { if (id === 1) throw Object.assign(new Error('no data'), { noData: true }); return dbOk(); });
  e.listAdd(1); e.listAdd(2);
  e.bgStart('mine');
  await waitStopped(e);
  assert.equal(e.bg.failed, 1);
  assert.equal(e.bg.done, 1);
  assert.ok(!e.bgQueue('mine').includes(1), 'skipped for a week');
  const s = await bgEngine(dbOk);
  s.listAdd(1); s.bgDelayMs = () => 10000;
  s.listAdd(2);
  s.bgStart('mine');
  await new Promise((r) => setTimeout(r, 30));
  s.bgStop();
  assert.equal(s.bg.running, false);
});

test('images use already-known hashed URLs first and cope with games that only have a header', async () => {
  const fs = require('fs');
  const { Images } = require('../src/main/images');
  const { setFetch } = require('../src/main/http');
  const seen = [];
  setFetch(async (url) => { seen.push(url); return url.includes('store_item_assets') ? new Response(Buffer.from('jpg'), { status: 200 }) : new Response('', { status: 404 }); });
  const s = fakeSteam();
  s.getItems = async (ids) => ids.map((id) => ({ id, name: 'G' + id, ia: 'steam/apps/' + id + '/${FILENAME}?t=1', isc: id === 2 ? '' : 'abc/capsule_231x87.jpg', ih: 'def/header.jpg' }));
  const e = mk(s);
  await e.sync();
  const img = new Images(fs.mkdtempSync(path.join(os.tmpdir(), 'swi-')), new Throttle(() => 0), () => null, (id) => e.assetUrls(id), (id) => e.peekAssets(id));
  seen.length = 0;
  assert.ok(await img.get('thumb', 1));
  assert.ok(seen[0].includes('store_item_assets') && seen.length === 1, 'no 404 round trip first');
  seen.length = 0;
  assert.ok(await img.get('thumb', 2), 'header-only game still gets an image');
  assert.ok(seen[0].includes('/def/header.jpg'));
  setFetch((...a) => fetch(...a));
});

test('background load writes one log line per game with name and progress', async () => {
  const fs = require('fs');
  const log = require('../src/main/log');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swlog-'));
  log.init(dir);
  const e = await bgEngine(dbOk);
  e.listAdd(1); e.listAdd(2);
  e.bgStart('mine');
  await waitStopped(e);
  const txt = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
  assert.match(txt, /background load 1\/2: G1 \(1\)/);
  assert.match(txt, /background load 2\/2: G2 \(2\)/);
  assert.match(txt, /next game in \d+ s/);
});

function fakeFirecrawlFetch(handler) {
  const reqs = [];
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    reqs.push({ url, auth: opts.headers.Authorization, body });
    const out = handler(body);
    return new Response(JSON.stringify(out.json), { status: out.status || 200 });
  };
  f.reqs = reqs;
  return f;
}
const PAGE = `x [1/765/abc/microtrailer.mp4](https://video.fastly.steamstatic.com/store_trailers/1/765/abc/microtrailer.mp4) y https://video.fastly.steamstatic.com/store_trailers/1/765/abc/microtrailer.webm?t=5
| Currency | Current Price | Converted Price | Lowest Recorded Price |
| --- | --- | --- | --- |
| ![](https://steamdb.info/static/country/us.svg) U.S. Dollar | -60% $23.99 | $23.99 | $23.99 | -60% $23.99 |
| ![](https://steamdb.info/static/country/id.svg) Indonesian Rupiah | -60% Rp 239600 | $13.36 | -44.28% | $13.36 | -60% Rp 239600 |
| ![](https://steamdb.info/static/country/my.svg) Malaysian Ringgit | -60% RM79.60 | $19.48 | -18.79% | $19.48 | -70% RM59.70 |
`;

test('Firecrawl source: reads preview video and the lowest recorded price from the app page', async () => {
  const { Firecrawl } = require('../src/main/firecrawl');
  const { setFetch } = require('../src/main/http');
  const f = fakeFirecrawlFetch(() => ({ json: { success: true, data: { markdown: PAGE, metadata: { statusCode: 200 } } } }));
  setFetch(f);
  const fc = new Firecrawl(new Throttle(() => 0), () => 'fc-test1234567');
  const r = await fc.fetchApp(1672500, 'my', undefined, { price: 'RM79.60' });
  assert.deepEqual([r.low, r.history, r.allTime], [5970, null, true]);
  assert.equal(r.gif, 'https://video.fastly.steamstatic.com/store_trailers/1/765/abc/microtrailer.webm?t=5');
  assert.equal(f.reqs.length, 1, 'one request (one credit) per game');
  assert.equal(f.reqs[0].auth, 'Bearer fc-test1234567');
  assert.ok(f.reqs[0].url.endsWith('/v2/scrape'));
  const none = await fc.fetchApp(1, 'my', undefined, { price: 'RM1.00' });
  assert.equal(none.low, null);
  setFetch((...a) => fetch(...a));
});

test('price parsing handles different currency formats', () => {
  const { parsePrice } = require('../src/main/firecrawl');
  const cases = [['RM79.60', 79.6], ['Rp 239600', 239600], ['1.234,56 €', 1234.56], ['¥ 3388', 3388], ['396000₫', 396000], ['$1,299.00', 1299], ['23,99€', 23.99], ['CLP$ 16999', 16999]];
  for (const [txt, v] of cases) assert.equal(parsePrice(txt), v, txt);
});

test('engine prefers Firecrawl when enabled (short pacing) and stops cleanly on a fatal Firecrawl error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  let mode = 'ok';
  const firecrawl = { fetchApp: async (id) => { if (mode === 'fatal') throw Object.assign(new Error('out of credits'), { fatal: true }); return dbOk(); } };
  const steamdb = fakeDb(() => { throw new Error('browser path must not be used'); });
  const e = new Engine({ dir, steam: fakeSteam(), steamdb, firecrawl });
  e.setSettings({ username: 'alice', firecrawlKey: 'fc-x', useFirecrawl: true });
  await e.sync();
  assert.ok(e.bgDelayMs() < 20000, 'Firecrawl pacing is short');
  e.setSettings({ useFirecrawl: false });
  const d = e.bgDelayMs();
  assert.ok(d >= 20000 && d <= 40000, 'browser pacing defaults to 20-40 s');
  e.setSettings({ bgPace: 'slow' });
  assert.ok(e.bgDelayMs() >= 60000, 'slow = 1-2 minutes');
  e.setSettings({ bgPace: 'fast' });
  assert.ok(e.bgDelayMs() <= 15000, 'fast = 8-15 s');
  e.setSettings({ bgPace: '' });
  e.setSettings({ useFirecrawl: true });
  e.bgDelayMs = () => 5;
  e.listAdd(1); e.listAdd(2);
  mode = 'fatal';
  e.bgStart('mine');
  await waitStopped(e);
  assert.equal(e.bg.blocked.kind, 'firecrawl');
  mode = 'ok';
  e.bgStart('mine');
  await waitStopped(e);
  assert.equal(e.bg.done, 2);
  assert.equal(steamdb.calls.length, 0);
});

test('log redacts Firecrawl keys', () => {
  assert.equal(require('../src/main/log').redact('key fc-abcdef0123456789 end'), 'key fc-*** end');
});

test('expired family sign-in is reported instead of silently skipped', async () => {
  const e = mk(fakeSteam(), { useFamily: true, familyToken: 'tok', familyTokenAt: Date.now() - 2 * 864e5 });
  await e.sync();
  assert.ok(e.getState().status.warnings.some((w) => /expired/.test(w)));
});

test('own library: uses the sign-in token, or derives it from the family library, and warns otherwise', async () => {
  // 1. token passed to getOwned
  const s1 = fakeSteam({ owned: [2] });
  let seenToken = null;
  s1.getOwned = async (id, key, signal, token) => { seenToken = token; return token ? [2] : null; };
  const e1 = mk(s1, { familyToken: 'tok', familyTokenAt: Date.now() });
  await e1.sync();
  assert.equal(seenToken, 'tok');
  assert.ok(!e1.getState().games.some((g) => g.id === 2), 'owned game removed from wishlist');
  // 2. no token, no key: warning
  const s2 = fakeSteam();
  s2.getOwned = async () => null;
  const e2 = mk(s2);
  await e2.sync();
  assert.ok(e2.getState().status.warnings.some((w) => /Sign in to Steam/.test(w)));
  // 3. getOwned fails but the family library lists own games
  const s3 = fakeSteam();
  s3.getOwned = async () => null;
  s3.getFamilyLibrary = async () => [{ appid: 1, owners: ['76561190000000001'] }, { appid: 3, owners: ['76561190000000009'] }];
  const e3 = mk(s3, { useFamily: true, familyToken: 'tok', familyTokenAt: Date.now() });
  await e3.sync();
  assert.deepEqual(e3.user().owned, [1]);
  assert.ok(!e3.getState().status.warnings.some((w) => /Could not read your game library/.test(w)));
});

test('Firecrawl source: key and credit problems are fatal; HTML-wrapped JSON still parses', async () => {
  const { Firecrawl, jsonFromBody } = require('../src/main/firecrawl');
  const { setFetch } = require('../src/main/http');
  const fc = new Firecrawl(new Throttle(() => 0), () => 'fc-test1234567');
  setFetch(fakeFirecrawlFetch(() => ({ status: 401, json: { success: false, error: 'Unauthorized' } })));
  await assert.rejects(() => fc.scrape('https://x'), (e) => e.fatal && /rejected the API key/.test(e.message));
  setFetch(fakeFirecrawlFetch(() => ({ status: 402, json: { success: false } })));
  await assert.rejects(() => fc.scrape('https://x'), (e) => e.fatal && /credits/.test(e.message));
  assert.equal(await new Firecrawl(new Throttle(() => 0), () => '').scrape('https://x').catch((e) => e.fatal), true);
  assert.deepEqual(jsonFromBody('<html><body><pre>{"a":1}</pre></body></html>'), { a: 1 });
  setFetch((...a) => fetch(...a));
});

const HIST_JSON = () => JSON.stringify({ success: true, data: { history: [{ x: Date.now() - 800 * 864e5, y: 90, d: 0 }, { x: Date.now() - 100 * 864e5, y: 60, d: 33 }, { x: Date.now() - 5 * 864e5, y: 79.6, d: 0 }] } });

test('Firecrawl history probe finds the browser-script method first, then the direct request, else none', async () => {
  const { Firecrawl } = require('../src/main/firecrawl');
  const { setFetch } = require('../src/main/http');
  const fc = new Firecrawl(new Throttle(() => 0), () => 'fc-test1234567');
  // 1. executeJavascript works
  setFetch(fakeFirecrawlFetch((b) => (b.actions ? { json: { success: true, data: { markdown: PAGE, actions: { javascriptReturns: [{ type: 'string', value: HIST_JSON() }] } } } } : { json: { success: true, data: { rawHtml: '{"success":false}' } } })));
  assert.equal((await fc.probe('my')).mode, 'js');
  // 2. only the direct request with headers works
  const f2 = fakeFirecrawlFetch((b) => (b.actions ? { json: { success: true, data: { markdown: PAGE, actions: { javascriptReturns: [{ value: {} }] } } } } : { json: { success: true, data: { rawHtml: HIST_JSON() } } }));
  setFetch(f2);
  assert.equal((await fc.probe('my')).mode, 'headers');
  assert.equal(f2.reqs[1].body.headers.Referer, 'https://steamdb.info/app/1672500/');
  // 3. nothing works
  setFetch(fakeFirecrawlFetch(() => ({ json: { success: true, data: { rawHtml: '{"success":false}', markdown: PAGE } } })));
  assert.equal((await fc.probe('my')).mode, 'none');
  setFetch((...a) => fetch(...a));
});

test('Firecrawl fetchApp uses the saved history method and adds the lowest-ever price', async () => {
  const { Firecrawl } = require('../src/main/firecrawl');
  const { setFetch } = require('../src/main/http');
  const fc = new Firecrawl(new Throttle(() => 0), () => 'fc-test1234567');
  const jsF = fakeFirecrawlFetch(() => ({ json: { success: true, data: { markdown: PAGE, actions: { javascriptReturns: [{ value: HIST_JSON() }] } } } }));
  setFetch(jsF);
  let r = await fc.fetchApp(1672500, 'my', undefined, { price: 'RM79.60', mode: 'js' });
  assert.equal(jsF.reqs.length, 1, 'js mode: one request for page + history');
  assert.deepEqual([r.history.length, r.low, r.allTimeLow, r.more, r.allTime], [3, 6000, 5970, true, false]);
  assert.ok(r.gif.includes('microtrailer.webm'));
  const hdF = fakeFirecrawlFetch((b) => (b.url.includes('/api/') ? { json: { success: true, data: { rawHtml: HIST_JSON() } } } : { json: { success: true, data: { markdown: PAGE } } }));
  setFetch(hdF);
  r = await fc.fetchApp(1672500, 'my', undefined, { price: 'RM79.60', mode: 'headers' });
  assert.equal(hdF.reqs.length, 2);
  assert.equal(r.history.length, 3);
  const none = fakeFirecrawlFetch(() => ({ json: { success: true, data: { markdown: PAGE } } }));
  setFetch(none);
  r = await fc.fetchApp(1672500, 'my', undefined, { price: 'RM79.60', mode: '' });
  assert.deepEqual([r.history, r.low, r.allTime], [null, 5970, true]);
  setFetch((...a) => fetch(...a));
});

test('Steam micro-trailer URL is read from the store item', () => {
  const { microtrailerUrl, normalizeItem } = require('../src/main/steam');
  const it = { success: 1, appid: 7, name: 'X', trailers: { highlights: [{ trailer_url_format: 'steam/apps/${FILENAME}?t=1724909804', microtrailer: [{ filename: '7/1/abc/9/microtrailer.mp4', type: 'video/mp4' }, { filename: '7/1/abc/9/microtrailer.webm', type: 'video/webm' }] }] } };
  assert.equal(microtrailerUrl(it), 'https://video.fastly.steamstatic.com/store_trailers/7/1/abc/9/microtrailer.webm?t=1724909804');
  assert.equal(normalizeItem(it).mt, microtrailerUrl(it));
  assert.equal(microtrailerUrl({ success: 1 }), '');
});

function fakeImages(cached = []) {
  const got = [];
  return { got, hasCached: (k, id) => cached.includes(id), get: async (k, id) => { got.push(id); return id === 3 ? null : '/tmp/x'; } };
}
async function previewEngine(mode, cached) {
  const s = fakeSteam();
  s.getItems = async (ids) => ids.map((id) => ({ id, name: 'G' + id, tagids: [], disc: 0, orig: 100, fin: 100, st: 0, at: Date.now(), mt: id === 4 ? '' : `https://video/${id}.webm` }));
  const e = mk(s, { previewDownload: mode });
  e.images = fakeImages(cached);
  await e.sync();
  return e;
}

test('hover previews: saved for every game at Sync, downloaded for My list / everything / nothing', async () => {
  let e = await previewEngine('mine', []);
  assert.equal(e.hoverUrl(1), 'https://video/1.webm');
  assert.ok(e.getState().games.find((g) => g.id === 1).gif);
  assert.ok(!e.getState().games.find((g) => g.id === 4).gif, 'no trailer, no preview');
  assert.deepEqual(e.images.got, [], 'My list is empty: nothing to download');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  const s = fakeSteam();
  s.getItems = async (ids) => ids.map((id) => ({ id, name: 'G' + id, tagids: [], disc: 0, orig: 100, fin: 100, st: 0, at: Date.now(), mt: `https://video/${id}.webm` }));
  e = new Engine({ dir, steam: s, steamdb: null });
  e.setSettings({ username: 'alice', previewDownload: 'mine' });
  e.images = fakeImages([]);
  await e.sync();
  e.listAdd(1); e.listAdd(2);
  await e.sync();
  assert.deepEqual(e.images.got, [1, 2]);
  e.images = fakeImages([1]);
  await e.sync();
  assert.deepEqual(e.images.got, [2], 'already cached previews are skipped');
  e.setSettings({ previewDownload: 'all' });
  e.images = fakeImages([]);
  await e.sync();
  assert.deepEqual(e.images.got.sort(), [1, 2, 3, 4]);
  e.setSettings({ previewDownload: 'off' });
  e.images = fakeImages([]);
  await e.sync();
  assert.deepEqual(e.images.got, []);
});

test('failures are logged: image downloads (final and recovered), network errors, Firecrawl errors', async () => {
  const fs2 = require('fs');
  const log = require('../src/main/log');
  const { Images } = require('../src/main/images');
  const { setFetch, get } = require('../src/main/http');
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'swlog-'));
  log.init(dir);
  const logText = () => fs2.readFileSync(path.join(dir, 'app.log'), 'utf8');
  setFetch(async (url) => (url.includes('good') ? new Response(Buffer.from('x'), { status: 200 }) : new Response('', { status: 404 })));
  const img = new Images(fs2.mkdtempSync(path.join(os.tmpdir(), 'swi-')), new Throttle(() => 0), (id) => `https://video.example/${String(id) === '9' ? 'good' : 'bad'}.webm`);
  assert.equal(await img.get('hover', 5), null);
  assert.match(logText(), /WARN\s+hover 5: download failed \(default: HTTP 404 video\.example/);
  assert.ok(await img.get('hover', 9));
  setFetch(async () => { throw new Error('ECONNRESET'); });
  await assert.rejects(() => get(new Throttle(() => 0), 'https://api.example/x/y', { host: 'api.example', minMs: 0 }));
  assert.match(logText(), /network error api\.example\/x\/y: ECONNRESET/);
  const { Firecrawl } = require('../src/main/firecrawl');
  setFetch(async () => new Response(JSON.stringify({ success: false, error: 'Bad' }), { status: 500 }));
  await assert.rejects(() => new Firecrawl(new Throttle(() => 0), () => 'fc-abcdefgh1234').scrape('https://steamdb.info/app/1/'));
  assert.match(logText(), /Firecrawl 500 for \/app\/1\/: Firecrawl error 500: Bad/);
  assert.ok(!/fc-abcdefgh1234/.test(logText()), 'key never logged');
  setFetch((...a) => fetch(...a));
});

test('range responses for the cache protocol', () => {
  const { serveBuffer } = require('../src/main/range');
  const buf = Buffer.from('0123456789');
  let r = serveBuffer(buf, 'video/webm', null);
  assert.deepEqual([r.status, r.headers['content-length'], r.headers['accept-ranges']], [200, '10', 'bytes']);
  r = serveBuffer(buf, 'video/webm', 'bytes=2-4');
  assert.deepEqual([r.status, r.headers['content-range'], r.body.toString()], [206, 'bytes 2-4/10', '234']);
  r = serveBuffer(buf, 'video/webm', 'bytes=0-');
  assert.deepEqual([r.status, r.headers['content-range'], r.body.length], [206, 'bytes 0-9/10', 10]);
  r = serveBuffer(buf, 'video/webm', 'bytes=-3');
  assert.equal(r.body.toString(), '789');
  r = serveBuffer(buf, 'video/webm', 'bytes=0-999');
  assert.equal(r.headers['content-range'], 'bytes 0-9/10');
  assert.equal(serveBuffer(buf, 'video/webm', 'bytes=50-60').status, 416);
});

test('games saved before preview addresses existed are refreshed once, even if recently fetched', async () => {
  const s = fakeSteam();
  const e = mk(s);
  await e.sync();
  assert.equal(s.calls.length, 1);
  await e.sync();
  assert.equal(s.calls.length, 1, 'fresh data with a (possibly empty) preview field is not refetched');
  for (const id of [1, 2, 3, 4]) delete e.apps[id].mt; // what an older cache looks like
  s.getItems = async (ids) => { s.calls.push(ids); return ids.map((id) => ({ id, name: 'G' + id, tagids: [], disc: 0, orig: 1, fin: 1, st: 0, at: Date.now(), mt: '' })); };
  await e.sync();
  assert.equal(s.calls.length, 2, 'refetched once');
  await e.sync();
  assert.equal(s.calls.length, 2, 'and not again (mt is now defined)');
});

test('SteamDB queue order: never loaded, then price changed / sale ended, then the rest (not loaded in the last 5 days); My list and sales first', async () => {
  const s = fakeSteam({ wishlist: [1, 2, 3, 4, 5, 6, 7] });
  const e = mk(s);
  await e.sync();
  const now = Date.now(), D = 864e5;
  const set = (id, fields) => Object.assign(e.apps[id], fields);
  // 1: never loaded, on sale 10%   2: never loaded, no sale   3: price changed since the fetch
  // 4: loaded 2 days ago, unchanged (skip)   5: loaded 9 days ago, unchanged, on sale   6: sale ended since the fetch   7: loaded 9 days ago, no sale
  set(1, { disc: 10 }); set(2, { disc: 0 }); set(3, { fin: 500, disc: 20 }); set(4, { fin: 100, disc: 0 }); set(5, { fin: 100, disc: 40 }); set(6, { fin: 100, disc: 0 }); set(7, { fin: 100, disc: 0 });
  const db = (at, fin, extra = {}) => ({ history: null, low: 100, lowAt: 1, gif: null, at, fin, saleEnd: 0, ...extra });
  set(3, { db: db(now - 20 * D, 900) });                      // price was 900, now 500: changed
  set(4, { db: db(now - 2 * D, 100) });
  set(5, { db: db(now - 9 * D, 100) });
  set(6, { db: db(now - 20 * D, 100, { saleEnd: Math.floor((now - 3 * D) / 1000) }) });
  set(7, { db: db(now - 9 * D, 100) });
  e.listAdd(2); // a list item that was never loaded goes first inside pass 1
  assert.deepEqual(e.bgQueue('all'), [2, 1, 3, 6, 5, 7]);
  assert.deepEqual(e.bgQueue('all', 2), [2, 1, 3, 6], 'Sync only does passes 1 and 2');
  assert.deepEqual(e.bgQueue('sale'), [2, 1, 3, 5], 'sale scope: My list + games on sale');
  assert.deepEqual(e.bgQueue('mine'), [2]);
});

test('lowest known SteamDB price is exposed per game, never above today\'s price', async () => {
  const e = mk(fakeSteam());
  await e.sync();
  e.apps[1].fin = 900;
  e.apps[1].db = { history: null, low: 700, more: true, allTimeLow: 500, at: Date.now() };
  e.apps[2].db = { history: null, low: 300, allTime: true, at: Date.now() };
  e.apps[2].fin = 200; // cheaper today than anything recorded
  const g = (id) => e.getState().games.find((x) => x.id === id);
  assert.deepEqual([g(1).low, g(1).lowNote], [500, 'lowest ever recorded']);
  assert.equal(g(2).low, 200);
  assert.equal(g(3).low, null, 'no SteamDB data, no lowest price');
});
