#!/usr/bin/env bash
set -euo pipefail

before_sha=${BEFORE_SHA:-}

# Dispatches and unavailable baselines must not miss an image update.
if [[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]] ||
  [[ -z "$before_sha" || "$before_sha" =~ ^0+$ ]] ||
  ! git rev-parse --verify "${before_sha}^{commit}" > /dev/null 2>&1; then
  printf 'backend=true\nfrontend=true\n' >> "$GITHUB_OUTPUT"
  exit 0
fi

# Keep filenames NUL-delimited; pipefail propagates any real diff failure.
git diff --name-only --no-renames -z "$before_sha" "$GITHUB_SHA" -- | {
  backend=false
  frontend=false
  while IFS= read -r -d '' path; do
    case "$path" in
      backend/*) backend=true ;;
      frontend/*) frontend=true ;;
      .github/* | compose.yaml | Caddyfile | .env.example | deploy/*)
        backend=true
        frontend=true
        ;;
    esac
  done
  printf 'backend=%s\nfrontend=%s\n' "$backend" "$frontend" >> "$GITHUB_OUTPUT"
}
