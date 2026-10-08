'use strict';
// Per-host serial queue with a minimum, jittered gap between requests.
// Everything that talks to the network goes through here so syncs stay slow.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Throttle {
  constructor(multiplier = () => 1) {
    this.multiplier = multiplier;
    this.hosts = new Map();
  }

  _host(name) {
    let h = this.hosts.get(name);
    if (!h) this.hosts.set(name, (h = { tail: Promise.resolve(), last: 0 }));
    return h;
  }

  run(host, minMs, fn, signal) {
    const h = this._host(host);
    const p = h.tail.then(async () => {
      if (signal && signal.aborted) throw new Error('cancelled');
      const gap = minMs * this.multiplier() * (0.85 + Math.random() * 0.5);
      const wait = h.last + gap - Date.now();
      if (wait > 0) await sleep(wait);
      if (signal && signal.aborted) throw new Error('cancelled');
      try {
        return await fn();
      } finally {
        h.last = Math.max(h.last, Date.now());
      }
    });
    h.tail = p.catch(() => {});
    return p;
  }

  // Push the next request on this host `ms` into the future (rate-limit backoff).
  penalize(host, ms) {
    const h = this._host(host);
    h.last = Math.max(h.last, Date.now() + ms);
  }
}

module.exports = { Throttle, sleep };
