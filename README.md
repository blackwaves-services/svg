# blackwaves svg (experiment)

Builds blackwaves into a static site whose entry page is an SVG, so a file CDN like jsDelivr can open it. CDNs show `.html` as plain text but show `.svg` as a real page, scripts included.

Nothing here changes the main project. `src/` is read and rewritten during the build only.

## What's in here

| Path | What it is |
|---|---|
| `tools/build.js` | Builds everything into `site/` |
| `tools/shim.js` | Runs first in the SVG and makes the document behave like an HTML page |
| `tools/router.js` | Hash routing (`index.svg#/games`), used in place of `src/lib/router.js` |
| `tools/gateway.js` | Runs next to your server and lets CDN pages call it |
| `site/` | Generated output. This is what the CDN serves |

## Build

Run from the project root, after `npm install`:

```sh
node svg/tools/build.js --api https://your-gateway.example.com
```

Without `--api`, only the parts that need no server work: the interface, settings, themes and cursors.

## The server

A CDN can't run code, so movies, music, manga, AI, chat, the shop, game loading and the proxy browser still need a running blackwaves server. The server only trusts its own origin, so put the gateway in front of it:

```sh
TARGET=http://localhost:8080 ORIGINS=https://cdn.jsdelivr.net PORT=8787 node svg/tools/gateway.js
```

The gateway must be reachable over HTTPS, because an HTTPS page can't call plain HTTP. `TARGET` must be plain HTTP.

## Deploy

Commit `svg/site`, push, then open:

```
https://cdn.jsdelivr.net/gh/<user>/<repo>@<branch or commit>/svg/site/index.svg
```

jsDelivr caches branch URLs for up to 12 hours, so link to a commit or tag to see a change straight away.

## Limits

- **No accounts.** Everyone on `cdn.jsdelivr.net` shares one origin, so any other SVG hosted there could use a signed-in session. Sign-in is blocked in the shim and the gateway removes the session cookie both ways. Chat can be read but not posted to, and CloudSync, coins and buying from the shop are unavailable.
- **Saved data isn't private.** Other pages on that origin can read this page's cookies and local storage, including the key that encrypts saved settings and history. Don't treat a CDN copy as private.
- **Saved data stays on one CDN.** Data belongs to the origin, so a different CDN or mirror starts empty.
- **Service worker scope.** The proxy browser only works under the folder that holds `sw.js`, which is why it sits next to `index.svg`.
