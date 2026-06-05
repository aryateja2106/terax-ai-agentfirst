# rmux-bridge — realtime terminal stream for mobile/watch

> Spine of LeCoder mobile/watch multi-agent multiplexing. Bridges a persistent **rmux** session to a browser xterm client over WebSocket, exposable to phone/tablet/watch via `tailscale serve`. The realtime multi-device stream MConnect lacked.

## Why this seam
Terax's xterm frontend (`src/modules/terminal/lib/pty-bridge.ts`) talks to an abstract interface: `pty_open / pty_write / pty_resize / pty_close`. Today the backend is local `portable-pty` (`src-tauri/src/modules/pty/session.rs`). We add a SECOND backend — rmux — so the SAME named session is reachable from desktop Tauri AND a remote web client. Frontend stays untouched.

## rmux interfaces (verified on rmux 0.3.x, tmux-compatible)
- **Output stream (no tty):** `rmux pipe-pane -O -t <session> '<shell-cmd>'` — pane output is piped to the shell-cmd's stdin. Point it at a unix socket our server listens on (e.g. via `socat - UNIX-CONNECT:/tmp/rmux-bridge.sock`).
- **Input:** `rmux send-keys -t <session> -- <keys>` (and `-H` for hex/raw bytes).
- **Snapshot on attach:** `rmux capture-pane -p -e -t <session>` (with escapes) to seed scrollback.
- **Resize:** `rmux resize-window -t <session> -x <cols> -y <rows>` / `resize-pane`.
- **Lifecycle:** `has-session`, `new-session -d -s <name>`, `list-sessions`, `kill-session`.
- Control mode (`-CC attach`) needs a tty (os error 19 from a non-tty) — AVOID; use the pipe-pane/send-keys path above which is tty-free and server-friendly.

## Deliverable (v0 spike)
1. **bun WS server** (`packages/rmux-bridge/src/server.ts`):
   - `GET /` → serves the mobile xterm page.
   - `WS /attach?session=<name>` → on connect: `capture-pane` snapshot, then start `pipe-pane -O` into a per-connection unix socket; forward pane bytes → WS. On WS message: route `{type:"input",data}` → `send-keys -H`; `{type:"resize",cols,rows}` → resize; `{type:"split",dir}` → `split-window -h|-v`; `{type:"new-pane"}`.
   - Multiple WS clients on the same session all receive the same stream (multi-device).
2. **Mobile xterm page** (`packages/rmux-bridge/public/index.html`): `@xterm/xterm` + fit addon, touch scroll/select/copy-paste, and a Paseo-style key-bar row: `Ctrl Shift Alt Esc Tab ↑ ↓ ← →`, plus buttons: **+ pane**, **split ⬍ (h)**, **split ⬌ (v)**. Responsive; usable down to watch width.
3. **`tailscale serve` helper** (`packages/rmux-bridge/scripts/serve.sh`): `tailscale serve --bg <port>` and print the mesh URL.
4. **Drag-drop files** (stretch in v0, required v1): dropped file → copy into the session's cwd → emit the path back as a toast, so agents can read it without guardrail friction.

## Constraints
- bun + TypeScript only (no npm/node-pty). Reuse `@xterm/*` already in Terax's deps.
- No new heavyweight deps; `socat` is acceptable (document if required) or use a bun-native unix socket listener with `pipe-pane -o` to a fifo.
- Localhost-bind by default; tailscale-serve is the only exposure path. Auth token on the WS query for v1.

## Verification (must pass)
- `bun run packages/rmux-bridge/src/server.ts` starts, binds a port, logs the URL.
- `curl -s localhost:<port>/ | grep -qi xterm` → page served.
- Open the page in a browser: typing appears in the rmux `spine-test` session (confirm via `rmux capture-pane -p -t spine-test`), and output from the session renders live in the browser.
- A second browser tab on the same session sees the same live stream.

## Out of scope (v0)
Auth hardening, the Tauri-side rmux backend swap (separate follow-up), watch-native app, voice/nl2shell input (separate module). v0 proves the realtime mesh stream end-to-end.
