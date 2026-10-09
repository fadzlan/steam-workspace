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
    getItems: async (ids) => { calls.push(ids); return ids.map((id) => ({ id, name: 'G' + id, tagids: [19], disc: 10, orig: 1000, fin: 900, st: 0, at: Date.now() })); },
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
