#!/usr/bin/env bash
# Deploy FLY OR DIE to Cloudflare Pages (direct upload).
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./deploy.sh
#
# Token needs the "Cloudflare Pages: Edit" permission.
# Override the project name with CF_PROJECT_NAME=my-project ./deploy.sh
set -eu
root="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN is not set" >&2
  exit 1
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "error: CLOUDFLARE_ACCOUNT_ID is not set" >&2
  exit 1
fi

bash "$root/build.sh"

npx --yes wrangler@latest pages deploy "$root/dist" \
  --project-name="${CF_PROJECT_NAME:-fly-or-die}" \
  --branch="${CF_BRANCH:-main}" \
  --commit-dirty=true
