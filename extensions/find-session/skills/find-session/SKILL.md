---
name: find-session
description: Find a half-remembered pi/omp session by fragments, topic, path, or timeframe. Invoke in pi as /find-session; in omp as /skill:find-session (or tell the agent "read skill://find-session").
disable-model-invocation: true
---

# Find Session

A detective run: the user remembers pieces, the session store remembers everything. Turn the pieces into a **warrant**, **sweep** the store, and deliver a **ledger** — a hit is a find, a miss is a finding.

Treat the directory containing this file as `SKILL_DIR`. The bundled scripts are `SKILL_DIR/hunt.sh` and `SKILL_DIR/profile.sh`.

## Store map

Two session stores, both v3 JSONL with the same record shapes (files are shared between `pi` and `omp`, but each CLI writes its own store):

- `~/.pi/agent/sessions/` — `pi` sessions (~1000 files, ~450MB).
- `~/.omp/agent/sessions/` — `omp` sessions. The encoded cwd dir uses a single dash for the leading `/` (`-tmp`, `-code-...`) instead of pi's `--` convention.

Layout in both: `<encoded-cwd>/<start-timestamp>_<uuid>.jsonl`. The first line of the file (`type:"session"`) carries the true `cwd` — confirm against it, never the decoded dir name alone. Other facts:

- Turns: lines with `type:"message"`; role at `.message.role` (`user`, `assistant`, `toolResult`); readable text at `.message.content[].text` for `text` parts. Tool calls and results also carry searchable text.
- Named sessions: `type:"session_info"` lines carry `.name` (pi store) or a `type:"title"` first line (omp store) — most names come from subagents like `[reviewer] …`.
- Subagent runs: `<hash>/run-*/session.jsonl` nested inside a session directory are subagent transcripts; the enclosing timestamped dir is the session that spawned them. A hit there means the *parent* session worked that topic.
- Artifacts: `~/.pi/history/<project>/artifacts/` — specs, hand-offs, notes; search when fragments sound like documents.
- `~/.pi/agent/run-history.jsonl` — agent name + task hash only (tasks redacted); last resort.

Text is JSON-escaped inside the JSONL: newlines are `\n` and quotes are `\"`. Grep for short sub-phrases of a quote, never a multi-line passage.

## Steps

1. **Frame the warrant.** Every fragment the user supplies becomes a clue with its kind tagged: `path` (cwd or any dir component), `quote` (words they recall saying or reading), `topic` (keywords), `time` (a month, a "recently", a before/after), `name` (a `--name` or title they might have used), `artifact` (something written/spit out). Vague clues earn a clarifying question — but run the sweep on what you already hold while waiting.
   *Done when:* every fragment from the user's message is a clue in the warrant.

2. **Sweep, cheapest discriminator first.** Order: `path` → `name` → `quote`/`topic`.
   - path: `ls ~/.pi/agent/sessions ~/.omp/agent/sessions | grep -i '<component>'` (grep the encoded form; dashes survive inside components).
   - name: `grep -rh '"type":"session_info"' ~/.pi/agent/sessions --include='*.jsonl' | grep -i '<term>'` (pi names; omp titles ride `type:"title"` lines, which the quote scan finds anyway).
   - quote/topic: run the bundled scan with every quote/topic term at once —
     `bash "$SKILL_DIR/hunt.sh" '<term1>' '<term2>' …`
     It prints one ranked line per matching file: `TERMS=n/N` (clues satisfied), per-term hit counts, start timestamp, file path. Files matching all terms sit at the top. Sub-second with `rg` present; ~10s/term with plain grep (counts then show `=n/a`). Terms are literal substrings — regex syntax is not honored.
   - time: filter candidates by the timestamp prefix of the filename, or `ls <dir>` between sweep rounds.
   Retarget on a miss: shorten the quote to its most distinctive word, swap in a synonym for the topic, drop a path level. Each retarget goes in the ledger as a new row.
   *Done when:* every clue has been swept in every store that can hold it, or retargeted to exhaustion.

3. **Confirm the candidate.** Read the strongest candidate before claiming victory — run `bash "$SKILL_DIR/profile.sh" <file>`. It prints the session header (id, start time, true cwd, name if any) followed by every conversational turn as `timestamp [role] text` — chronological, verbatim. For fields the script doesn't surface, fall back to raw jq:
   `jq -r 'select(.type=="message") | .timestamp as $t | .message.role as $r | .message.content[]? | select(.type=="text") | "\($t) [\($r)] \(.text[0:160])"' <file>`
   *Done when:* every claim about the session's content is a verbatim quote with its timestamp — or the candidate is ruled out and the next one is up.

4. **Deliver the ledger.** The report the user reads, hit or miss:
   - **Warrant** — the clues, tagged by kind.
   - **Sweep log** — one row per sweep: clue, store, command shape, hit count. Every clue from step 1 appears here, including its misses.
   - **Candidates** — ranked, each with file path, start time, cwd, verbatim excerpt, and which clues it satisfies. Nested hits cite the parent session.
   - **Adjacent finds** — near-misses and neighbours (same week, same cwd, same topic) worth knowing about even when the target stays lost.
   - **Verdict** — the session and its resume command (`pi --session <path-or-partial-uuid>`, or `pi --export <file>` for an HTML read), or an honest miss with the elimination map the sweep log now is.
   *Done when:* all five sections are present — warrant, sweep log, candidates, adjacent finds, verdict — and a reader who supplied the fragments could retrace every sweep and either resume the session or read exactly where it isn't.
