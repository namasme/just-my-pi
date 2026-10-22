#!/usr/bin/python3
"""Local launchd-backed automation manager. See SKILL.md for the job format."""

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager

PYTHON = "/usr/bin/python3"
NOTIFIER = "/usr/bin/osascript"
PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
ID = re.compile(r"[a-z][a-z0-9-]{0,62}\Z")
SCRIPT = str(Path(__file__).resolve())


def now():
    return dt.datetime.now(dt.timezone.utc)


def stamp(value):
    return value.isoformat(timespec="seconds")


def save_json(path, value):
    fd, name = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def load_json(path):
    with path.open() as stream:
        return json.load(stream)


@contextmanager
def lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def validate(spec):
    if not isinstance(spec, dict) or set(spec) - {"id", "description", "schedule", "check", "action", "notification", "timeout_seconds"}:
        raise ValueError("job must contain only id, description, schedule, check, action, notification, timeout_seconds")
    ident = spec.get("id")
    if not isinstance(ident, str) or not ID.fullmatch(ident):
        raise ValueError("id must be lowercase letters, digits, hyphens; begin with a letter (max 63 chars)")
    if ident == "reaper":
        raise ValueError("reaper is a reserved job id")
    if not isinstance(spec.get("description"), str) or not spec["description"].strip():
        raise ValueError("description is required")
    schedule = spec.get("schedule")
    if not isinstance(schedule, dict):
        raise ValueError("schedule must be an object")
    if set(schedule) == {"at"}:
        try:
            at = dt.datetime.fromisoformat(schedule["at"])
        except (TypeError, ValueError):
            raise ValueError("at must be an ISO 8601 timestamp with timezone") from None
        if at.tzinfo is None or at.utcoffset() is None:
            raise ValueError("at requires a timezone offset")
    elif set(schedule) == {"every_seconds", "stop_when_matched"}:
        if type(schedule["every_seconds"]) is not int or schedule["every_seconds"] < 60:
            raise ValueError("every_seconds must be an integer >= 60")
        if type(schedule["stop_when_matched"]) is not bool:
            raise ValueError("stop_when_matched must be boolean")
        if schedule["stop_when_matched"] and not spec.get("check"):
            raise ValueError("stop_when_matched requires check")
    else:
        raise ValueError("schedule must contain either at, or every_seconds and stop_when_matched")
    for field in ("check", "action"):
        command = spec.get(field)
        if command is not None and (not isinstance(command, list) or not command or any(not isinstance(x, str) or not x for x in command)):
            raise ValueError(field + " must be a nonempty array of argument strings")
        if command and not (command[0].startswith("/") or command[0].startswith("./")):
            raise ValueError(field + " executable must be an absolute path or start with ./")
    if not spec.get("action") and not spec.get("notification"):
        raise ValueError("job needs action or notification")
    if spec.get("notification") is not None:
        notification = spec["notification"]
        if not isinstance(notification, dict) or set(notification) != {"title", "message"} or any(not isinstance(v, str) or not v for v in notification.values()):
            raise ValueError("notification needs nonempty title and message strings")
    timeout = spec.get("timeout_seconds", 300)
    if type(timeout) is not int or not 1 <= timeout <= 86400:
        raise ValueError("timeout_seconds must be an integer between 1 and 86400")
    return spec


class Manager:
    def __init__(self, home, agents):
        self.home = Path(home).expanduser().resolve()
        self.agents = Path(agents).expanduser().resolve()
        self.jobs = self.home / "jobs"
        self.prefix = "local.agent-schedule." + hashlib.sha256(str(self.home).encode()).hexdigest()[:8] + "."
        self.domain = "gui/" + str(os.getuid())

    def job(self, ident):
        if not ID.fullmatch(ident):
            raise ValueError("invalid job id")
        return self.jobs / ident

    def label(self, ident):
        return self.prefix + ident

    def plist(self, ident):
        return self.agents / (self.label(ident) + ".plist")

    def reaper_plist(self):
        return self.agents / (self.prefix + "reaper.plist")

    def launch(self, *args, check=True):
        return subprocess.run(["/bin/launchctl", *args], text=True, capture_output=True, check=check)

    def loaded(self, label):
        return self.launch("print", self.domain + "/" + label, check=False).returncode == 0

    def ensure_reaper(self):
        label = self.label("reaper")
        path = self.reaper_plist()
        if not path.exists():
            self.write_plist(path, label, [PYTHON, SCRIPT, "--home", str(self.home), "--agents-dir", str(self.agents), "reap"], 60)
        if not self.loaded(label):
            self.launch("bootstrap", self.domain, str(path))

    def write_plist(self, path, label, command, interval):
        values = {
            "Label": label,
            "ProgramArguments": command,
            "RunAtLoad": True,
            "StartInterval": interval,
            "EnvironmentVariables": {"PATH": PATH},
            "StandardOutPath": str(self.home / "manager.log") if label.endswith(".reaper") else str(self.jobs / label.rsplit(".", 1)[-1] / "stdout.log"),
            "StandardErrorPath": str(self.home / "manager.err") if label.endswith(".reaper") else str(self.jobs / label.rsplit(".", 1)[-1] / "stderr.log"),
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(plistlib.dumps(values))

    def install(self, source):
        source = Path(source).expanduser().resolve()
        if not source.is_dir():
            raise ValueError("install expects a directory containing job.json")
        spec = validate(load_json(source / "job.json"))
        ident = spec["id"]
        for root, dirs, files in os.walk(source):
            if any((Path(root) / entry).is_symlink() for entry in dirs + files):
                raise ValueError("job directory must not contain symlinks")
        self.home.mkdir(parents=True, exist_ok=True)
        with lock(self.home / "install.lock"):
            target = self.job(ident)
            plist = self.plist(ident)
            if target.exists() or plist.exists():
                raise ValueError("job id already exists (use a new id; cancel the old job first)")
            self.jobs.mkdir(parents=True, exist_ok=True)
            self.agents.mkdir(parents=True, exist_ok=True)
            staged = Path(tempfile.mkdtemp(prefix=".install-", dir=self.jobs))
            try:
                shutil.copytree(source, staged, dirs_exist_ok=True, symlinks=False)
                state = {"status": "active", "created_at": stamp(now()), "last_slot": None,
                         "phase": None, "last_error": None, "error_notified": False,
                         "runs": 0, "matches": 0}
                save_json(staged / "state.json", state)
                staged.rename(target)
                self.ensure_reaper()
                interval = 60 if "at" in spec["schedule"] else spec["schedule"]["every_seconds"]
                self.write_plist(plist, self.label(ident),
                                 [PYTHON, SCRIPT, "--home", str(self.home), "--agents-dir", str(self.agents), "run", ident], interval)
                self.launch("bootstrap", self.domain, str(plist))
            except Exception:
                if plist.exists():
                    plist.unlink()
                if target.exists():
                    shutil.rmtree(target)
                raise
            finally:
                if staged.exists():
                    shutil.rmtree(staged)
        print("installed " + ident)

    def notify(self, title, message):
        result = subprocess.run([NOTIFIER, "-e", "on run argv", "-e",
                                 "display notification (item 2 of argv) with title (item 1 of argv)",
                                 "-e", "end run", title, message], text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError("notification failed: " + result.stderr.strip())

    def execute(self, command, cwd, timeout):
        try:
            result = subprocess.run(command, cwd=cwd, env={**os.environ, "PATH": PATH},
                                    text=True, capture_output=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(str(exc)) from exc
        if result.stdout:
            print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="" if result.stderr.endswith("\n") else "\n")
        return result.returncode

    def failed(self, ident, state, error, notify=True):
        state["last_error"] = error
        state["last_error_at"] = stamp(now())
        if notify and not state["error_notified"]:
            try:
                self.notify("Schedule failed: " + ident, error[:200])
                state["error_notified"] = True
            except RuntimeError as exc:
                print(exc, file=sys.stderr)
        save_json(self.job(ident) / "state.json", state)
        print(error, file=sys.stderr)
        return 2

    def run(self, ident, force=False):
        directory = self.job(ident)
        if not directory.exists():
            raise ValueError("unknown job: " + ident)
        with lock(directory / "run.lock"):
            spec = load_json(directory / "job.json")
            state = load_json(directory / "state.json")
            if state["status"] != "active":
                return 0
            schedule = spec["schedule"]
            current = now()
            if "at" in schedule:
                if current < dt.datetime.fromisoformat(schedule["at"]) and not force:
                    return 0
                slot = 0
                stop = True
            else:
                seconds = schedule["every_seconds"]
                created = dt.datetime.fromisoformat(state["created_at"])
                slot = max(0, int((current - created).total_seconds() // seconds))
                stop = schedule["stop_when_matched"]
                if state["last_slot"] == slot and not force and state["phase"] is None:
                    return 0
            timeout = spec.get("timeout_seconds", 300)
            if state["phase"] is None:
                if spec.get("check"):
                    try:
                        code = self.execute(spec["check"], directory, timeout)
                    except RuntimeError as exc:
                        return self.failed(ident, state, "check: " + str(exc))
                    if code == 1:
                        state.update(last_slot=slot, last_error=None, error_notified=False, runs=state["runs"] + 1)
                        save_json(directory / "state.json", state)
                        return 0
                    if code != 0:
                        return self.failed(ident, state, "check exited " + str(code))
                state.update(phase="action", last_slot=slot, runs=state["runs"] + 1,
                             matches=state["matches"] + 1, last_error=None, error_notified=False)
                save_json(directory / "state.json", state)
            if state["phase"] == "action":
                if spec.get("action"):
                    try:
                        code = self.execute(spec["action"], directory, timeout)
                    except RuntimeError as exc:
                        return self.failed(ident, state, "action: " + str(exc))
                    if code != 0:
                        return self.failed(ident, state, "action exited " + str(code))
                state["phase"] = "notify"
                state["last_error"] = None
                state["error_notified"] = False
                save_json(directory / "state.json", state)
            if state["phase"] == "notify":
                if spec.get("notification"):
                    try:
                        self.notify(spec["notification"]["title"], spec["notification"]["message"])
                    except RuntimeError as exc:
                        return self.failed(ident, state, str(exc), notify=False)
                state.update(phase=None, last_error=None, error_notified=False, last_fired_at=stamp(now()))
                if stop:
                    state.update(status="completed", completed_at=stamp(now()))
                save_json(directory / "state.json", state)
        if stop:
            # The separate reaper bootouts completed jobs; doing it here would kill this process.
            self.launch("kickstart", self.domain + "/" + self.label("reaper"), check=False)
        return 0

    def cancel(self, ident):
        directory = self.job(ident)
        if not directory.exists():
            raise ValueError("unknown job: " + ident)
        with lock(directory / "run.lock"):
            state = load_json(directory / "state.json")
            if state["status"] == "active":
                state.update(status="canceled", canceled_at=stamp(now()))
                save_json(directory / "state.json", state)
        self.reap()
        print("canceled " + ident)

    def reap(self):
        if not self.jobs.exists():
            return
        with lock(self.home / "install.lock"):
            for directory in self.jobs.iterdir():
                if not directory.is_dir() or not ID.fullmatch(directory.name):
                    continue
                state_file = directory / "state.json"
                if not state_file.exists():
                    continue
                state = load_json(state_file)
                ident = directory.name
                label = self.label(ident)
                path = self.plist(ident)
                loaded = self.loaded(label)
                if state["status"] == "active":
                    if not loaded:
                        if not path.exists():
                            spec = load_json(directory / "job.json")
                            interval = 60 if "at" in spec["schedule"] else spec["schedule"]["every_seconds"]
                            self.write_plist(path, label,
                                             [PYTHON, SCRIPT, "--home", str(self.home), "--agents-dir", str(self.agents), "run", ident], interval)
                        result = self.launch("bootstrap", self.domain, str(path), check=False)
                        if result.returncode:
                            print("restore " + ident + ": " + result.stderr.strip(), file=sys.stderr)
                        else:
                            print("restored " + ident)
                elif state["status"] in ("completed", "canceled"):
                    if loaded:
                        result = self.launch("bootout", self.domain + "/" + label, check=False)
                        if result.returncode:
                            print("bootout " + ident + ": " + result.stderr.strip(), file=sys.stderr)
                            continue
                    if path.exists():
                        path.unlink()
                        print("reaped " + ident)
                    elif loaded:
                        print("reaped " + ident)

    def show(self, ident):
        directory = self.job(ident)
        if not directory.exists():
            raise ValueError("unknown job: " + ident)
        print(json.dumps({"job": load_json(directory / "job.json"),
                          "state": load_json(directory / "state.json"),
                          "loaded": self.loaded(self.label(ident))}, indent=2, sort_keys=True))

    def list(self):
        if not self.jobs.exists():
            return
        for directory in sorted(self.jobs.iterdir()):
            if directory.is_dir() and ID.fullmatch(directory.name) and (directory / "state.json").exists():
                state = load_json(directory / "state.json")
                print("{}\t{}\t{}".format(directory.name, state["status"], state.get("last_error") or ""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", default="~/Library/Application Support/agent-schedule")
    parser.add_argument("--agents-dir", default="~/Library/LaunchAgents")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("install", help="install a directory containing job.json and its scripts")
    add.add_argument("source")
    run = commands.add_parser("run", help="run one due job (normally invoked by launchd)")
    run.add_argument("id")
    run.add_argument("--force", action="store_true", help="run before due time for testing")
    cancel = commands.add_parser("cancel", help="cancel a job and unload its LaunchAgent")
    cancel.add_argument("id")
    show = commands.add_parser("show", help="inspect a job and its state")
    show.add_argument("id")
    commands.add_parser("list", help="list all jobs, including history")
    commands.add_parser("reap", help="restore unloaded active jobs; unload and remove finished plists")
    args = parser.parse_args()
    manager = Manager(args.home, args.agents_dir)
    try:
        if args.command == "install":
            manager.install(args.source)
        elif args.command == "run":
            return manager.run(args.id, args.force)
        elif args.command == "cancel":
            manager.cancel(args.id)
        elif args.command == "show":
            manager.show(args.id)
        elif args.command == "list":
            manager.list()
        else:
            manager.reap()
    except (ValueError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print("schedule: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
