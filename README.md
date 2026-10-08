# Steam Workspace

Electron desktop client for planning Steam purchases. It is a live, cached version of the
`Steam Wishlist Tags` page: your wishlist as a filterable table, tag bubbles, price × discount
charts, and a personal buying list with a reason for each game.

## Features

- **Any Steam user.** Type a username, profile URL or SteamID64 at the top and press **Sync**. The wishlist must be public.
- **Wishlist tab.** Tag filtering (match all / any, shown-on-Steam vs. extra tags), search, sale / release / list filters, sortable columns, tag categories (genre, theme, players, visuals, features).
- **My list tab.** Star (☆) any game to add it. Each item has a customizable **Why buy it** dropdown (“＋ New reason…” or edit them in Settings), a note, current price, SteamDB price history sparkline and all-time low, and a running total.
- **Tag bubbles.** Area = games with the tag; the dark core inside a bubble is how many of those are in My list. Switch the source to *My list* to chart only the tags of games you saved.
- **Price × Discount · tags.** Same axes (x = discount, y = price), one bubble per tag at its average discount/price.
- **Price × Discount · covers.** Same axes with game thumbnails instead of bubbles (zoom and pan; list items are outlined).
- **Family library.** Optionally hide games already in your Steam Family library (see below).
- **After buying.** On the My list tab, **“I bought some games · refresh”** re-syncs, drops owned games from the wishlist, and removes them from your list (a summary is shown).
- **Cached.** Game data (`apps.json`), your lists (`users.json`) and every image (`images/`) are kept in the app's user-data folder, so reopening is instant and offline-friendly.
- **Gentle on the sites.** All requests go through one per-host queue with jittered minimum gaps (Steam API 2.5 s, community 3.5 s, SteamDB 9 s, image CDN 0.3 s), Retry-After-aware backoff on 429/5xx, 25 games per store request, and a *Slowness* multiplier in Settings. Syncs can be cancelled; progress is saved after every batch.

## Data sources

| Data | Source |
| --- | --- |
| Wishlist, prices, discount, reviews, tags, release, developer/publisher | Steam (`IWishlistService`, `IStoreBrowseService/GetItems`, `IStoreService/GetTagList`) |
| Owned games | Public profile XML, or `IPlayerService/GetOwnedGames` if you provide an API key |
| Family library | Steam Family API using your own signed-in session token, or the listed family members' public libraries |
| Price history, hover preview | SteamDB only, and only for games in **My list** (or on demand) |

Steam is always preferred; SteamDB is queried only for history and the animated preview.

### Family library

*Settings → Exclude games already in my Steam Family library*, then either:

1. **Sign in to Steam** (opens a normal Steam login window; the app only reads the short-lived web token, ~24 h), or
2. list family members' profiles (their *Game details* must be public).

### SteamDB and Cloudflare

SteamDB blocks plain HTTP clients, so pages are loaded in a hidden Chromium window with a persistent session. If SteamDB shows a Cloudflare check, open **Settings → Open SteamDB check**, solve it once, and sync again. Scraping SteamDB is best-effort: the price-history JSON and hover-preview URL formats are not an official API and may change. If they do, the rest of the app keeps working.

## Develop

```
npm install
npm start          # run the app
npm test           # engine / throttle unit tests
npm run dist:linux # AppImage + deb  -> dist/
npm run dist:win   # NSIS installer + portable exe -> dist/  (build on Windows, or with wine)
```

CI (`.github/workflows/build.yml`) runs the tests and builds Linux and Windows artifacts on every push.

Dev helpers: `SW_USERDATA=<dir>` overrides the data folder.

## Layout

```
src/main/      main process: engine (sync/state), steam, steamdb, images, throttle, store, IPC
src/renderer/  UI: app.js (tables, list, settings), charts.js (bubbles, scatter), boot.js
resources/     bundled tag → category map used for the colours
test/          node:test unit tests
```
