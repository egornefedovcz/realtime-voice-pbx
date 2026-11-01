#!/usr/bin/env bash
# Renders the *.template files with values from .env into /etc/asterisk.
#   sudo ./render-config.sh /path/to/.env [/etc/asterisk]
set -euo pipefail
ENV_FILE="${1:-.env}"
DEST="${2:-/etc/asterisk}"
HERE="$(cd "$(dirname "$0")" && pwd)"
set -a; . "$ENV_FILE"; set +a
: "${SIP_TRANSPORT:=transport-udp}"; export SIP_TRANSPORT
render() { # template -> destination
  envsubst < "$1" > "$2"
  chmod 640 "$2"; chown root:asterisk "$2" 2>/dev/null || true
  echo "rendered $2"
}
[ -n "${ARI_PASSWORD:-}" ] && render "$HERE/ari.conf.template" "$DEST/ari.conf"
[ -n "${SIP_USER:-}" ] && [ -n "${SIP_PASSWORD:-}" ] && render "$HERE/pjsip.trunk.conf.template" "$DEST/pjsip.trunk.conf"
[ -n "${STAFF_201_PASSWORD:-}" ] && render "$HERE/pjsip.staff.conf.template" "$DEST/pjsip.staff.conf"
echo "Add '#include pjsip.trunk.conf' (and pjsip.staff.conf) to pjsip.conf, then: asterisk -rx 'core reload'"
