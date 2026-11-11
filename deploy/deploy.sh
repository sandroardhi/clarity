#!/usr/bin/env bash
# Builds clarity-server off the box and ships it as /opt/clarity/releases/<sha>.
# Usage:
#   deploy/deploy.sh release      build HEAD, ship, switch, restart, health check (rolls back on failure)
#   deploy/deploy.sh rollback     switch back to the previous release
#   deploy/deploy.sh list         show releases and the current one
# Env: CLARITY_HOST (root@45.32.108.126), CLARITY_SSH_KEY (~/.ssh/heatmap)
set -euo pipefail

HOST="${CLARITY_HOST:-root@45.32.108.126}"
KEY="${CLARITY_SSH_KEY:-$HOME/.ssh/heatmap}"
BASE=/opt/clarity
KEEP=5
STAGE=""
SSH=(ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" "$HOST")

# Runs on the box as root: switch the current link, install the release's unit, restart, check health.
# Args: target release dir name. Exits 1 when the new release is unhealthy.
REMOTE_SWITCH='
set -euo pipefail
base=/opt/clarity; target="$1"
[ -d "$base/releases/$target" ] || { echo "no release $target" >&2; exit 1; }
# First cutover: the old checkout in app/ becomes the "legacy" release to roll back to
if [ ! -L "$base/current" ] && [ -d "$base/app" ]; then
  ln -sfn ../app "$base/releases/legacy" && ln -sfn releases/legacy "$base/current"
fi
old=$(readlink "$base/current" 2>/dev/null | xargs -r basename || true)
ln -sfn "releases/$target" "$base/current.new" && mv -T "$base/current.new" "$base/current"
if [ -n "$old" ] && [ "$old" != "$target" ]; then echo "$old" > "$base/previous"; fi
unit="$base/releases/$target/deploy/systemd/clarity-server.service"
if [ -f "$unit" ] && ! cmp -s "$unit" /etc/systemd/system/clarity-server.service; then
  install -m 644 "$unit" /etc/systemd/system/clarity-server.service
  systemctl daemon-reload
fi
systemctl restart clarity-server
port=$(sed -n "s/^PORT=//p" /etc/clarity-server.env | tail -1); port="${port:-3000}"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo "healthy: $target"; exit 0
  fi
  sleep 1
done
echo "unhealthy after 30s: $target" >&2
journalctl -u clarity-server -n 20 --no-pager >&2 || true
exit 1
'

remote_switch() {
  "${SSH[@]}" bash -s -- "$1" <<<"$REMOTE_SWITCH"
}

build() {
  local sha="$1" stage="$2"
  mkdir -p "$stage/src" "$stage/release"
  git archive "${REF:-HEAD}" | tar -x -C "$stage/src"
  (cd "$stage/src" && yarn install --frozen-lockfile --silent \
    && yarn build:js && yarn build:decode && yarn build:visualize && yarn build:server)

  local out="$stage/release"
  cp "$stage/src/package.json" "$stage/src/yarn.lock" "$out/"
  for pkg in clarity-js clarity-decode clarity-visualize clarity-devtools clarity-server; do
    mkdir -p "$out/packages/$pkg"
    cp "$stage/src/packages/$pkg/package.json" "$out/packages/$pkg/"
  done
  cp -r "$stage/src/packages/clarity-js/build" "$out/packages/clarity-js/"
  cp -r "$stage/src/packages/clarity-decode/build" "$out/packages/clarity-decode/"
  cp -r "$stage/src/packages/clarity-visualize/build" "$out/packages/clarity-visualize/"
  cp -r "$stage/src/packages/clarity-server/dist" "$out/packages/clarity-server/"
  mkdir -p "$out/deploy/systemd"
  cp "$stage/src/deploy/systemd/clarity-server.service" "$out/deploy/systemd/"
  (cd "$out" && yarn install --production --frozen-lockfile --ignore-scripts --silent)
  echo "$sha" > "$out/REVISION"
}

release() {
  local sha
  sha=$(git rev-parse --short=12 HEAD)
  if ! git diff --quiet HEAD; then echo "note: uncommitted changes are not shipped; building $sha" >&2; fi
  STAGE=$(mktemp -d)
  trap 'if [ -n "$STAGE" ]; then rm -r "$STAGE"; fi' EXIT
  build "$sha" "$STAGE"

  "${SSH[@]}" "install -d -o root -g clarity -m 750 $BASE/releases"
  rsync -a --delete --chown=root:clarity --chmod=D750,F640 \
    -e "ssh -o BatchMode=yes -o IdentitiesOnly=yes -i $KEY" "$STAGE/release/" "$HOST:$BASE/releases/$sha/"

  if ! remote_switch "$sha"; then
    echo "release $sha failed; rolling back" >&2
    rollback
    exit 1
  fi
  prune
}

rollback() {
  local prev
  prev=$("${SSH[@]}" "cat $BASE/previous 2>/dev/null" || true)
  [ -n "$prev" ] || { echo "no previous release recorded" >&2; exit 1; }
  remote_switch "$prev"
}

# Keeps the newest $KEEP releases plus current and previous
prune() {
  "${SSH[@]}" bash -s -- "$KEEP" <<'EOF'
set -euo pipefail
cd /opt/clarity/releases
cur=$(readlink ../current | xargs basename); prev=$(cat ../previous 2>/dev/null || true)
ls -1t | tail -n +"$(( $1 + 1 ))" | while read -r r; do
  [ "$r" = "$cur" ] || [ "$r" = "$prev" ] || rm -r -- "$r"
done
EOF
}

list() {
  "${SSH[@]}" "cd $BASE && ls -1t releases && echo current: \$(readlink current) && echo previous: \$(cat previous 2>/dev/null)"
}

case "${1:-}" in
  release) release ;;
  rollback) rollback ;;
  list) list ;;
  *) sed -n 3,7p "$0" >&2; exit 2 ;;
esac
