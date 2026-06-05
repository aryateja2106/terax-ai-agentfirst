#!/usr/bin/env bash
set -euo pipefail

PORT=${1:-${PORT:-7820}}

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale is required; install it first: https://tailscale.com/download" >&2
  exit 1
fi

tailscale serve --bg "$PORT"

dnsname="$(
  tailscale status --json | bun -e 'const input = await new Response(Bun.stdin.stream()).text(); const data = JSON.parse(input); process.stdout.write(String(data?.Self?.DNSName ?? "").replace(/\.$/, ""));'
)"

if [[ -n "$dnsname" ]]; then
  echo "Mesh URL: https://$dnsname"
else
  echo "Mesh URL: unavailable (tailscale DNS name missing)"
fi

tailscale serve status
