// copied to site/bare/transport.mjs. two ways of using a bare server:
//  - the default export is a plain transport: each request goes through bare
//  - tunnelWisp() carries the wisp connection that epoxy and libcurl open over
//    bare's websocket relay, so they only ever talk to the bare server
import BareClient from "./client.mjs";

const NativeWebSocket = window.WebSocket;
const server = () => new URL(window.__BW_BARE__);

function toObject(headers) {
  const out = {};
  for (const [name, value] of headers || []) {
    if (name in out) out[name] = [].concat(out[name], value);
    else out[name] = value;
  }
  return out;
}

function toEntries(headers) {
  const out = [];
  for (const [name, value] of Object.entries(headers || {})) {
    for (const single of [].concat(value)) out.push([name, single]);
  }
  return out;
}

export default class BareTransport {
  constructor() {
    this.client = new BareClient(server());
  }
  get ready() {
    return this.client.ready;
  }
  init() {
    return this.client.init();
  }
  meta() {}
  async request(remote, method, body, headers, signal) {
    const response = await this.client.request(remote, method, body, toObject(headers), signal);
    return { ...response, headers: toEntries(response.headers) };
  }
  connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
    return this.client.connect(url, protocols, toObject(headers), (protocol) => onopen(protocol, ""), onmessage, onclose, onerror);
  }
}

// bare's websocket protocol: connect to <server>/v3/, send one text frame saying
// where to go, get one text frame back, and from then on frames pass straight through
class BareWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  protocol = "";
  extensions = "";
  readyState = 0;

  constructor(url, protocols) {
    super();
    this.url = String(url);
    const remote = new URL(this.url);
    const relay = new URL("v3/", server());
    relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
    const socket = new NativeWebSocket(relay);
    // arraybuffers arrive in order. blobs need an async read, which would scramble wisp frames
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener(
      "open",
      () => {
        socket.send(
          JSON.stringify({
            type: "connect",
            remote: remote.href,
            protocols: [].concat(protocols || []),
            headers: { Host: remote.host, Upgrade: "websocket", Connection: "Upgrade" },
            forwardHeaders: [],
          }),
        );
      },
      { once: true },
    );
    let opened = false;
    socket.addEventListener("message", (event) => {
      if (!opened) {
        opened = true;
        this.protocol = JSON.parse(event.data).protocol || "";
        this.readyState = 1;
        this.fire(new Event("open"));
        return;
      }
      this.fire(new MessageEvent("message", { data: event.data }));
    });
    socket.addEventListener("error", () => this.fire(new Event("error")));
    socket.addEventListener("close", (event) => {
      this.readyState = 3;
      this.fire(new CloseEvent("close", { code: event.code, reason: event.reason, wasClean: event.wasClean }));
    });
  }
  fire(event) {
    this.dispatchEvent(event);
    this[`on${event.type}`]?.(event);
  }
  get binaryType() {
    return "arraybuffer";
  }
  set binaryType(_) {}
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }
  send(data) {
    this.socket.send(data);
  }
  close(code, reason) {
    this.readyState = 2;
    this.socket.close(code, reason);
  }
}

let tunnelled = null;

/** from now on, a websocket to `wispUrl` goes through bare. null turns that off */
export function tunnelWisp(wispUrl) {
  tunnelled = wispUrl;
}

window.WebSocket = new Proxy(NativeWebSocket, {
  construct(target, args, newTarget) {
    if (tunnelled && String(args[0]) === tunnelled) return new BareWebSocket(...args);
    return Reflect.construct(target, args, newTarget === window.WebSocket ? target : newTarget);
  },
});
