#!/usr/bin/env bash
# profile.sh FILE — session header + readable conversation extract.
#
# Prints:
#   SESSION  <id>  <start timestamp>  <true cwd>     (from the session record)
#   NAME     <name>                                  (if the session has one)
#   <timestamp> [role] <text>                        (per turn, chronological,
#                                                    user/assistant/toolResult
#                                                    text parts, 500 chars each)
set -euo pipefail
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: profile.sh SESSION_FILE" >&2; exit 2; }

jq -r '
  select(.type=="session" or .type=="session_info" or .type=="message") |
  if .type == "session" then "SESSION  \(.id)  \(.timestamp)  \(.cwd)"
  elif .type == "session_info" then "NAME     \(.name)"
  else
    .timestamp as $t | .message.role as $r |
    .message.content[]? | select(.type=="text") |
    "\($t) [\($r)] \(.text[0:500])"
  end
' "$1"
