#!/usr/bin/env bash
# Start (or restart) the local stack: LiveKit in Docker + the token/relay service.
set -euo pipefail
cd "$(dirname "$0")"
docker info >/dev/null 2>&1 || { (nohup dockerd >/tmp/dockerd.log 2>&1 &); sleep 6; }
docker compose -f deploy/docker-compose.yml up -d
pkill -f "src/index.ts" 2>/dev/null || true
sleep 1
( cd server && setsid env LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret \
  PUBLIC_WS_URL=ws://127.0.0.1:7880 LIVEKIT_HOST_URL=http://127.0.0.1:7880 PORT=8787 RATE_LIMIT=${RATE_LIMIT:-600} \
  nohup node --experimental-strip-types src/index.ts > /tmp/bravetalk-server.log 2>&1 < /dev/null & )
sleep 3
curl -fsS http://127.0.0.1:8787/api/health >/dev/null && echo "stack up: livekit :7880, api :8787"
