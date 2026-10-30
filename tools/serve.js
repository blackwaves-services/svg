// try svg/site on your own machine, served the way jsdelivr serves it: real files
// only, under the same kind of path, with html shown as plain text.
//   node svg/tools/build.js --api http://localhost:8787
//   node svg/tools/gateway.js   (with ORIGINS=http://127.0.0.1:8092)
//   node svg/tools/serve.js     then open http://127.0.0.1:8092/
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "site");
const port = Number(process.env.PORT) || 8092;
const PREFIX = "/gh/yaanscoat/blackwaves@main/svg/site/";
const TYPES = {
  ".svg": "image/svg+xml",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".html": "text/plain; charset=utf-8",
};
const HEADERS = { "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "cross-origin" };

http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/") {
      res.writeHead(302, { Location: `${PREFIX}index.svg` });
      return res.end();
    }
    const file = path.resolve(site, `.${pathname.slice(PREFIX.length - 1)}`);
    if (!pathname.startsWith(PREFIX) || !file.startsWith(site + path.sep)) {
      res.writeHead(404, HEADERS);
      return res.end("not found");
    }
    fs.readFile(file, (error, body) => {
      if (error) {
        res.writeHead(404, HEADERS);
        return res.end("not found");
      }
      res.writeHead(200, { ...HEADERS, "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`svg build on http://127.0.0.1:${port}/`));
