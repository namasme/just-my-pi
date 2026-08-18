#!/usr/bin/env bash
# Install the report extension globally via a symlink, or validate the link.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions"
LINK="$EXT_DIR/report"
CHECK_ONLY="${1:-}"

if [ "$CHECK_ONLY" = "--check" ]; then
  printf 'source : %s\n' "$REPO_DIR"
  if [ -L "$LINK" ]; then
    printf 'link   : %s -> %s\n' "$LINK" "$(readlink "$LINK")"
    [ "$(readlink "$LINK")" = "$REPO_DIR" ] || exit 2
    exit 0
  fi
  printf 'link   : %s (missing or not a symlink)\n' "$LINK"
  exit 2
fi

mkdir -p "$EXT_DIR"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  printf 'ERROR: %s exists and is not a symlink; refusing to replace it\n' "$LINK" >&2
  exit 1
fi

ln -sfn "$REPO_DIR" "$LINK"
printf 'Installed global Pi extension: %s -> %s\n' "$LINK" "$REPO_DIR"
printf 'Run /reload in existing Pi sessions.\n'
