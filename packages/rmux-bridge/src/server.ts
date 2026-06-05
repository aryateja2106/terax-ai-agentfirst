import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

type WsData = { session: string; pane?: string };

// What to attach/stream/send to: a specific pane id (e.g. "%2") if given,
// else the whole session. tmux/rmux accept a pane id directly as a -t target.
function wsTarget(data: WsData): string {
  return data.pane && data.pane.length > 0 ? data.pane : data.session;
}

type InputMessage = { type: "input"; data: string };
type ResizeMessage = { type: "resize"; cols: number; rows: number };
type SplitMessage = { type: "split"; dir: "h" | "v" };
type NewPaneMessage = { type: "new-pane" };
type ClientMessage = InputMessage | ResizeMessage | SplitMessage | NewPaneMessage;

type SessionRuntime = {
  clients: Set<ServerWebSocket<WsData>>;
  listener: ReturnType<typeof Bun.listen> | null;
  socketPath: string | null;
  ensuring: Promise<void> | null;
  tearingDown: Promise<void> | null;
};

const port = Number.parseInt(process.env.PORT ?? "7820", 10);
// Bind the tailnet by default (parity with meshd). The tailnet (WireGuard) is the
// trust boundary; override with BRIDGE_HOST=127.0.0.1 to restrict to localhost.
const host = process.env.BRIDGE_HOST ?? "0.0.0.0";
// Self-contained: xterm assets are vendored under public/vendor so the bridge
// runs anywhere with just bun (no repo node_modules needed).
const indexFile = Bun.file(new URL("../public/index.html", import.meta.url));
const xtermCssFile = Bun.file(new URL("../public/vendor/xterm.css", import.meta.url));
const xtermJsFile = Bun.file(new URL("../public/vendor/xterm.js", import.meta.url));
const fitAddonFile = Bun.file(new URL("../public/vendor/addon-fit.js", import.meta.url));
const sessions = new Map<string, SessionRuntime>();
const textDecoder = new TextDecoder();

function getRuntime(session: string): SessionRuntime {
  const existing = sessions.get(session);
  if (existing) {
    return existing;
  }
  const created: SessionRuntime = {
    clients: new Set(),
    listener: null,
    socketPath: null,
    ensuring: null,
    tearingDown: null,
  };
  sessions.set(session, created);
  return created;
}

// Multiplexer binary: rmux on macOS, tmux on Linux (rmux is a tmux-compatible fork,
// so every command below is identical). Override with MUX=<binary>.
const MUX = process.env.MUX ?? (process.platform === "linux" ? "tmux" : "rmux");

async function runRmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([MUX, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    console.error(`[rmux] ${args.join(" ")} failed: ${stderr.trim() || "(no stderr)"}`);
  }
  return { code, stdout, stderr };
}

function sanitizeSession(session: string): string {
  const sanitized = session.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized || "session";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeWsText(message: string | ArrayBuffer | Uint8Array): string | null {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return textDecoder.decode(new Uint8Array(message));
  }
  if (message instanceof Uint8Array) {
    return textDecoder.decode(message);
  }
  return null;
}

function parseClientMessage(message: string | ArrayBuffer | Uint8Array): ClientMessage | null {
  const text = decodeWsText(message);
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }
  if (parsed.type === "input" && typeof parsed.data === "string") {
    return { type: "input", data: parsed.data };
  }
  if (
    parsed.type === "resize" &&
    typeof parsed.cols === "number" &&
    Number.isFinite(parsed.cols) &&
    typeof parsed.rows === "number" &&
    Number.isFinite(parsed.rows)
  ) {
    return {
      type: "resize",
      cols: Math.max(1, Math.floor(parsed.cols)),
      rows: Math.max(1, Math.floor(parsed.rows)),
    };
  }
  if (parsed.type === "split" && (parsed.dir === "h" || parsed.dir === "v")) {
    return { type: "split", dir: parsed.dir };
  }
  if (parsed.type === "new-pane") {
    return { type: "new-pane" };
  }
  return null;
}

// rmux/tmux `send-keys -H` expects each hex byte as its own argv element,
// not a single space-joined string. Return the bytes so the caller can spread them.
function toHexBytes(input: string): string[] {
  const bytes = new TextEncoder().encode(input);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
}

let server: ReturnType<typeof Bun.serve<WsData>>;

// Pane output and WS traffic stay unbounded on purpose to preserve terminal semantics.
function fanout(session: string, data: Uint8Array): void {
  server.publish(session, data);
}

async function ensureSession(session: string): Promise<void> {
  const runtime = getRuntime(session);
  if (runtime.listener) {
    return;
  }
  if (runtime.ensuring) {
    await runtime.ensuring;
    return;
  }
  runtime.ensuring = (async () => {
    const socketPath = join(tmpdir(), `rmux-bridge-${sanitizeSession(session)}-${process.pid}.sock`);
    await unlinkIfPresent(socketPath);
    const listener = Bun.listen({
      unix: socketPath,
      socket: {
        data(_socket, buffer) {
          fanout(session, buffer);
        },
      },
    });
    runtime.listener = listener;
    runtime.socketPath = socketPath;
    const command = `nc -U ${shellQuote(socketPath)}`;
    const piped = await runRmux(["pipe-pane", "-O", "-t", session, command]);
    if (piped.code !== 0) {
      listener.stop(true);
      runtime.listener = null;
      runtime.socketPath = null;
      await unlinkIfPresent(socketPath);
      throw new Error(`failed to attach pane pipe for ${session}`);
    }
  })();
  try {
    await runtime.ensuring;
  } finally {
    runtime.ensuring = null;
  }
}

async function teardownSession(session: string): Promise<void> {
  const runtime = sessions.get(session);
  if (!runtime) {
    return;
  }
  if (runtime.clients.size > 0) {
    return;
  }
  if (runtime.tearingDown) {
    await runtime.tearingDown;
    return;
  }
  runtime.tearingDown = (async () => {
    await runRmux(["pipe-pane", "-t", session]);
    runtime.listener?.stop(true);
    runtime.listener = null;
    if (runtime.socketPath) {
      await unlinkIfPresent(runtime.socketPath);
      runtime.socketPath = null;
    }
    if (runtime.clients.size === 0) {
      sessions.delete(session);
    }
  })();
  try {
    await runtime.tearingDown;
  } finally {
    runtime.tearingDown = null;
  }
}

async function handleOpen(ws: ServerWebSocket<WsData>): Promise<void> {
  const session = ws.data.session;
  const target = wsTarget(ws.data);
  const exists = await runRmux(["has-session", "-t", session]);
  if (exists.code !== 0) {
    ws.close(1008, "no such session");
    return;
  }
  const snapshot = await runRmux(["capture-pane", "-p", "-e", "-t", target]);
  if (snapshot.code !== 0) {
    ws.close(1011, "snapshot failed");
    return;
  }
  ws.send(snapshot.stdout);
  try {
    await ensureSession(target);
  } catch (error) {
    console.error(error);
    ws.close(1011, "attach failed");
    return;
  }
  ws.subscribe(target);
  getRuntime(target).clients.add(ws);
}

async function handleMessage(
  ws: ServerWebSocket<WsData>,
  message: string | ArrayBuffer | Uint8Array,
): Promise<void> {
  const parsed = parseClientMessage(message);
  if (!parsed) {
    return;
  }
  const session = ws.data.session;
  const target = wsTarget(ws.data);
  if (parsed.type === "input") {
    const hexBytes = toHexBytes(parsed.data);
    if (hexBytes.length === 0) {
      return;
    }
    await runRmux(["send-keys", "-t", target, "-H", "--", ...hexBytes]);
    return;
  }
  if (parsed.type === "resize") {
    // Resize the window (panes share the window geometry).
    await runRmux(["resize-window", "-t", session, "-x", String(parsed.cols), "-y", String(parsed.rows)]);
    return;
  }
  if (parsed.type === "split") {
    const flag = parsed.dir === "h" ? "-h" : "-v";
    await runRmux(["split-window", flag, "-t", target]);
    return;
  }
  await runRmux(["split-window", "-t", target]);
}

function serveStatic(file: Bun.BunFile, contentType: string): Response {
  return new Response(file, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}

server = Bun.serve<WsData>({
  port,
  hostname: host,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/") {
      return serveStatic(indexFile, "text/html; charset=utf-8");
    }
    if (url.pathname === "/xterm/xterm.css") {
      return serveStatic(xtermCssFile, "text/css; charset=utf-8");
    }
    if (url.pathname === "/xterm/xterm.js") {
      return serveStatic(xtermJsFile, "application/javascript; charset=utf-8");
    }
    if (url.pathname === "/xterm/addon-fit.js") {
      return serveStatic(fitAddonFile, "application/javascript; charset=utf-8");
    }
    if (url.pathname === "/attach") {
      const session = url.searchParams.get("session") || "spine-test";
      const pane = url.searchParams.get("pane") || undefined;
      const upgraded = server.upgrade(req, {
        data: { session, pane },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      void handleOpen(ws);
    },
    message(ws, message) {
      void handleMessage(ws, message);
    },
    close(ws) {
      const target = wsTarget(ws.data);
      ws.unsubscribe(target);
      const runtime = sessions.get(target);
      if (!runtime) {
        return;
      }
      runtime.clients.delete(ws);
      if (runtime.clients.size === 0) {
        void teardownSession(target);
      }
    },
  },
});

console.log(
  `rmux-bridge listening at http://${host}:${port}/  (attach: ws://${host}:${port}/attach?session=spine-test)`,
);
