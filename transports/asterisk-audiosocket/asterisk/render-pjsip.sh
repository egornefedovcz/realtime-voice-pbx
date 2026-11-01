#!/usr/bin/env bash
# Renders the SIP trunk from .env and reloads PJSIP.
#   sudo ./render-pjsip.sh /path/to/.env
set -euo pipefail
ENV_FILE="${1:-.env}"
HERE="$(cd "$(dirname "$0")" && pwd)"
set -a; . "$ENV_FILE"; set +a
[ -n "${SIP_USER:-}" ] && [ -n "${SIP_PASSWORD:-}" ] || { echo "SIP_USER / SIP_PASSWORD missing in $ENV_FILE"; exit 1; }
: "${SIP_TRANSPORT:=transport-udp}"; export SIP_TRANSPORT
envsubst '${SIP_SERVER} ${SIP_USER} ${SIP_PASSWORD} ${SIP_TRANSPORT} ${SIP_PROVIDER_CIDR}' \
  < "$HERE/pjsip.trunk.conf.template" > /etc/asterisk/pjsip.trunk.conf
chmod 640 /etc/asterisk/pjsip.trunk.conf; chown root:asterisk /etc/asterisk/pjsip.trunk.conf 2>/dev/null || true
asterisk -rx "module reload res_pjsip.so" >/dev/null
sleep 4
asterisk -rx "pjsip show registrations"
