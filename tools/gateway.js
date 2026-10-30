// lets a page on a cdn talk to a normal blackwaves server, which only expects
// its own origin. it sits in front of the server and adds cors headers, and it
// removes the sign-in cookie both ways so a cdn page never acts as an account.
// it also hosts a bare server at /bare/ for the bare transports.
//   TARGET=http://localhost:8080 ORIGINS=https://cdn.jsdelivr.net PORT=8787 node svg/tools/gateway.js
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import { createBareServer } from "@tomphttp/bare-server-node";
import ipaddr from "ipaddr.js";

const target = new URL(process.env.TARGET || "http://localhost:8080");
const port = Number(process.env.PORT) || 8787;
const origins = (process.env.ORIGINS || "https://cdn.jsdelivr.net").split(",").map((origin) => origin.trim()).filter(Boolean);
const SESSION = "bw_session";
// reusing connections to the server saves a round trip on every request
const agent = new http.Agent({ keepAlive: true });

const withoutSession = (cookie) => cookie?.split(/;\s*/).filter((part) => !part.startsWith(`${SESSION}=`)).join("; ") || undefined;

function forwardedHeaders(req) {
  const headers = { ...req.headers, host: target.host };
  const cookie = withoutSession(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
  return headers;
}

const publicIp = (address) => ipaddr.parse(address).range() === "unicast";

// bare refuses private addresses, and that has to stay. but its tunnel for epoxy
// and libcurl has to reach our own /wisp/, which is private when testing on one
// machine. BARE_SELF=localhost:8787 allows that one host and port, nothing else.
const self = process.env.BARE_SELF ? new URL(`http://${process.env.BARE_SELF}`) : null;
const selfRules = self && {
  filterRemote(url) {
    if (url.host === self.host) return;
    if (url.hostname === self.hostname || (ipaddr.isValid(url.hostname) && !publicIp(url.hostname))) throw new RangeError("Forbidden IP");
  },
  lookup(hostname, options, callback) {
    dns.lookup(hostname, options, (error, address, family) => {
      const list = typeof address === "string" ? [{ address }] : address || [];
      if (hostname !== self.hostname && list.some((entry) => !publicIp(entry.address))) return callback(new RangeError("Forbidden IP"), "", -1);
      callback(error, address, family);
    });
  },
};

const bare = createBareServer("/bare/", {
  ...selfRules,
  // the stock limit of 10 per ip would stall a page with a few dozen files
  connectionLimiter: { maxConnectionsPerIP: 2000, windowDuration: 60, blockDuration: 30 },
});

const server = http.createServer((req, res) => {
  const allowed = origins.includes(req.headers.origin);
  if (bare.shouldRoute(req)) {
    // only our own pages get to relay through this server
    if (allowed) return bare.routeRequest(req, res);
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("not allowed");
  }
  const cors = allowed ? { "access-control-allow-origin": req.headers.origin, "access-control-expose-headers": "*", vary: "Origin" } : { vary: "Origin" };
  if (req.method === "OPTIONS" && allowed) {
    res.writeHead(204, {
      ...cors,
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
      "access-control-allow-headers": req.headers["access-control-request-headers"] || "content-type",
      "access-control-max-age": "86400",
    });
    return res.end();
  }
  const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: forwardedHeaders(req), agent }, (answer) => {
    // lowercase on purpose: the game proxy sends its own, and two of them is a cors error
    const headers = { ...answer.headers, ...cors };
    if (headers["set-cookie"]) headers["set-cookie"] = headers["set-cookie"].filter((cookie) => !cookie.startsWith(`${SESSION}=`));
    res.writeHead(answer.statusCode, headers);
    answer.pipe(res);
  });
  upstream.on("error", (error) => {
    console.error(`${req.method} ${req.url}: ${error.message}`);
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "can't reach the blackwaves server" }));
  });
  res.on("close", () => !res.writableEnded && upstream.destroy());
  req.pipe(upstream);
});

// websockets (wisp and the online counter) are passed straight through
server.on("upgrade", (req, socket, head) => {
  if (bare.shouldRoute(req)) {
    if (origins.includes(req.headers.origin)) return bare.routeUpgrade(req, socket, head);
    return socket.destroy();
  }
  const upstream = net.connect(Number(target.port) || 80, target.hostname, () => {
    // the proxy browser's traffic all runs through here, so don't hold back small packets
    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    const lines = Object.entries(forwardedHeaders(req)).map(([name, value]) => `${name}: ${value}`);
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const end = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", end);
  socket.on("error", end);
});

server.listen(port, () => console.log(`gateway on :${port} -> ${target.href}, allowing ${origins.join(", ")}`));
