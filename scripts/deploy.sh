#!/usr/bin/env bash
#
# Ship a build to the server.
#
# The box runs five other projects on 7.6 GiB of RAM, so nothing is compiled
# there: this builds locally and sends only the output — a few hundred KB —
# then restarts the service and checks that the site actually came back,
# including the WebSocket upgrade, which is the part a proxy misconfiguration
# breaks while everything else keeps returning 200.
#
#   scripts/deploy.sh                      # build, ship, restart, verify
#   scripts/deploy.sh --skip-build         # ship what is already in dist/
#
set -euo pipefail

HOST=${WALLRUSH_HOST:-root@5.223.92.226}
KEY=${WALLRUSH_SSH_KEY:-$HOME/.ssh/hetzner_key}
REMOTE=${WALLRUSH_REMOTE_DIR:-/opt/wallrush}
DOMAIN=${WALLRUSH_DOMAIN:-wallrush.duckdns.org}
SSH=(ssh -i "$KEY" -o ConnectTimeout=25 -o ServerAliveInterval=10)

# The link to this box drops often enough that a single timeout is not news.
# Every remote step is idempotent, so retrying is safe.
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    [ "$n" -ge 6 ] && { echo "   giving up after $n attempts: $*" >&2; return 1; }
    echo "   retry $n…"
    sleep 15
  done
}

# `retry ssh … <<HEREDOC` looks right and is not: the first attempt consumes
# stdin, so every retry runs an empty script. Remote steps go through a file.
run_remote() {
  local script=$1
  retry bash -c '"$@" < "$0"' "$script" "${SSH[@]}" "$HOST" bash -s
}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$here"

if [[ ${1:-} != --skip-build ]]; then
  echo "→ building"
  npm run build >/dev/null
fi

echo "→ packing"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
for pkg in shared server client; do
  mkdir -p "$stage/packages/$pkg"
  cp "packages/$pkg/package.json" "$stage/packages/$pkg/"
  cp -r "packages/$pkg/dist" "$stage/packages/$pkg/dist"
done
cp package.json package-lock.json "$stage/"
# Tests are not part of a deployment.
rm -rf "$stage/packages/server/dist/test"
tar czf "$stage/bundle.tgz" -C "$stage" package.json package-lock.json packages
du -h "$stage/bundle.tgz" | cut -f1 | sed 's/^/   bundle /'

echo "→ shipping"
retry scp -i "$KEY" -o ConnectTimeout=25 "$stage/bundle.tgz" "$HOST:/tmp/wallrush-bundle.tgz" >/dev/null

echo "→ installing and restarting"
cat > "$stage/install.sh" <<REMOTE_SCRIPT
set -euo pipefail
tar xzf /tmp/wallrush-bundle.tgz -C "$REMOTE"
rm -f /tmp/wallrush-bundle.tgz
cd "$REMOTE"
# The distro node is too old for node:sqlite; the pinned one lives here.
PATH=/opt/node22/bin:\$PATH npm install --omit=dev --no-audit --no-fund >/dev/null
chown -R wallrush:wallrush "$REMOTE"
systemctl restart wallrush
REMOTE_SCRIPT
run_remote "$stage/install.sh"

echo "→ verifying"
cat > "$stage/verify.sh" <<REMOTE_SCRIPT
set -uo pipefail
for i in \$(seq 1 20); do
  code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8787/api/health || true)
  [ "\$code" = "200" ] && break
  sleep 1
done
echo "   health          \$code"
echo "   https           \$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/)"
# A proxy that has lost the WebSocket rule still serves every page perfectly.
/opt/node22/bin/node -e '
const https = require("https"), crypto = require("crypto");
const req = https.request({
  host: "127.0.0.1", port: 443, path: "/ws", servername: "$DOMAIN",
  rejectUnauthorized: false,
  headers: { Host: "$DOMAIN", Connection: "Upgrade", Upgrade: "websocket",
             "Sec-WebSocket-Version": "13",
             "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64") },
});
req.on("upgrade", (res, socket) => {
  socket.once("data", (d) => { console.log("   websocket      " + res.statusCode + ", first frame " + d.length + " bytes"); process.exit(0); });
  setTimeout(() => { console.log("   websocket      upgraded but silent"); process.exit(1); }, 5000);
});
req.on("response", (r) => { console.log("   websocket      NOT upgraded (" + r.statusCode + ")"); process.exit(1); });
req.on("error", (e) => { console.log("   websocket      error " + e.message); process.exit(1); });
req.end();'
REMOTE_SCRIPT
run_remote "$stage/verify.sh"

echo "✓ https://$DOMAIN"
