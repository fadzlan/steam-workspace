'use strict';
const path = require('path');
const { JsonFile } = require('./store');
const log = require('./log');
const { assetUrl } = require('./steam');

const DAY = 864e5;
const DEFAULT_WHYS = ['Great price', 'Wanted for a long time', 'Friends play it', 'Highly rated', 'Genre I love', 'Near historical low', 'Good for the family'];
const DEFAULT_SETTINGS = { username: '', country: 'MY', excludeFamily: false, familyMembers: '', apiKey: '', slowness: 1, familyToken: null, familyTokenAt: 0 };
const BATCH = 25;

// Everything stateful and network-driven lives here; electron-specific bits are injected
// so this can be unit tested with fakes.
class Engine {
  constructor({ dir, steam, steamdb, emit }) {
    this.steam = steam;
    this.steamdb = steamdb;
    this.emit = emit || (() => {});
    this.settingsF = new JsonFile(path.join(dir, 'settings.json'), DEFAULT_SETTINGS);
    this.appsF = new JsonFile(path.join(dir, 'apps.json'), { apps: {}, tags: {}, tagsAt: 0 });
    this.usersF = new JsonFile(path.join(dir, 'users.json'), { users: {}, current: null });
    this.status = { running: false, phase: '', done: 0, total: 0, msg: '', warnings: [] };
    this.abort = null;
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
    const fam = new Set(s.excludeFamily ? u.family || [] : []);
    let hiddenOwned = 0, hiddenFamily = 0, pending = 0, unavailable = 0;
    for (const w of u.wishlist) {
      if (owned.has(w.appid)) { hiddenOwned++; continue; }
      if (fam.has(w.appid)) { hiddenFamily++; continue; }
      const a = this.apps[w.appid];
      if (a && a.gone) { unavailable++; continue; } // Steam returns nothing: delisted, removed or region-locked
      if (!a || !a.name) { pending++; continue; }
      out.games.push({ ...a, added: w.added, db: undefined, hasDb: !!a.db, gif: !!(a.db && a.db.gif) });
    }
    out.profile = { steamid: u.steamid, name: u.name, ownedKnown: u.owned != null, familyKnown: u.family != null, familyAt: u.familyAt || 0, syncedAt: u.syncedAt || 0 };
    out.counts = { wishlist: u.wishlist.length, hiddenOwned, hiddenFamily, pending, unavailable };
    out.whys = u.whys || DEFAULT_WHYS;
    out.list = u.list.map((i) => {
      const a = this.apps[i.appid] || {};
      const db = a.db || null;
      return { ...i, history: db ? db.history : null, low: db ? db.low : null, lowAt: db ? db.lowAt : null };
    });
    return out;
  }

  // Real (hashed) image URLs for an app, looked up lazily and in batches when a default URL 404s.
  assetUrls(id) {
    const a = this.apps[id];
    if (a && a.isc) return Promise.resolve({ thumb: assetUrl(a, a.isc), header: assetUrl(a, a.ih) });
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
        if (it && !it.gone && a && it.isc) { a.ia = it.ia; a.isc = it.isc; a.ih = it.ih; this.appsF.save(); }
        q.get(id).resolve(it && it.isc ? { thumb: assetUrl(it, it.isc), header: assetUrl(it, it.ih) } : null);
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
    log.info(`sync start mode=${mode} user=${this.settings.username} country=${this.settings.country} excludeFamily=${this.settings.excludeFamily}`);
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
    const own = await steam.getOwned(prof.steamid, settings.apiKey, signal).catch((e) => { this._warn(`Owned games: ${e.message}`); return null; });
    if (own) { u.owned = own; u.ownedAt = Date.now(); }
    else this._warn('Your game library is private, so purchases can only be detected through the wishlist itself. Make "Game details" public or add a Steam Web API key in Settings.');

    if (settings.excludeFamily) await this._syncFamily(u, signal);

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

  async _syncFamily(u, signal) {
    const { steam, settings } = this;
    this._progress('family', 'Reading family library…');
    const ids = new Set();
    let ok = false;
    if (settings.familyToken && Date.now() - settings.familyTokenAt < DAY) {
      try {
        const apps = await steam.getFamilyLibrary(settings.familyToken, u.steamid, signal);
        if (apps) { apps.forEach((a) => ids.add(a)); ok = true; u.familySource = 'family-group'; }
      } catch (e) { this._warn(`Family library: ${e.message}`); }
    }
    const members = String(settings.familyMembers || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    for (const m of members) {
      try {
        const p = await steam.resolveProfile(m, signal);
        const owned = await steam.getOwned(p.steamid, settings.apiKey, signal);
        if (owned) { owned.forEach((a) => ids.add(a)); ok = true; u.familySource = u.familySource || 'members'; }
        else this._warn(`${m}'s game library is private.`);
      } catch (e) { if (signal.aborted) throw e; this._warn(`${m}: ${e.message}`); }
    }
    if (ok) { u.family = [...ids]; u.familyAt = Date.now(); }
    else if (!members.length && !(settings.familyToken)) this._warn('Family exclusion is on, but no family sign-in or members are configured (Settings).');
  }

  async _syncDetails(mode, signal) {
    const u = this.user();
    const state = this.getState();
    const visible = new Set(state.games.map((g) => g.id));
    const owned = new Set(u.owned || []);
    const fam = new Set(this.settings.excludeFamily ? u.family || [] : []);
    const inList = new Set(u.list.map((i) => i.appid));
    const wanted = u.wishlist.filter((w) => !owned.has(w.appid) && !fam.has(w.appid));
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
        this.apps[it.id] = { ...(prev && prev.db ? { db: prev.db } : {}), ...it };
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

  async fetchSteamDb(appid, signal) {
    const a = this.apps[appid];
    if (!a) throw new Error('Unknown game');
    const r = await this.steamdb.fetchApp(appid, this.settings.country.toLowerCase(), signal);
    if (!r.history && !r.gif) throw new Error('SteamDB returned no history or preview for this game (the page layout may have changed, see the log).');
    a.db = { ...r, at: Date.now() };
    this.appsF.save();
    this.emit('state');
    return a.db;
  }

  _warn(m) { log.warn(m); if (!this.status.warnings.includes(m)) this.status.warnings.push(m); }
}

module.exports = { Engine, DEFAULT_WHYS };
