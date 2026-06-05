# rmux bridge

Run the bridge from the repo root with `bun run packages/rmux-bridge/src/server.ts`, or from the package with `cd packages/rmux-bridge && bun run dev`.

This package intentionally has no local `dependencies` block. It reuses the repo-root `@xterm/xterm` and `@xterm/addon-fit` installs from `../../node_modules`.

The bridge requires an `nc` implementation with Unix-socket support. macOS BSD `nc` already supports `-U`. On Linux, use `nmap-ncat`'s `ncat -U` or replace the pipe command with a `socat - UNIX-CONNECT:` equivalent if that is what your system provides. No `socat` is needed on macOS.

Verification:

```bash
bun run packages/rmux-bridge/src/server.ts
curl http://127.0.0.1:7820/
PORT=7820 SESSION=spine-test bun run packages/rmux-bridge/scripts/e2e-check.ts
```

Tailnet serving:

```bash
cd packages/rmux-bridge
bun run serve
tailscale serve status
```
