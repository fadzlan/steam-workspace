'use strict';
const path = require('path');
const { JsonFile } = require('./store');
const log = require('./log');
const { assetUrl } = require('./steam');

const DAY = 864e5;
const DEFAULT_WHYS = ['Great price', 'Wanted for a long time', 'Friends play it', 'Highly rated', 'Genre I love', 'Near historical low', 'Good for the family'];
const DEFAULT_SETTINGS = { username: '', country: 'MY', useFamily: false, familyMembers: '', apiKey: '', firecrawlKey: '', useFirecrawl: false, fcHistoryMode: '', slowness: 1, familyToken: null, familyTokenAt: 0 };
const BATCH = 25;

// Everything stateful and network-driven lives here; electron-specific bits are injected
// so this can be unit tested with fakes.
class Engine {
  constructor({ dir, steam, steamdb, firecrawl, emit }) {
    this.steam = steam;
    this.steamdb = steamdb;
    this.firecrawl = firecrawl || null;
    this.emit = emit || (() => {});
    this.settingsF = new JsonFile(path.join(dir, 'settings.json'), DEFAULT_SETTINGS);
    if (this.settingsF.data.excludeFamily) this.settingsF.data.useFamily = true; // old name of the option
    delete this.settingsF.data.excludeFamily;
    this.appsF = new JsonFile(path.join(dir, 'apps.json'), { apps: {}, tags: {}, tagsAt: 0 });
    this.usersF = new JsonFile(path.join(dir, 'users.json'), { users: {}, current: null });
    this.status = { running: false, phase: '', done: 0, total: 0, msg: '', warnings: [] };
    this.abort = null;
    this.bg = { running: false };
    // 1-2 minutes between SteamDB games when we drive a browser against SteamDB ourselves; Firecrawl
    // requests come from its own infrastructure, so a short pause is enough.
    this.bgDelayMs = () => (this._useFirecrawl() ? 8000 + Math.random() * 7000 : 60000 + Math.random() * 60000);
  }

  get settings() { return this.settingsF.data; }
  get apps() { return this.appsF.data.apps; }
  get users() { return this.usersF.data.users; }
  user() { return this.users[this.usersF.data.current] || null; }

  // ---- state for the renderer ------------------------------------------------
  getState() {
    const u = this.user();
    const s = { ...this.settings };
    s.hasToken = !!(s.familyToken && Date.now() - s.familyTokenAt < DAY);
    delete s.familyToken;
    const out = { settings: s, status: this.status, profile: null, games: [], tags: this.appsF.data.tags, list: [], whys: DEFAULT_WHYS, counts: {} };
    if (!u) return out;
    const owned = new Set(u.owned || []);
    const famOwners = u.familyOwners || {};
    const famLegacy = new Set(u.familyOwners ? [] : u.family || []);
    let hiddenOwned = 0, pending = 0, unavailable = 0, familyOwned = 0;
    const gone = [];
    for (const w of u.wishlist) {
      if (owned.has(w.appid)) { hiddenOwned++; continue; }
      const a = this.apps[w.appid];
      if (a && a.gone) { unavailable++; gone.push({ id: w.appid, name: a.name || '', added: w.added }); continue; } // Steam returns nothing: delisted, removed or region-locked
      if (!a || !a.name) { pending++; continue; }
      const fam = famOwners[w.appid] || (famLegacy.has(w.appid) ? ['?'] : []); // steamids of family members who own it
      if (fam.length) familyOwned++;
      out.games.push({ ...a, added: w.added, db: undefined, hasDb: !!a.db, gif: !!(a.db && a.db.gif), fam });
    }
    out.profile = { steamid: u.steamid, name: u.name, ownedKnown: u.owned != null, familyKnown: u.family != null, familyAt: u.familyAt || 0, familyNames: u.familyNames || {}, syncedAt: u.syncedAt || 0 };
    out.unavailable = gone;
    const { abort, ...bg } = this.bg; // eslint-disable-line no-unused-vars
    out.bg = bg;
    out.counts = { wishlist: u.wishlist.length, hiddenOwned, familyOwned, pending, unavailable };
    out.whys = u.whys || DEFAULT_WHYS;
    out.list = u.list.map((i) => {
      const a = this.apps[i.appid] || {};
      const db = a.db || null;
      return { ...i, history: db ? db.history : null, low: db ? db.low : null, lowAt: db ? db.lowAt : null, more: !!(db && db.more), allTime: !!(db && db.allTime), allTimeLow: db ? db.allTimeLow ?? null : null, dbAt: db ? db.at : 0, saleEnd: db ? db.saleEnd || 0 : 0 };
    });
    return out;
  }

  // Image URLs we already know for an app (saved from the store API), or null.
  peekAssets(id) {
    const a = this.apps[id];
    return a && a.ia && (a.isc || a.ih) ? { thumb: assetUrl(a, a.isc), header: assetUrl(a, a.ih) } : null;
  }

  // Real (hashed) image URLs for an app, looked up lazily and in batches when a default URL 404s.
  assetUrls(id) {
    const known = this.peekAssets(id);
    if (known) return Promise.resolve(known);
    this._aq = this._aq || new Map();
    if (!this._aq.has(id)) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      this._aq.set(id, { promise, resolve });
      clearTimeout(this._aqTimer);
      this._aqTimer = setTimeout(() => this._flushAssets(), 300);
    }
    return this._aq.get(id).promise;
  }

  async _flushAssets() {
    const q = this._aq; this._aq = new Map();
    const ids = [...q.keys()];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      let items = [];
      try { items = await this.steam.getItems(chunk, this.settings.country); } catch (e) { log.warn('asset lookup failed:', e.message); }
      const got = new Map(items.filter((x) => x.id).map((x) => [x.id, x]));
      for (const id of chunk) {
        const it = got.get(id), a = this.apps[id];
        const ok = it && !it.gone && it.ia && (it.isc || it.ih); // some games only have a header
        if (ok && a) { a.ia = it.ia; a.isc = it.isc; a.ih = it.ih; this.appsF.save(); }
        q.get(id).resolve(ok ? { thumb: assetUrl(it, it.isc), header: assetUrl(it, it.ih) } : null);
      }
    }
  }

  getDb(appid) { return (this.apps[appid] || {}).db || null; }
  hoverUrl(appid) { const db = this.getDb(appid); return db && db.gif; }

  setSettings(patch) {
    const keys = Object.keys(DEFAULT_SETTINGS);
    for (const k of keys) if (k in patch) this.settings[k] = patch[k];
    this.settings.slowness = Math.min(10, Math.max(0.5, Number(this.settings.slowness) || 1));
    this.settings.country = String(this.settings.country || 'US').toUpperCase().slice(0, 2);
    this.settingsF.save();
    this.emit('state');
  }

  // ---- list / reasons --------------------------------------------------------
  _u() { const u = this.user(); if (!u) throw new Error('No profile loaded yet. Sync first.'); return u; }
  listAdd(appid) {
    const u = this._u();
    if (!u.list.some((i) => i.appid === appid)) u.list.push({ appid, why: '', note: '', addedAt: Date.now() });
    this._saveUsers();
  }
  listRemove(appid) { const u = this._u(); u.list = u.list.filter((i) => i.appid !== appid); this._saveUsers(); }
  listSet(appid, patch) {
    const it = this._u().list.find((i) => i.appid === appid);
    if (it) for (const k of ['why', 'note']) if (k in patch) it[k] = String(patch[k]).slice(0, 500);
    this._saveUsers();
  }
  setWhys(arr) {
    const u = this._u();
    u.whys = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].slice(0, 50);
    this._saveUsers();
  }
  _saveUsers() { this.usersF.save(); this.emit('state'); }

  // ---- sync ------------------------------------------------------------------
  cancel() { if (this.abort) this.abort.abort(); }

  _progress(phase, msg, done = 0, total = 0) {
    Object.assign(this.status, { phase, msg, done, total });
    if (phase !== this._lastPhase || done === total) log.info(`sync ${phase}: ${msg}`);
    this._lastPhase = phase;
    this.emit('progress');
  }

  /** mode: 'sync' fetches what is missing/stale; 'prices' force-refreshes every visible game. */
  async sync(mode = 'sync') {
    if (this.status.running) throw new Error('A sync is already running.');
    this.abort = new AbortController();
    const signal = this.abort.signal;
    Object.assign(this.status, { running: true, warnings: [], phase: 'profile', msg: 'Resolving profile…', done: 0, total: 0 });
    const result = { removedFromList: [] };
    log.info(`sync start mode=${mode} user=${this.settings.username} country=${this.settings.country} useFamily=${this.settings.useFamily}`);
    try {
      await this._syncProfile(signal, result);
      await this._syncDetails(mode, signal);
      await this._syncSteamDb(signal);
      this.user().syncedAt = Date.now();
      this._progress('done', 'Up to date.');
      log.info(`sync done: ${this.getState().games.length} games, counts=${JSON.stringify(this.getState().counts)}`);
    } catch (e) {
      log.error(signal.aborted ? 'sync cancelled' : e);
      this.status.msg = signal.aborted ? 'Cancelled.' : e.message;
      this.status.phase = signal.aborted ? 'cancelled' : 'error';
      if (!signal.aborted) this.status.warnings.push(e.message);
    } finally {
      this.status.running = false;
      this.appsF.save(true);
      this.usersF.save(true);
      this.emit('state');
    }
    return result;
  }

  async _syncProfile(signal, result) {
    const { steam, settings } = this;
    const prof = await steam.resolveProfile(settings.username, signal);
    let u = this.users[prof.steamid];
    if (!u) u = this.users[prof.steamid] = { steamid: prof.steamid, wishlist: [], owned: null, family: null, list: [], whys: [...DEFAULT_WHYS] };
    u.name = prof.name;
    this.usersF.data.current = prof.steamid;

    this._progress('wishlist', 'Fetching wishlist…');
    u.wishlist = await steam.getWishlist(prof.steamid, signal);

    const meta = this.appsF.data;
    if (!Object.keys(meta.tags).length || Date.now() - meta.tagsAt > 7 * DAY) {
      this._progress('tags', 'Fetching tag names…');
      meta.tags = await steam.getTagList(signal);
      meta.tagsAt = Date.now();
    }

    this._progress('owned', 'Checking your library…');
    const token = this._familyToken();
    const own = await steam.getOwned(prof.steamid, settings.apiKey, signal, token).catch((e) => { if (signal.aborted) throw e; log.warn(`Owned games: ${e.message}`); return null; });
    if (own) { u.owned = own; u.ownedAt = Date.now(); }

    if (settings.useFamily) await this._syncFamily(u, signal);
    if (!own && !u.owned) this._warn('Could not read your game library, so purchases can only be noticed through the wishlist itself. Steam only shares libraries with a signed-in session or a Steam Web API key: use Settings → Sign in to Steam, or add a Web API key (free at steamcommunity.com/dev/apikey).');

    // Purchased / removed games leave the buying list.
    const wl = new Set(u.wishlist.map((w) => w.appid));
    const owned = new Set(u.owned || []);
    const keep = [];
    for (const it of u.list) {
      if (owned.has(it.appid) || !wl.has(it.appid)) {
        const a = this.apps[it.appid];
        result.removedFromList.push({ appid: it.appid, name: a ? a.name : String(it.appid), bought: owned.has(it.appid) });
      } else keep.push(it);
    }
    u.list = keep;
    this._saveUsers();
  }

  _familyToken() { const s = this.settings; return s.familyToken && Date.now() - s.familyTokenAt < DAY ? s.familyToken : null; }

  // Who in the family owns what: appid -> [steamid of each family member that owns it] (never includes you).
  async _syncFamily(u, signal) {
    const { steam, settings } = this;
    this._progress('family', 'Reading family library…');
    const owners = {};
    const names = { ...(u.familyNames || {}) };
    const add = (appid, sid) => { if (sid && sid !== u.steamid) (owners[appid] ||= new Set()).add(sid); };
    let ok = false;
    if (settings.familyToken && Date.now() - settings.familyTokenAt >= DAY) {
      this._warn('Your Steam sign-in for the family library has expired (it lasts about 24 hours). Sign in again in Settings, then Sync.');
    }
    if (settings.familyToken && Date.now() - settings.familyTokenAt < DAY) {
      try {
        const apps = await steam.getFamilyLibrary(settings.familyToken, u.steamid, signal);
        if (apps) {
          for (const a of apps) for (const sid of a.owners) add(a.appid, sid);
          ok = true; u.familySource = 'family-group';
          // fallback for your own library: the shared library lists the games you own as well
          if (!u.owned) { u.owned = apps.filter((a) => a.owners.includes(u.steamid)).map((a) => a.appid); u.ownedAt = Date.now(); log.info(`own library derived from the family library: ${u.owned.length} games`); }
        }
        else this._warn('Steam says you are not in a Family group (signed-in account).');
      } catch (e) { if (signal.aborted) throw e; this._warn(`Family library: ${e.message}`); }
    }
    const members = String(settings.familyMembers || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    for (const m of members) {
      try {
        const p = await steam.resolveProfile(m, signal);
        names[p.steamid] = p.name;
        const owned = await steam.getOwned(p.steamid, settings.apiKey, signal, this._familyToken());
        if (owned) { owned.forEach((a) => add(a, p.steamid)); ok = true; u.familySource = u.familySource || 'members'; }
        else this._warn(`${m}'s game library is private.`);
      } catch (e) { if (signal.aborted) throw e; this._warn(`${m}: ${e.message}`); }
    }
    // display names for family members we only know by SteamID
    const sids = new Set(Object.values(owners).flatMap((x) => [...x]));
    for (const sid of sids) {
      if (names[sid]) continue;
      try { names[sid] = (await steam.resolveProfile(sid, signal)).name; } catch (e) { if (signal.aborted) throw e; names[sid] = sid; }
    }
    if (ok) {
      u.familyOwners = Object.fromEntries(Object.entries(owners).map(([a, set]) => [a, [...set]]));
      u.family = Object.keys(owners).map(Number);
      u.familyNames = names;
      u.familyAt = Date.now();
      const wl = new Set(u.wishlist.map((w) => w.appid));
      log.info(`family: ${u.family.length} games owned by ${sids.size} member(s); ${u.family.filter((a) => wl.has(a)).length} of them are on your wishlist`);
    } else {
      log.warn('family: nothing could be read');
      if (!members.length && !settings.familyToken) this._warn('Family library is on, but you have not signed in or listed family members (Settings).');
    }
  }

  async _syncDetails(mode, signal) {
    const u = this.user();
    const state = this.getState();
    const visible = new Set(state.games.map((g) => g.id));
    const owned = new Set(u.owned || []);
    const inList = new Set(u.list.map((i) => i.appid));
    const wanted = u.wishlist.filter((w) => !owned.has(w.appid));
    // list items first, then newest wishlist additions
    wanted.sort((a, b) => (inList.has(b.appid) - inList.has(a.appid)) || b.added - a.added);
    const cutoff = Date.now() - (mode === 'prices' ? 0 : DAY);
    const need = wanted.map((w) => w.appid).filter((id) => { const a = this.apps[id]; return !a || (a.at || 0) < (a.gone ? Date.now() - 7 * DAY : cutoff); });
    void visible;
    const cc = this.settings.country;
    let done = 0;
    for (let i = 0; i < need.length; i += BATCH) {
      const chunk = need.slice(i, i + BATCH);
      this._progress('details', `Fetching game details (${done}/${need.length})…`, done, need.length);
      const items = await this.steam.getItems(chunk, cc, signal);
      const seen = new Set();
      for (const it of items) {
        if (!it.id) continue;
        seen.add(it.id);
        const prev = this.apps[it.id];
        this.apps[it.id] = it.gone && prev && prev.name ? { ...prev, gone: true, at: it.at || Date.now() } : { ...(prev && prev.db ? { db: prev.db } : {}), ...it };
      }
      for (const id of chunk) if (!seen.has(id) && !this.apps[id]) this.apps[id] = { id, gone: true, at: Date.now() };
      done += chunk.length;
      this.appsF.save();
      if ((i / BATCH) % 3 === 2) this.emit('state');
    }
    this._progress('details', 'Details up to date.', done, need.length);
    this.emit('state');
  }

  async _syncSteamDb(signal) {
    const u = this.user();
    if (!this.steamdb) return;
    const todo = u.list.map((i) => i.appid).filter((id) => { const a = this.apps[id]; return a && a.name && (!a.db || Date.now() - a.db.at > 14 * DAY); });
    let i = 0;
    for (const id of todo) {
      this._progress('steamdb', `SteamDB history & preview (${i++}/${todo.length})…`, i, todo.length);
      try { await this.fetchSteamDb(id, signal); } catch (e) {
        if (signal.aborted) throw e;
        this._warn(e.challenge ? 'SteamDB asked for a Cloudflare check; use "Open SteamDB check" in Settings, solve it once, then sync again.' : `SteamDB: ${e.message}`);
        break;
      }
    }
  }

  _useFirecrawl() { return !!(this.firecrawl && this.settings.useFirecrawl && this.settings.firecrawlKey); }

  async fetchSteamDb(appid, signal) {
    const a = this.apps[appid];
    if (!a) throw new Error('Unknown game');
    const src = this._useFirecrawl() ? this.firecrawl : this.steamdb;
    if (!src) throw new Error('SteamDB is not available.');
    const r = await src.fetchApp(appid, this.settings.country.toLowerCase(), signal, { price: a.fFin, fin: a.fin, mode: this.settings.fcHistoryMode });
    if (a.fin > 0) { // a lowest price cannot be above today's price
      if (r.low != null) r.low = Math.min(r.low, a.fin);
      if (r.allTimeLow != null) r.allTimeLow = Math.min(r.allTimeLow, a.fin);
    }
    if (!r.history && !r.gif && r.low == null) throw Object.assign(new Error('SteamDB returned no price history or preview for this game (see the log for what it sent).'), { noData: true });
    a.db = { ...r, at: Date.now(), saleEnd: a.end || 0 }; // saleEnd: the sale this data was fetched during (to know when it is stale)
    this.appsF.save();
    this.emit('state');
    return a.db;
  }

  // ---- background SteamDB loader --------------------------------------------------------------------
  // scope: 'mine' (My list), 'sale' (My list, then wishlist games on sale) or 'all' (My list, then the whole wishlist).
  // One game every 1-2 minutes (random), so SteamDB is never hammered. Stops by itself when SteamDB blocks us.
  _bgNeeds(a) {
    if (!a || !a.name || a.gone) return false;
    if (a.dbSkip && Date.now() - a.dbSkip < 7 * DAY) return false; // SteamDB had nothing / failed recently
    const db = a.db;
    if (!db) return true;
    const ended = db.saleEnd && Date.now() / 1000 > db.saleEnd && db.at / 1000 < db.saleEnd; // fetched during a sale that is over
    return !!ended || Date.now() - db.at > 30 * DAY;
  }

  bgQueue(scope) {
    const u = this.user();
    if (!u) return [];
    const mine = u.list.map((i) => i.appid);
    let rest = [];
    if (scope === 'sale' || scope === 'all') {
      const games = this.getState().games.filter((g) => scope === 'all' || g.disc > 0);
      rest = games.sort((a, b) => b.disc - a.disc || b.rc - a.rc).map((g) => g.id);
    }
    return [...new Set([...mine, ...rest])].filter((id) => this._bgNeeds(this.apps[id]));
  }

  bgStart(scope = 'mine') {
    if (this.bg.running) return;
    if (!this.steamdb && !this._useFirecrawl()) throw new Error('SteamDB is not available.');
    const bg = (this.bg = { running: true, scope, done: 0, failed: 0, total: this.bgQueue(scope).length, next: 0, current: 0, name: '', blocked: null, abort: new AbortController(), errors: 0 });
    log.info(`SteamDB background load started: scope=${scope}, ${bg.total} games`);
    this._bgLoop(bg).catch((e) => { log.error('background loop crashed', e); bg.running = false; bg.blocked = { kind: 'errors', msg: e.message }; this.emit('state'); });
    this.emit('state');
  }

  bgStop() {
    if (this.bg.running) { this.bg.abort.abort(); this.bg.running = false; log.info('SteamDB background load stopped'); }
    this.emit('state');
  }

  async _bgLoop(bg) {
    const signal = bg.abort.signal;
    const finish = (blocked) => { bg.running = false; bg.current = 0; bg.next = 0; bg.blocked = blocked || null; this.emit('state'); };
    while (!signal.aborted) {
      const queue = this.bgQueue(bg.scope);
      if (!queue.length) { log.info(`SteamDB background load finished: ${bg.done} loaded, ${bg.failed} without data`); return finish(); }
      const id = queue[0], a = this.apps[id];
      Object.assign(bg, { current: id, name: a.name, total: bg.done + bg.failed + queue.length, next: 0 });
      log.info(`SteamDB background load ${bg.done + bg.failed + 1}/${bg.total}: ${a.name} (${id})`);
      this.emit('state');
      try {
        await this.fetchSteamDb(id, signal);
        bg.done++; bg.errors = 0;
      } catch (e) {
        if (signal.aborted) return finish();
        if (e.challenge || e.fatal) { log.warn(`background load blocked: ${e.message}`); return finish({ kind: e.fatal ? 'firecrawl' : 'challenge', msg: e.message }); }
        a.dbSkip = Date.now();
        bg.failed++;
        if (e.noData) bg.errors = 0;
        else if (++bg.errors >= 3) { log.warn(`background load stopped after repeated errors: ${e.message}`); return finish({ kind: 'errors', msg: e.message }); }
        log.warn(`background load: ${a.name} (${id}) skipped: ${e.message}`);
        this.appsF.save();
      }
      if (!this.bgQueue(bg.scope).length) continue; // loop top reports completion
      const delay = this.bgDelayMs();
      bg.next = Date.now() + delay;
      log.info(`SteamDB background load: next game in ${Math.round(delay / 1000)} s`);
      this.emit('state');
      await new Promise((resolve) => { const t = setTimeout(resolve, delay); signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
    }
    finish();
  }

  _warn(m) { log.warn(m); if (!this.status.warnings.includes(m)) this.status.warnings.push(m); }
}

module.exports = { Engine, DEFAULT_WHYS };
