// builds blackwaves into svg/site: an index.svg plus plain files a cdn can serve.
//   node svg/tools/build.js --api https://your-gateway
// optional: --bare <bare server url> --wisp <wisp url> --transport <default transport>
// transports: libcurl, epoxy, bare, libcurl-bare, epoxy-bare
// src/ isn't touched. its paths and page routing get rewritten here, during the build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import preact from "@preact/preset-vite";

const tools = path.dirname(fileURLToPath(import.meta.url));
const svgDir = path.dirname(tools);
const project = path.dirname(svgDir);
const site = path.join(svgDir, "site");
const modules = path.join(project, "node_modules", "@mercuryworkshop");
const pkg = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));

const option = (name) => {
  const flag = process.argv.indexOf(`--${name}`);
  return flag > 0 ? process.argv[flag + 1] : "";
};
const api = (option("api") || process.env.BW_SVG_API || "").replace(/\/+$/, "");
if (api && !/^https?:\/\//.test(api)) throw new Error("--api needs a full url, like https://your-gateway");
// the gateway hosts all of these, so they follow --api unless they live somewhere else
const bare = option("bare") || (api ? `${api}/bare/` : "");
const wisp = option("wisp") || (api ? `${api.replace(/^http/, "ws")}/wisp/` : "");
const transport = option("transport") || "libcurl";
if (!["libcurl", "epoxy", "bare", "libcurl-bare", "epoxy-bare"].includes(transport)) throw new Error(`unknown transport ${transport}`);
if (bare && !/^https?:\/\/.*\/$/.test(bare)) throw new Error("--bare needs a full url ending in /");
if (wisp && !/^wss?:\/\//.test(wisp)) throw new Error("--wisp needs a ws:// or wss:// url");
if (!api) console.warn("no --api given: pages that need the server (movies, music, manga, ai, proxy) won't load");

const prefix = (quote, global, rest) => (quote === "`" ? "`${window." + global + "}" + rest : `window.${global}+${quote}${rest}`);

// [file, what to find, what to put there]. a miss stops the build, so the svg
// build can't quietly fall out of step with src/
const PATCHES = [
  ["src/lib/api.js", "SHAREABLE.test(path)", 'SHAREABLE.test(path.replace(window.__BW_API__, ""))'],
  ["src/lib/proxy.js", /const PREFIX = "\/~\/sj\/"/, 'const PREFIX = new URL(window.__BW_BASE__).pathname + "~/sj/"'],
  ["src/lib/proxy.js", /`\$\{location\.protocol === "https:" \? "wss" : "ws"\}:\/\/\$\{location\.host\}\/wisp\/`/, "window.__BW_WISP__"],
  [
    "src/lib/proxy.js",
    /const path = name === "libcurl" \? (.+?) : (.+?);/,
    `const viaBare = await import(/* @vite-ignore */ window.__BW_BASE__ + "bare/transport.mjs");
  viaBare.tunnelWisp(name.endsWith("-bare") ? wispUrl() : null);
  const engine = name.replace("-bare", "");
  const path = engine === "bare" ? window.__BW_BASE__ + "bare/transport.mjs" : engine === "libcurl" ? $1 : $2;`,
  ],
  ["src/lib/settings.js", 'transport: "libcurl"', 'transport: window.__BW_CONFIG__.transport'],
  // no server to keep a realtime connection to
  ["src/lib/realtime.js", /(export function connect\(\) \{\s*wanted = true;)/, "$1\n  if (!window.__BW_CONFIG__.api) return;"],
  // without a server, covers and site icons load straight from where they live
  ["src/lib/gameurl.js", /url \? (`\$\{window\.__BW_API__\}\/!cover!\/.*?`) : ""/, 'url ? (window.__BW_API__ ? $1 : url) : ""'],
  ["src/lib/games/sources.js", /url \? (`\$\{window\.__BW_API__\}\/!cover!\/.*?`) : ""/, 'url ? (window.__BW_API__ ? $1 : url) : ""'],
  [
    "src/components/Settings.jsx",
    /\{\s*id: "libcurl",\s*name: "libcurl \(default\)"\s*\}/,
    '{ id: "libcurl", name: "libcurl" }, { id: "bare", name: "bare" }, { id: "libcurl-bare", name: "libcurl through bare" }, { id: "epoxy-bare", name: "epoxy through bare" }',
  ],
  ["src/lib/proxy.js", /scope: "\/"/, "scope: window.__BW_BASE__"],
  ["src/lib/realtime.js", /`\$\{location\.protocol === "https:" \? "wss" : "ws"\}:\/\/\$\{location\.host\}\/api\/ws`/, 'window.__BW_WS__ + "/api/ws"'],
  ["src/lib/cloak.js", 'location.origin + "/"', 'location.href.split("#")[0]'],
  ["src/lib/easter.js", "<svg viewBox", '<svg xmlns="http://www.w3.org/2000/svg" viewBox'],
  ["src/pages/Games.jsx", "location.origin + src", "src"],
  ["src/pages/Games.jsx", "location.search", "window.__BW_SEARCH__()"],
  ["src/pages/Movies.jsx", "location.search", "window.__BW_SEARCH__()"],
];

function rewrite(code, id) {
  const file = path.relative(project, id.split("?")[0]).replace(/\\/g, "/");
  if (!/^(src|shared)\/.*\.jsx?$/.test(file)) return null;
  let out = code;
  // things only the server has
  out = out.replace(/(["'`])\/api\//g, (_, quote) => prefix(quote, "__BW_API__", "/api/"));
  out = out.replace(/(["'`])\/assets\/decor\//g, (_, quote) => prefix(quote, "__BW_DECOR__", "/assets/decor/"));
  out = out.replace(/`\/(!!\/|!cover!\/)/g, (_, rest) => prefix("`", "__BW_API__", `/${rest}`));
  // things copied next to index.svg
  out = out.replace(/(["'`])\/(favicon\.ico|assets\/(?:cursors|partners|img)\/|scram\/|ctrl\/|epoxy\/|libcurl\/|sw\.js)/g, (_, quote, rest) =>
    prefix(quote, "__BW_BASE__", rest),
  );
  for (const [target, find, replace] of PATCHES) {
    if (target !== file) continue;
    const next = out.replace(find, replace);
    if (next === out) throw new Error(`svg build: ${file} no longer has ${find}`);
    out = next;
  }
  return out === code ? null : { code: out, map: null };
}

const svgBuild = {
  name: "blackwaves-svg",
  enforce: "post",
  load(id) {
    if (id.split("?")[0].replace(/\\/g, "/").endsWith("/src/lib/router.js")) return fs.readFileSync(path.join(tools, "router.js"), "utf8");
    return null;
  },
  transform: rewrite,
  generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
      // :root is the <svg> here. the html element is what carries the theme
      file.source = String(file.source).replace(/:root/g, "html").replace(/url\((["']?)\/assets\//g, "url($1../assets/");
    }
  },
};

// empty it rather than delete it: windows refuses while anything has the folder open
fs.mkdirSync(site, { recursive: true });
for (const name of fs.readdirSync(site)) fs.rmSync(path.join(site, name), { recursive: true, force: true });

await build({
  configFile: false,
  root: path.join(project, "src"),
  base: "./",
  publicDir: false,
  logLevel: "warn",
  plugins: [preact(), svgBuild],
  define: { __BW_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: site,
    emptyOutDir: false,
    assetsDir: "_bw",
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/hls.js")) return "hls";
          if (id.includes("node_modules/preact") || id.includes("node_modules/@preact")) return "preact";
        },
      },
    },
  },
});

// ---- index.svg ----------------------------------------------------------------------
const xml = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const cdata = (value) => {
  if (value.includes("]]>")) throw new Error("svg build: ]]> can't go inside a script");
  return `<![CDATA[${value}]]>`;
};

const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
const attr = (tag, name) => new RegExp(`${name}="([^"]+)"`).exec(tag)?.[1];
const tags = html.match(/<(?:script|link)\b[^>]*>/g) || [];
const entry = attr(tags.find((tag) => tag.startsWith("<script") && attr(tag, "src")) || "", "src");
if (!entry) throw new Error("svg build: no entry script in the vite output");
const links = tags
  .filter((tag) => /rel="(modulepreload|stylesheet)"/.test(tag) && attr(tag, "href")?.startsWith("./"))
  .map((tag) => `<link rel="${attr(tag, "rel")}" crossorigin="anonymous" href="${xml(attr(tag, "href"))}" />`);

const FONT = "https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500&display=swap";
const STYLE = `
html, body { margin: 0; width: 100%; height: 100%; background: #04070d; }
html { overflow: hidden; }
body { overflow-x: hidden; overflow-y: auto; }
foreignObject { overflow: visible; }
#boot { position: fixed; inset: 0; display: grid; place-items: center; }
#boot img { width: 64px; opacity: .85; animation: boot 1.6s ease-in-out infinite; }
@keyframes boot { 50% { transform: translateY(-6px); opacity: .5; } }
`;

// chrome won't run <script type="module"> in an xml document, but import() works
const BOOT = `import(${JSON.stringify(entry)}).catch(function (error) {
  console.error(error);
  document.getElementById("boot").textContent = "blackwaves couldn't load. reload to try again.";
});`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><title>blackwaves</title><foreignObject width="100%" height="100%"><html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head>
<script>//${cdata(`\nwindow.__BW_CONFIG__ = ${JSON.stringify({ api, bare, wisp, transport })};\n${fs.readFileSync(path.join(tools, "shim.js"), "utf8")}//`)}</script>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#04070d" />
<link rel="icon" href="./favicon.ico" type="image/png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
<link rel="stylesheet" href="${xml(FONT)}" />
${links.join("\n")}
<style>${cdata(STYLE)}</style>
</head><body><div id="boot"><img src="./favicon.ico" alt="" /></div><div id="app"></div><script>//${cdata(`
${BOOT}
//`)}</script></body></html></foreignObject></svg>
`;
fs.writeFileSync(path.join(site, "index.svg"), svg);
// a cdn shows html as plain text, and nothing links here
fs.rmSync(path.join(site, "index.html"));

// ---- the files the server normally hands out ------------------------------------------
function copy(from, to) {
  fs.mkdirSync(path.dirname(path.join(site, to)), { recursive: true });
  fs.cpSync(from, path.join(site, to), { recursive: true });
}
copy(path.join(project, "favicon.ico"), "favicon.ico");
copy(path.join(project, "assets", "cursors"), "assets/cursors");
copy(path.join(project, "assets", "partners"), "assets/partners");
copy(path.join(project, "assets", "images"), "assets/img");
// the shop's pictures only. the animated versions stay on the server, they're 40 mb
for (const name of fs.readdirSync(path.join(project, "assets", "decor"))) {
  if (name.endsWith(".png")) copy(path.join(project, "assets", "decor", name), `assets/decor/${name}`);
}
copy(path.join(modules, "scramjet", "dist", "scramjet.wasm"), "scram/scramjet.wasm");
for (const file of ["controller.api.js", "controller.inject.js", "controller.sw.js"]) copy(path.join(modules, "scramjet-controller", "dist", file), `ctrl/${file}`);
copy(path.join(modules, "epoxy-transport", "dist", "index.mjs"), "epoxy/index.mjs");
copy(path.join(modules, "libcurl-transport", "dist", "index.mjs"), "libcurl/index.mjs");
copy(path.join(svgDir, "node_modules", "@mercuryworkshop", "bare-as-module3", "dist", "index.mjs"), "bare/client.mjs");
copy(path.join(tools, "bare-transport.js"), "bare/transport.mjs");

// same fix server/index.js applies when it serves this file
const FIND = "s=(0,n.Qf)(t.args[2]);";
const scramjet = fs.readFileSync(path.join(modules, "scramjet", "dist", "scramjet.js"), "utf8");
if (!scramjet.includes(FIND)) console.warn("scramjet patch didn't apply, the bundle probably changed");
fs.writeFileSync(path.join(site, "scram", "scramjet.js"), scramjet.replace(FIND, "s=t.args[2]==null?t.args[2]:(0,n.Qf)(t.args[2]);"));

const worker = fs.readFileSync(path.join(project, "public", "sw.js"), "utf8");
if (!worker.includes('importScripts("/ctrl/controller.sw.js")')) throw new Error("svg build: public/sw.js changed");
fs.writeFileSync(path.join(site, "sw.js"), worker.replace('importScripts("/ctrl/controller.sw.js")', 'importScripts("./ctrl/controller.sw.js")'));

let bytes = 0;
let count = 0;
for (const entryFile of fs.readdirSync(site, { recursive: true, withFileTypes: true })) {
  if (!entryFile.isFile()) continue;
  bytes += fs.statSync(path.join(entryFile.parentPath, entryFile.name)).size;
  count++;
}
console.log(`svg/site: ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, api: ${api || "none"}, bare: ${bare || "none"}, transport: ${transport}`);
