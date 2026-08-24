#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TRACKER="$TMP/tracker"
HOOKS="$TMP/hooks"
MARKER="$TMP/post-commit-ran"
GLOBAL_CONFIG="$TMP/gitconfig"
mkdir -p "$HOOKS"

cat > "$HOOKS/post-commit" <<EOF
#!/usr/bin/env bash
touch "$MARKER"
EOF
chmod +x "$HOOKS/post-commit"

cat > "$GLOBAL_CONFIG" <<EOF
[user]
  name = Pi Report Test
  email = pi-report-test@example.invalid
[core]
  hooksPath = $HOOKS
EOF

GIT_CONFIG_GLOBAL="$GLOBAL_CONFIG" \
PI_REPORT_TRACKER_DIR="$TRACKER" \
  "$ROOT/setup-tracker.sh" >/dev/null

if [ -e "$MARKER" ]; then
  echo "FAIL: global post-commit hook executed during tracker setup" >&2
  exit 1
fi

[ -f "$TRACKER/.beads/issues.jsonl" ]
[ -d "$TRACKER/.git/pi-report-empty-hooks" ]
git -C "$TRACKER" diff --quiet
git -C "$TRACKER" diff --cached --quiet
[ "$(git -C "$TRACKER" log -1 --pretty=%s)" = "Initialize Pi reports tracker" ]

# Exercise the same Beads metadata lookup and hook-suppressed commit shape used
# by /report. The malicious global post-commit hook must remain inert.
REPORT_KEY="session-test:2026-07-17T10:00:00.000Z"
CREATE_JSON="$(
  cd "$TRACKER"
  GIT_CONFIG_GLOBAL="$GLOBAL_CONFIG" bd create --title "--integration report" \
    --type bug --priority P2 --labels pi-report \
    --description "integration" \
    --metadata "{\"reportKey\":\"$REPORT_KEY\"}" \
    --json
)"
BEAD_ID="$(printf '%s' "$CREATE_JSON" | sed -n 's/.*"id": "\([^"]*\)".*/\1/p' | head -1)"
[ -n "$BEAD_ID" ]
LOOKUP="$(cd "$TRACKER" && bd list --all --metadata-field "reportKey=$REPORT_KEY" --json)"
printf '%s' "$LOOKUP" | grep -q "\"id\": \"$BEAD_ID\""

(
  cd "$TRACKER"
  # An unrelated staged change must not be absorbed by the path-limited report commit.
  printf '\nunrelated staged test change\n' >> README.md
  git add README.md
  bd export --no-memories --output .beads/issues.jsonl >/dev/null
  git add -f .beads/issues.jsonl
  git -c "core.hooksPath=$TRACKER/.git/pi-report-empty-hooks" \
    commit --no-verify -q -m "report: $BEAD_ID" -- .beads/issues.jsonl
)

if [ -e "$MARKER" ]; then
  echo "FAIL: global post-commit hook executed during report commit" >&2
  exit 1
fi
[ "$(git -C "$TRACKER" log -1 --pretty=%s)" = "report: $BEAD_ID" ]
[ "$(git -C "$TRACKER" show --format= --name-only HEAD | sed '/^$/d')" = ".beads/issues.jsonl" ]
[ "$(git -C "$TRACKER" diff --cached --name-only)" = "README.md" ]
git -C "$TRACKER" restore --staged --worktree README.md

# A second setup run must be a no-op.
GIT_CONFIG_GLOBAL="$GLOBAL_CONFIG" \
PI_REPORT_TRACKER_DIR="$TRACKER" \
  "$ROOT/setup-tracker.sh" >/dev/null

if [ -e "$MARKER" ]; then
  echo "FAIL: global post-commit hook executed during idempotent setup" >&2
  exit 1
fi

echo "setup/report integration: passed"
