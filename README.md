# Steam Workspace

Electron desktop client for planning Steam purchases. It is a live, cached version of the
`Steam Wishlist Tags` page: your wishlist as a filterable table, tag bubbles, price × discount
charts, and a personal buying list with a reason for each game.

## Features

- **Any Steam user.** Type a username, profile URL or SteamID64 at the top and press **Sync**. The wishlist must be public.
- **Wishlist tab.** Tag filtering (match all / any, shown-on-Steam vs. extra tags), search, sale / release / list filters, sortable columns (including **Saved**, the full price minus the sale price), a tag-filter panel you can collapse (« / »), tag categories (genre, theme, players, visuals, features).
- **My list tab.** Star (☆) any game to add it. Each item shows its tags under the thumbnail (toggle *Shown tags* / *All tags*) and has a customizable **Why buy it** dropdown (“＋ New reason…” or edit them in Settings), a roomy note box, current price, SteamDB price history sparkline and lowest price (SteamDB gives anonymous visitors a 2-year history, so it reads *2-year low*), and a running total.
- **Tag bubbles.** Area = games with the tag; the dark core inside a bubble is how many of those are in My list. Switch the source to *My list* to chart only the tags of games you saved.
- **Price × Discount · tags.** Same axes (x = discount, y = price), one bubble per tag at its average discount/price.
- **Price × Discount · covers.** Same axes with game thumbnails instead of bubbles (zoom and pan; list items are outlined).
- **Family library.** Optionally read your Steam Family library: games a family member owns get a 👪 badge naming who, and a **Family** filter on the Wishlist tab lets you show all, hide family-owned, show only family-owned, or only games owned by one member (see below).
- **After buying.** On the My list tab, **“I bought some games · refresh”** re-syncs, drops owned games from the wishlist, and removes them from your list (a summary is shown).
- **Cached.** Game data (`apps.json`), your lists (`users.json`) and every image (`images/`) are kept in the app's user-data folder, so reopening is instant and offline-friendly.
- **Theme.** The header selector switches between System (follows your OS), Light and Dark and remembers the choice.
- **Gentle on the sites.** All requests go through one per-host queue with jittered minimum gaps (Steam API 2.5 s, community 3.5 s, SteamDB 9 s, image CDN 0.3 s), Retry-After-aware backoff on 429/5xx, 25 games per store request, and a *Slowness* multiplier in Settings. Syncs can be cancelled; progress is saved after every batch.

## Install

Download the file for your system from the [Releases page](https://github.com/fadzlan/steam-workspace/releases).
Releases are currently marked *pre-release*, so open the newest one yourself (GitHub's "Latest" badge will not point at it).
File names carry the version, e.g. `Steam.Workspace.Setup.0.1.0.exe`.

| Platform | File | How to install |
| --- | --- | --- |
| Windows | `Steam.Workspace.Setup.<version>.exe` | Run the installer and pick a folder. |
| Windows (no install) | `Steam.Workspace.<version>.exe` | Portable build: put it anywhere and double-click. |
| Linux (any distro) | `Steam.Workspace-<version>.AppImage` | `chmod +x Steam.Workspace-*.AppImage && ./Steam.Workspace-*.AppImage` |
| Debian / Ubuntu / Mint | `steam-workspace_<version>_amd64.deb` | `sudo apt install ./steam-workspace_*_amd64.deb` |
| Arch / Manjaro / EndeavourOS | `steam-workspace-bin-<version>-<rel>-x86_64.pkg.tar.zst` | `sudo pacman -U steam-workspace-bin-*.pkg.tar.zst` |
| Arch (build it yourself) | `PKGBUILD` | Save it in an empty folder, then `makepkg -si` |

macOS builds are not provided.

### Notes

- **Windows SmartScreen.** The binaries are not code-signed, so Windows shows "Windows protected your PC". Choose **More info → Run anyway**.
- **AppImage needs FUSE 2.** If it refuses to start, install `libfuse2` (Debian/Ubuntu: `sudo apt install libfuse2`; Ubuntu 24.04: `libfuse2t64`; Arch: `fuse2`). You can also run it without FUSE: `./Steam.Workspace-*.AppImage --appimage-extract-and-run`.
- **Sandbox errors on Linux.** On distributions that restrict unprivileged user namespaces (e.g. Ubuntu 24.04) the AppImage may print a `chrome-sandbox` error. The `.deb` and Arch packages install the sandbox helper correctly, so prefer those; as a last resort start the AppImage with `--no-sandbox`.
- **Architectures.** Only 64-bit x86 (x64 / amd64 / x86_64) is built.
- **Where data lives.** Cached game data, images and your lists are stored in the app's user-data folder (`~/.config/` on Linux, `%APPDATA%` on Windows). Uninstalling does not remove it; delete that folder to reset, or use *Settings → Clear image cache*.
- **Logs.** The app writes `app.log` (rolled to `app.old.log` at 1 MB) in a `logs` folder inside the user-data folder. Open it with *Settings → Open log folder*. It records sync steps, HTTP errors/retries and crashes; API keys and tokens are scrubbed. Attach it when reporting a problem.
- **Updating.** There is no auto-update yet: install the newer release over the old one. Your data is kept.
- **AUR.** The package is prepared for the Arch User Repository (`steam-workspace-bin`, `packaging/aur/`) but not published there yet. Until then use the `.pkg.tar.zst` or `PKGBUILD` above.

### Run from source

```
git clone https://github.com/fadzlan/steam-workspace.git
cd steam-workspace
npm install
npm start
```

Needs Node.js 20 or newer (22 is what CI uses). See *Develop* below for building installers yourself.

## Data sources

| Data | Source |
| --- | --- |
| Wishlist, prices, discount, reviews, tags, release, developer/publisher | Steam (`IWishlistService`, `IStoreBrowseService/GetItems`, `IStoreService/GetTagList`) |
| Owned games | Public profile XML, or `IPlayerService/GetOwnedGames` if you provide an API key |
| Family library | Steam Family API using your own signed-in session token, or the listed family members' public libraries |
| Price history, hover preview (a short muted trailer that plays when you hover a thumbnail) | SteamDB only, and only for games in **My list** (or on demand) |

Steam is always preferred; SteamDB is queried only for history and the hover preview.

### Family library

*Settings → Read my Steam Family library*, then either:

1. **Sign in to Steam** (opens a normal Steam login window; the app only reads the short-lived web token, ~24 h), which reads the whole family group and who owns what, or
2. list family members' profiles (their *Game details* must be public).

Press **Sync**. Family-owned games then show a 👪 badge with the owner names, and a **Family** dropdown appears in the Wishlist toolbar:
*show all*, *hide family-owned*, *only family-owned*, or *owned by <member>*. The filter also applies to the charts. Games you own yourself are always removed from the wishlist.

### SteamDB and Cloudflare

SteamDB blocks plain HTTP clients, so each game's page is loaded once in a real Chromium window with a persistent session
(its price-history and hover-card requests are then made from inside that page, so each game costs one page load plus two small requests).

When SteamDB shows a Cloudflare / human check, the app opens that window in front of you and shows a banner. Complete the
check; the window then closes by itself and the load continues (it waits up to 3 minutes). The Cloudflare cookie is kept, so
you should only see it occasionally. *Settings → Open SteamDB check* opens the same window if you want to pass the check ahead of time.

Scraping SteamDB is best-effort: the price-history and hover-card endpoints are SteamDB's own front-end calls, not an official API, and may change. If they do,
the app tells you and the rest keeps working; the details are in the log.

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

## Arch packaging

`packaging/aur/PKGBUILD` builds `steam-workspace-bin` from the release `.deb`; CI runs it in an Arch container and attaches
the resulting package and the `PKGBUILD` to every release. If the repository secret `AUR_SSH_PRIVATE_KEY` is set, CI also pushes
the update to the AUR (`packaging/aur/publish.sh`).
