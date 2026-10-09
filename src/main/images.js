'use strict';
const fs = require('fs');
const path = require('path');
const { get } = require('./http');
const log = require('./log');

const CDN = 'cdn.cloudflare.steamstatic.com';
const EXT_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4' };

// On-disk image cache. Files are fetched lazily, one at a time, the first time the UI asks.
class Images {
  constructor(dir, throttle, resolveHover, resolveAssets, peekAssets) {
    this.dir = dir;
    this.t = throttle;
    this.resolveHover = resolveHover; // (appid) => url | null
    this.resolveAssets = resolveAssets || (async () => null); // (appid) => {thumb, header} | null
    this.peekAssets = peekAssets || (() => null); // (appid) => {thumb, header} | null, already-known hashed URLs
    this.inflight = new Map();
    this.failed = new Map(); // key -> time of last failure, to avoid hammering 404s
  }

  _candidates(kind, id) {
    const base = `https://${CDN}/steam/apps/${id}`;
    if (kind === 'thumb') return [`${base}/capsule_231x87.jpg`, `${base}/header.jpg`];
    if (kind === 'header') return [`${base}/header.jpg`];
    if (kind === 'hover') {
      const u = this.resolveHover(id);
      return u ? [u] : [];
    }
    return [];
  }

  _existing(kind, id) {
    const d = path.join(this.dir, kind);
    try {
      const f = fs.readdirSync(d).find((n) => n.startsWith(id + '.'));
      return f ? path.join(d, f) : null;
    } catch (_) {
      return null;
    }
  }

  async get(kind, id) {
    id = String(id);
    if (!/^\d+$/.test(id) || !['thumb', 'header', 'hover'].includes(kind)) return null;
    const hit = this._existing(kind, id);
    if (hit) return hit;
    const key = kind + id;
    if (Date.now() - (this.failed.get(key) || 0) < 10 * 60 * 1000) return null;
    if (!this.inflight.has(key)) {
      const p = this._download(kind, id).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return this.inflight.get(key);
  }

  // -> {file} or {err}. 404s are expected while guessing URLs, so only the final outcome is logged (see _download).
  async _try(url, kind, id) {
    try {
      const buf = await get(this.t, url, { host: new URL(url).host, minMs: 300, type: 'buffer', retries: 2, quiet: [404] });
      const ext = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
      const dir = path.join(this.dir, kind);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, id + ext);
      fs.writeFileSync(file, buf);
      return { file };
    } catch (e) {
      return { err: e.status ? `HTTP ${e.status}` : e.message };
    }
  }

  hasCached(kind, id) { return !!this._existing(kind, String(id)); }

  async _download(kind, id) {
    const attempts = [];
    const short = (u) => { const x = new URL(u); return x.host + x.pathname.replace(/^(.{0,60}).*(.{25})$/, '$1…$2'); };
    const tryAll = async (urls, label) => {
      for (const url of urls) {
        if (!url) continue;
        const r = await this._try(url, kind, id);
        if (r.file) return r.file;
        attempts.push(`${label} ${r.err} ${short(url)}`);
      }
      return null;
    };
    const pick = (a) => (a ? (kind === 'thumb' ? [a.thumb, a.header] : [a.header]) : []);
    const isImage = kind === 'thumb' || kind === 'header';
    // 1. URLs the store API already told us (newer games use hashed paths), 2. the legacy path, 3. ask the API now
    let f = isImage ? await tryAll(pick(this.peekAssets(Number(id))), 'known:') : null;
    if (!f) f = await tryAll(this._candidates(kind, id), 'default:');
    if (!f && isImage) f = await tryAll(pick(await this.resolveAssets(Number(id)).catch(() => null)), 'store API:');
    if (f) {
      if (attempts.length) log.info(`${kind} ${id}: ok after ${attempts.length} failed attempt(s): ${attempts.join('; ')}`);
    } else {
      this.failed.set(kind + id, Date.now());
      log.warn(`${kind} ${id}: download failed (${attempts.join('; ') || 'no URL known'})`);
    }
    return f;
  }

  size() {
    let n = 0, bytes = 0;
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { n++; bytes += fs.statSync(p).size; }
      }
    };
    walk(this.dir);
    return { files: n, bytes };
  }

  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

module.exports = { Images, EXT_MIME };
