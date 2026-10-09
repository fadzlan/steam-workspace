'use strict';
const { get } = require('./http');

const API = 'api.steampowered.com';
const COMMUNITY = 'steamcommunity.com';
// Minimum gap between requests per host (ms); scaled by the "slowness" setting.
const GAP = { [API]: 2500, [COMMUNITY]: 3500, 'cdn.cloudflare.steamstatic.com': 300 };

class Steam {
  constructor(throttle) {
    this.t = throttle;
  }

  _json(url, signal) {
    return get(this.t, url, { host: API, minMs: GAP[API], signal });
  }

  // Accepts a vanity name, profile URL, or 17-digit SteamID64.
  async resolveProfile(input, signal) {
    input = String(input || '').trim();
    if (!input) throw new Error('Enter a Steam username first.');
    let m = input.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
    let url;
    if (m) url = `https://steamcommunity.com/profiles/${m[1]}/?xml=1`;
    else if ((m = input.match(/steamcommunity\.com\/id\/([^/?#]+)/i))) url = `https://steamcommunity.com/id/${encodeURIComponent(m[1])}/?xml=1`;
    else if (/^\d{17}$/.test(input)) url = `https://steamcommunity.com/profiles/${input}/?xml=1`;
    else url = `https://steamcommunity.com/id/${encodeURIComponent(input)}/?xml=1`;
    const xml = await get(this.t, url, { host: COMMUNITY, minMs: GAP[COMMUNITY], type: 'text', signal });
    const id = (xml.match(/<steamID64>(\d{17})<\/steamID64>/) || [])[1];
    if (!id) throw new Error(`Steam profile "${input}" was not found.`);
    const name = (xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/) || [])[1] || input;
    return { steamid: id, name };
  }

  async getWishlist(steamid, signal) {
    const j = await this._json(`https://${API}/IWishlistService/GetWishlist/v1/?steamid=${steamid}`, signal);
    const items = (j.response && j.response.items) || [];
    return items.map((i) => ({ appid: i.appid, added: i.date_added || 0 }));
  }

  async getTagList(signal) {
    const j = await this._json(`https://${API}/IStoreService/GetTagList/v1/?language=english`, signal);
    const out = {};
    for (const t of (j.response && j.response.tags) || []) out[t.tagid] = t.name;
    return out;
  }

  // Owned appids of a public profile; null when the library is private.
  async getOwned(steamid, apiKey, signal) {
    if (apiKey) {
      const j = await this._json(`https://${API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamid}&include_played_free_games=1`, signal);
      const g = j.response && j.response.games;
      return g ? g.map((x) => x.appid) : null;
    }
    const xml = await get(this.t, `https://steamcommunity.com/profiles/${steamid}/games?tab=all&xml=1`, { host: COMMUNITY, minMs: GAP[COMMUNITY], type: 'text', signal });
    if (!/<gamesList>/.test(xml) || /<error>/.test(xml)) return null;
    return [...xml.matchAll(/<appID>(\d+)<\/appID>/g)].map((m) => +m[1]);
  }

  // Real Steam Family library, needs a web token from a signed-in store session.
  // Returns [{appid, owners:[steamid,...]}] (owners include you for your own games), or null if not in a family.
  async getFamilyLibrary(token, steamid, signal) {
    const q = `access_token=${encodeURIComponent(token)}&steamid=${steamid}`;
    const g = await this._json(`https://${API}/IFamilyGroupsService/GetFamilyGroupForUser/v1/?${q}`, signal);
    const gid = g.response && g.response.family_groupid;
    if (!gid) return null;
    const j = await this._json(`https://${API}/IFamilyGroupsService/GetSharedLibraryApps/v1/?${q}&family_groupid=${gid}&include_own=true&include_free=false&include_excluded=false&language=english`, signal);
    return ((j.response && j.response.apps) || []).map((a) => ({ appid: a.appid, owners: (a.owner_steamids || []).map(String) }));
  }

  // Batch store lookup: price, reviews, tags (ordered by weight), release, devs.
  async getItems(appids, country, signal) {
    const input = {
      ids: appids.map((appid) => ({ appid })),
      context: { language: 'english', country_code: country },
      data_request: { include_assets: true, include_release: true, include_tag_count: 20, include_reviews: true, include_basic_info: true },
    };
    const url = `https://${API}/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    const j = await this._json(url, signal);
    return ((j.response && j.response.store_items) || []).map(normalizeItem);
  }
}

function normalizeItem(it) {
  if (!it || it.success !== 1) return { id: it && it.id, gone: true };
  const p = it.best_purchase_option || null;
  const rv = (it.reviews && it.reviews.summary_filtered) || {};
  const rel = it.release || {};
  const names = (a) => (a || []).map((x) => x.name).join(', ');
  const free = !!it.is_free;
  const soon = !!rel.is_coming_soon;
  return {
    id: it.appid || it.id,
    name: it.name,
    type: it.type,
    tagids: (it.tags ? it.tags.map((t) => t.tagid) : it.tagids) || [],
    disc: p ? p.discount_pct || 0 : 0,
    orig: p ? +p.original_price_in_cents || +p.final_price_in_cents || 0 : 0,
    fin: p ? +p.final_price_in_cents || 0 : 0,
    fOrig: p ? p.formatted_original_price || p.formatted_final_price || '' : '',
    fFin: p ? p.formatted_final_price || '' : '',
    rp: rv.percent_positive || 0,
    rc: rv.review_count || 0,
    rel: rel.steam_release_date || rel.original_release_date || 0,
    dev: names(it.basic_info && it.basic_info.developers),
    pub: names(it.basic_info && it.basic_info.publishers),
    st: soon ? 2 : free ? 1 : 0,
    // newer apps keep images under hashed paths, so remember the real file names
    ia: (it.assets && it.assets.asset_url_format) || '',
    isc: (it.assets && it.assets.small_capsule) || '',
    ih: (it.assets && it.assets.header) || '',
    at: Date.now(),
  };
}

const ASSET_BASE = 'https://shared.steamstatic.com/store_item_assets/';
const assetUrl = (a, file) => (a && a.ia && file ? ASSET_BASE + a.ia.replace('${FILENAME}', file) : null);

module.exports = { Steam, normalizeItem, assetUrl };
