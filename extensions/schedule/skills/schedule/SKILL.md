---
name: schedule
description: Schedule delegated work, reminders, polling checks, or conditional automations with launchd. Use for “remind me at…”, “check X every hour until Y”, “watch for X and then do Y”, and requests to inspect or cancel an existing scheduled job.
compatibility: macOS with launchd and Python 3.9 or newer.
---

# Schedule

Resolve this file's enclosing directory and set the shell variable `SKILL_DIR` to that absolute path; the deterministic manager is `$SKILL_DIR/schedule.py`. Pi invokes this skill as `/schedule`; omp invokes it as `/skill:schedule` (or by asking the agent to read `skill://schedule`). The manager installs a per-job LaunchAgent and a reaper; your conversation does not remain open or wait. The job's scripts, not the model, perform future checks and actions. This is a **logged-in Mac** mechanism, not a remote agent or a promise that a sleeping/offline Mac will execute on time.

## Create

1. Translate the request into an observable check and an action. Resolve the source of truth, credentials, working directory, and how the action avoids repeating a harmful side effect. If the check cannot run unattended with available access, report that prerequisite rather than installing a pretend job. For important deadlines on a laptop, say that delivery depends on the Mac being on and the user logged in.
2. Create a directory with `job.json` and any executable check/action scripts. Keep dependencies in the copied job folder where possible; use absolute paths for external programs/files. The manager copies the whole directory into `~/Library/Application Support/agent-schedule/jobs/<id>/`, then runs commands with that directory as cwd, a fixed PATH (`/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`), and no interactive shell. Use argument arrays, not shell-interpolated user text. Place secrets in existing OS facilities, not `job.json`, command arguments, or notification text. Set script permissions if invoked directly, or use `/bin/sh` / `/usr/bin/python3` as the executable.
3. Choose one schedule:
   - `{"at":"2026-10-23T15:00:00-07:00"}` — one-off, at or after that instant; retries a pending check once a minute. Timezone **required**.
   - `{"every_seconds":3600,"stop_when_matched":true}` — check immediately, then hourly until the first match; run action/notification and complete.
   - `{"every_seconds":3600,"stop_when_matched":false}` — check immediately, then hourly forever; run action/notification on each match. Minimum interval 60 seconds.
4. Write `job.json` using this schema (omit unused keys):

   ```json
   {
     "id": "example-unique-slug",
     "description": "What is checked and what happens when it matches",
     "schedule": {"every_seconds": 3600, "stop_when_matched": true},
     "check": ["/bin/sh", "check.sh"],
     "action": ["/bin/sh", "act.sh"],
     "notification": {"title": "Something happened", "message": "What to do next"},
     "timeout_seconds": 300
   }
   ```

   `check` is optional except for stop-when-matched jobs: exit **0** = condition met; **1** = not yet; **2+** = error. `action` and `notification` are each optional, but at least one is required. `action` exits 0 on success; any other status is an error. For a once-at-time reminder, omit `check` and `action` and supply `notification`. For a dynamic notification, put the notification logic in `action`; built-in `notification` has static text. `id` is a unique lowercase slug starting with a letter, up to 63 characters.
5. Verify the source and commands against the real target (especially false/true/error results for a check). Install with `/usr/bin/python3 "$SKILL_DIR/schedule.py" install <directory>`. Run the same command with `show <id>` and confirm the job is active and loaded, **or** already completed (an immediate match can finish before inspection). Tell the user the id, exact cadence/condition, action/notification, and how to cancel it. Do not manually run a non-idempotent action just to test wiring.

## Manage

- `... list` — active and historical jobs; `... show <id>` — definition, state, last error, loaded status. Execution output: `~/Library/Application Support/agent-schedule/jobs/<id>/{stdout,stderr}.log`; reaper errors: `~/Library/Application Support/agent-schedule/manager.err`.
- `... cancel <id>` — marks canceled, bootouts its LaunchAgent, removes its plist; history/scripts remain. To revise, cancel and install a new id. `... reap` repairs missing/unloaded active agents and retries cleanup of finished jobs; the reaper runs each minute. Never remove another LaunchAgent.
- `... run <id> --force` is for controlled verification only: it bypasses timing, not completed/canceled state. Beware real side effects.

## Reliability contract

Each job is serialized with a file lock. Before an action starts, state records the match; after a successful action, state advances to notification so a failed notification retries **without repeating the action**. A failed check/action stays active and retries on a later launch; the first failure in an error episode posts a failure notification. Completed jobs are marked durably before a separate reaper unloads them (normally within a minute); their history remains for inspection. The manager uses macOS Notification Center via `osascript`; presentation depends on notification permissions/settings. It cannot guarantee exactly-once execution across a crash *during* an external action: make side effects idempotent or use an external idempotency key. Interval launches missed during sleep are not replayed; they resume when the Mac runs again. One-off jobs fire no earlier than their timestamp, on the next minute tick while logged in. For a hard deadline or always-on polling, run the check on an always-on host instead.
