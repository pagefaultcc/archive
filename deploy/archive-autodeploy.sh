#!/usr/bin/env bash
# Archive auto-deploy: pull newer GHCR images and recreate only the
# containers whose image changed. Run from cron/systemd as a user in the
# docker group. Fails with a clear message while ghcr.io is not logged in.
set -euo pipefail
# Serialize runs: a manual run colliding with the timer otherwise races
# docker compose and can leave name-conflict remnants.
exec 9>/tmp/archive-autodeploy.lock
flock -n 9 || { echo "$(date -Is) another deploy run in progress, skipping"; exit 0; }

 cd /home/deploy/archive
before_api=$(docker inspect --format '{{.Image}}' archive-api-1 2>/dev/null || true)
before_fe=$(docker inspect --format '{{.Image}}' archive-frontend-1 2>/dev/null || true)

if ! docker compose pull api frontend >/dev/null 2>&1; then
  echo "$(date -Is) pull failed - run: echo <PAT-read:packages> | docker login ghcr.io -u <user> --password-stdin"
  exit 1
fi

docker compose up -d --remove-orphans api frontend

after_api=$(docker inspect --format '{{.Image}}' archive-api-1 2>/dev/null || true)
after_fe=$(docker inspect --format '{{.Image}}' archive-frontend-1 2>/dev/null || true)

if [ "$before_api" != "$after_api" ] || [ "$before_fe" != "$after_fe" ]; then
  echo "$(date -Is) deployed api: ${before_api:0:19} -> ${after_api:0:19} frontend: ${before_fe:0:19} -> ${after_fe:0:19}"
  # Keep a week of superseded images for rollback, drop older ones.
  docker image prune -f --filter "until=168h" >/dev/null
else
  echo "$(date -Is) images unchanged"
fi
