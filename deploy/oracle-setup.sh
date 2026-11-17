#!/usr/bin/env bash
# Provision a Veil node on an Oracle Cloud "Always Free" ARM instance.
#
#   Shape:  VM.Standard.A1.Flex — 4 OCPU / 24 GB RAM (the whole free ARM quota)
#   Egress: 10 TB/month included, which is the only reason this is free
#   Image:  Ubuntu 24.04 (aarch64)
#
# NOT RUN OR TESTED BY THE AUTHOR OF THIS REPO — it cannot be, without an
# Oracle account. Read it before running it. Run it as root on a fresh host.
#
# Two things catch everyone out:
#   1. Oracle's *cloud* firewall (the VCN security list / NSG) is separate from
#      the host firewall. You must open the ports in BOTH, in the web console.
#   2. Oracle reclaims idle Always Free instances. Keep it in use, and keep
#      this repo reproducible so a reclaim costs you an afternoon.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. talk.example.com}"
SFU_DOMAIN="${SFU_DOMAIN:?set SFU_DOMAIN, e.g. sfu.example.com}"
LIVEKIT_VERSION="${LIVEKIT_VERSION:-1.9.3}"

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates ufw jq

echo "==> node 22 (for the token service)"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

echo "==> caddy (TLS + static files + reverse proxy)"
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

echo "==> livekit-server ${LIVEKIT_VERSION}"
# Verify the checksum against the release page before trusting the binary.
tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/livekit.tgz" \
  "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_arm64.tar.gz"
tar -xzf "$tmp/livekit.tgz" -C "$tmp"
install -m 0755 "$tmp/livekit-server" /usr/local/bin/livekit-server
rm -rf "$tmp"

echo "==> keys"
mkdir -p /etc/veil
if [ ! -f /etc/veil/livekit.env ]; then
  API_KEY="$(head -c 12 /dev/urandom | base64 | tr -d '/+=' )"
  API_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' )"
  cat > /etc/veil/livekit.env <<ENV
LIVEKIT_API_KEY=${API_KEY}
LIVEKIT_API_SECRET=${API_SECRET}
LIVEKIT_HOST_URL=http://127.0.0.1:7880
PUBLIC_WS_URL=wss://${SFU_DOMAIN}
MAX_PARTICIPANTS=6
ALLOWED_ORIGINS=https://${DOMAIN}
ENV
  chmod 0600 /etc/veil/livekit.env
  echo "    generated new API key/secret in /etc/veil/livekit.env"
fi
# shellcheck disable=SC1091
. /etc/veil/livekit.env

echo "==> livekit config"
install -d /etc/livekit
sed -e "s|turn.example.com|${SFU_DOMAIN}|" \
    -e "s|\${LIVEKIT_API_KEY}|${LIVEKIT_API_KEY}|" \
    -e "s|\${LIVEKIT_API_SECRET}|${LIVEKIT_API_SECRET}|" \
    "$(dirname "$0")/livekit.prod.yaml" > /etc/livekit/livekit.yaml
chmod 0600 /etc/livekit/livekit.yaml

echo "==> systemd units"
cat > /etc/systemd/system/livekit.service <<'UNIT'
[Unit]
Description=LiveKit SFU
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit/livekit.yaml
Restart=on-failure
RestartSec=3
LimitNOFILE=65535
# No state on disk: nothing to protect, nothing to subpoena.
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ReadWritePaths=/etc/livekit

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/veil-token.service <<'UNIT'
[Unit]
Description=Veil token service
After=livekit.service
Wants=livekit.service

[Service]
WorkingDirectory=/srv/veil-src/server
EnvironmentFile=/etc/veil/livekit.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --experimental-strip-types src/index.ts
Restart=on-failure
RestartSec=3
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT

echo "==> host firewall"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp     comment 'ssh'
ufw allow 80/tcp     comment 'http (acme)'
ufw allow 443/tcp    comment 'https'
ufw allow 7881/tcp   comment 'livekit rtc tcp'
ufw allow 7882/udp   comment 'livekit rtc udp'
ufw allow 3478/udp   comment 'turn'
ufw allow 5349/tcp   comment 'turn tls'
ufw --force enable

# Oracle's Ubuntu images ship iptables rules that ufw does not manage.
iptables -I INPUT -p udp --dport 7882 -j ACCEPT || true
iptables -I INPUT -p udp --dport 3478 -j ACCEPT || true
netfilter-persistent save 2>/dev/null || true

systemctl daemon-reload
systemctl enable --now livekit.service

cat <<DONE

==> host is provisioned. Remaining manual steps:

  1. In the Oracle console, open these in the VCN security list / NSG:
       TCP  443, 80, 7881, 5349
       UDP  7882, 3478
     The host firewall above is not enough on its own.

  2. Point DNS at this instance:
       ${DOMAIN}      A  <this instance's public IP>
       ${SFU_DOMAIN}  A  <this instance's public IP>

  3. Deploy the app:
       git clone <your repo> /srv/veil-src
       cd /srv/veil-src && npm ci && npm run build
       install -d /srv/veil && cp -r web/dist/* /srv/veil/
       cp deploy/Caddyfile /etc/caddy/Caddyfile
       sed -i "s/talk.example.com/${DOMAIN}/; s/sfu.example.com/${SFU_DOMAIN}/" /etc/caddy/Caddyfile
       systemctl reload caddy
       systemctl enable --now veil-token.service

  4. Give LiveKit's TURN its certificates (Caddy already fetched them):
       install -d /etc/livekit/turn
       cp /var/lib/caddy/.local/share/caddy/certificates/*/${SFU_DOMAIN}/${SFU_DOMAIN}.crt \\
          /etc/livekit/turn/fullchain.pem
       cp /var/lib/caddy/.local/share/caddy/certificates/*/${SFU_DOMAIN}/${SFU_DOMAIN}.key \\
          /etc/livekit/turn/privkey.pem
       systemctl restart livekit
     Automate this with a renewal hook, or TURN/TLS breaks every 90 days.

  5. Watch your egress. 10 TB/month is roughly 1,800 hours of 4-person calls
     with a 1080p share. Check it in the Oracle console, not by guessing.

DONE
