'use strict';
const fs = require('fs');
const path = require('path');
const { get } = require('./http');

const CDN = 'cdn.cloudflare.steamstatic.com';
const EXT_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

// On-disk image cache. Files are fetched lazily, one at a time, the first time the UI asks.
class Images {
  constructor(dir, throttle, resolveHover) {
    this.dir = dir;
    this.t = throttle;
    this.resolveHover = resolveHover; // (appid) => url | null
    this.inflight = new Map();
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
    if (!this.inflight.has(key)) {
      const p = this._download(kind, id).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return this.inflight.get(key);
  }

  async _download(kind, id) {
    for (const url of this._candidates(kind, id)) {
      try {
        const buf = await get(this.t, url, { host: CDN, minMs: 300, type: 'buffer', retries: 2 });
        const ext = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
        const dir = path.join(this.dir, kind);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, id + ext);
        fs.writeFileSync(file, buf);
        return file;
      } catch (_) {
        /* try next candidate */
      }
    }
    return null;
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
