#!/usr/bin/env bash
# hunt.sh TERM... — multi-clue coincidence scan over the pi and omp session stores.
#
# Each TERM is matched as a case-insensitive substring across every session
# file; a file scores one point per distinct TERM it contains. Substring
# matching covers both quoted phrases and topic words ("migrat" hits
# "db-migration"); regex syntax is not honored.
#
# Output, one line per matching file, ranked by score, then recency:
#   TERMS=2/3  hits:'a'=5,'b'=2  2026-06-08T17-09-02  <file path>
# The file path's directory encodes the session's cwd:
#   ~/.pi/agent/sessions/--Users-name--/         (dashes for slashes)
#   ~/.omp/agent/sessions/-tmp/                 (single dash for leading /)
# One pass per term (rg ~0.2s, grep ~10s on a ~450MB store); counts come
# free with rg, are skipped on grep-only machines (hits shows '=n/a').
#
# PI_SESSION_DIR overrides the store list.
set -u
STORES=("${PI_SESSION_DIR:-$HOME/.pi/agent/sessions}" "$HOME/.omp/agent/sessions")
[ $# -ge 1 ] || { echo "usage: hunt.sh TERM..." >&2; exit 2; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
if command -v rg >/dev/null 2>&1; then
  for term in "$@"; do
    for store in "${STORES[@]}"; do
      [ -d "$store" ] || continue
      rg -iF --count-matches -g '*.jsonl' -- "$term" "$store" 2>/dev/null |
        awk -v t="$term" '{
          c = $0; sub(/.*:/, "", c)
          f = $0; sub(/:[0-9]+$/, "", f)
          if (c+0 > 0) print f "\t" t "\t" c
        }'
    done
  done >> "$tmp"
else
  for term in "$@"; do
    for store in "${STORES[@]}"; do
      [ -d "$store" ] || continue
      grep -rliF -- "$term" "$store" --include='*.jsonl' 2>/dev/null |
        while IFS= read -r f; do printf '%s\t%s\tn/a\n' "$f" "$term"; done >> "$tmp"
    done
  done
fi

awk -F'\t' -v N="$#" '
  !seen[$1 SUBSEP $2]++ {
    score[$1]++
    det[$1] = det[$1] (det[$1] == "" ? "" : ",") "\x27" $2 "\x27=" $3
  }
  END {
    for (f in score) {
      n = f; sub(/.*\//, "", n)
      printf "TERMS=%d/%d\thits:%s\t%s\t%s\n", score[f], N, det[f], substr(n, 1, 20), f
    }
  }
' "$tmp" |
sort -t$'\t' -k1,1Vr -k3,3r |
cut -f1,2,4- | tr '\t' ' '
