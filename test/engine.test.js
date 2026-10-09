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

test('family exclusion via listed members', async () => {
  const e = mk(fakeSteam(), { excludeFamily: true, familyMembers: 'bob' });
  await e.sync();
  const ids = e.getState().games.map((g) => g.id);
  assert.ok(!ids.includes(3));
  e.setSettings({ excludeFamily: false });
  assert.equal(e.getState().counts.pending, 1, 'never fetched, so pending until next sync');
  await e.sync();
  assert.ok(e.getState().games.some((g) => g.id === 3));
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
  const n = s.calls.length;
  await new Promise((r) => setTimeout(r, 5));
  await e.sync('prices');
  assert.equal(s.calls.length, n + 1, 'prices mode refetches visible games');
  e.apps[4].at = Date.now();
  await e.sync();
  assert.equal(s.calls.length, n + 1, 'unavailable games are not refetched within a week');
});
