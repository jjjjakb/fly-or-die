#!/usr/bin/env bash
# Stage the static site into dist/ for Cloudflare Pages.
set -eu
root="$(cd "$(dirname "$0")" && pwd)"
out="$root/dist"

rm -rf "$out"
mkdir -p "$out"
for f in index.html styles.css neural.js game.js og.png _headers; do
  cp "$root/$f" "$out/$f"
done

echo "built -> $out"
