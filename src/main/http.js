'use strict';
const { sleep } = require('./throttle');
const log = require('./log');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SteamWorkspace/0.1 Chrome/120 Safari/537.36';

// Throttled GET with Retry-After aware exponential backoff on 429/5xx.
let fetchImpl = (...a) => fetch(...a);
// Main process swaps in Electron's net.fetch so system proxy settings are honoured.
const setFetch = (f) => { fetchImpl = f; };
// One un-retried request through the current fetch (used for POSTs to third-party APIs).
const fetchNow = (url, opts) => fetchImpl(url, opts);

async function get(throttle, url, { host, minMs, type = 'json', headers = {}, signal, retries = 4, quiet = [] } = {}) {
  host = host || new URL(url).host;
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await throttle.run(host, minMs, () => fetchImpl(url, { headers: { 'user-agent': UA, ...headers }, signal }), signal);
    } catch (e) {
      if (!(signal && signal.aborted) && e.message !== 'cancelled') log.warn(`network error ${host}${new URL(url).pathname}: ${e.message}`);
      throw e;
    }
    if (res.ok) {
      if (type === 'json') return res.json();
      if (type === 'buffer') return Buffer.from(await res.arrayBuffer());
      return res.text();
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!quiet.includes(res.status)) log.warn(`HTTP ${res.status} ${host}${new URL(url).pathname} (attempt ${attempt + 1}${retryable && attempt < retries ? ', will retry' : ''})`);
    if (!retryable || attempt >= retries) {
      const err = new Error(`HTTP ${res.status} for ${host}`);
      err.status = res.status;
      throw err;
    }
    const ra = Number(res.headers.get('retry-after'));
    const backoff = (ra > 0 ? ra * 1000 : 30000) * 2 ** attempt;
    throttle.penalize(host, backoff);
    attempt++;
    await sleep(0);
  }
}

module.exports = { get, setFetch, fetchNow, UA };
