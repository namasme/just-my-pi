#!/usr/bin/env bash
# Initialize the standalone Git + Beads workspace used by the Pi /report command.
set -euo pipefail

TRACKER_DIR="${PI_REPORT_TRACKER_DIR:-$HOME/pi/reports}"
PREFIX="pir"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is not installed or not on PATH"
command -v bd >/dev/null 2>&1 || fail "bd is not installed or not on PATH"

if [ -d "$TRACKER_DIR/.git" ] && [ -d "$TRACKER_DIR/.beads" ]; then
  if git -C "$TRACKER_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
    EMPTY_HOOKS_DIR="$TRACKER_DIR/.git/pi-report-empty-hooks"
    mkdir -p "$EMPTY_HOOKS_DIR"
    git -C "$TRACKER_DIR" config --local core.hooksPath "$EMPTY_HOOKS_DIR"
    printf 'Pi reports tracker is already initialized: %s\n' "$TRACKER_DIR"
    exit 0
  fi
  printf 'Finishing partially initialized Pi reports tracker: %s\n' "$TRACKER_DIR"
elif [ -e "$TRACKER_DIR" ] && [ -n "$(find "$TRACKER_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  fail "$TRACKER_DIR exists and is not an initialized Pi reports tracker; move it aside or initialize it manually"
fi

mkdir -p "$TRACKER_DIR"
cd "$TRACKER_DIR"

if [ ! -d .git ]; then
  if ! git init -q -b main 2>/dev/null; then
    git init -q
  fi
fi

EMPTY_HOOKS_DIR="$TRACKER_DIR/.git/pi-report-empty-hooks"
mkdir -p "$EMPTY_HOOKS_DIR"
git config --local core.hooksPath "$EMPTY_HOOKS_DIR"

# Refuse to create an uncommittable tracker rather than inventing an identity.
git var GIT_AUTHOR_IDENT >/dev/null 2>&1 || fail \
  "Git author identity is missing. Configure git user.name and user.email, then rerun this script"

if [ ! -d .beads ]; then
  bd init --non-interactive --skip-agents --skip-hooks --prefix "$PREFIX"
fi
bd export --no-memories --output .beads/issues.jsonl >/dev/null
# `bd export` leaves no file when the database is empty. Track an empty JSONL
# file so the first report can update and commit it normally.
touch .beads/issues.jsonl

cat > README.md <<'EOF'
# Pi session reports

This repository is the centralized Beads tracker used by the global Pi `/report`
command. Reports are created deterministically; no LLM is used during capture.

Each bead contains the originating Pi session ID, transcript path, current leaf,
message counts, runtime details, and Git state. Transcript contents are not copied.

Useful commands:

```bash
bd list --label pi-report
bd show <issue-id>
git log --oneline
```
EOF

# The report lock is process-local coordination state and must never be committed.
printf '\n/.pi-report.lock\n' >> .gitignore

# A user-level Git ignore may exclude every .beads directory, so force-add only
# the portable configuration and JSONL export. Dolt/runtime files remain ignored.
git add README.md .gitignore
git add -f \
  .beads/.gitignore \
  .beads/README.md \
  .beads/config.yaml \
  .beads/issues.jsonl \
  .beads/metadata.json

# Suppress repository and global hooks. Setup and reporting must not execute
# unrelated hook programs, perform network access, or trigger a push.
git -c "core.hooksPath=$EMPTY_HOOKS_DIR" commit --no-verify -q -m "Initialize Pi reports tracker"

printf 'Initialized Pi reports tracker: %s\n' "$TRACKER_DIR"
printf 'Issue prefix: %s\n' "$PREFIX"
printf 'The /report extension will commit each new report but will never push.\n'
