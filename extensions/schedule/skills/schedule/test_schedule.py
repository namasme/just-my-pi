#!/usr/bin/python3
"""End-to-end tests using isolated launchd labels and temporary job directories."""

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name("schedule.py")


class ScheduleIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="schedule-test-")
        base = Path(self.temp.name).resolve()
        self.home = base / "home"
        self.agents = base / "agents"
        self.source = base / "source"
        self.source.mkdir()
        self.prefix = "local.agent-schedule." + hashlib.sha256(str(self.home).encode()).hexdigest()[:8] + "."
        self.domain = "gui/" + str(os.getuid())
        if subprocess.run(["/bin/launchctl", "print", self.domain], capture_output=True).returncode:
            self.skipTest("requires a logged-in macOS GUI session")

    def tearDown(self):
        for ident in ("once", "until", "repeat", "reaper"):
            label = self.domain + "/" + self.prefix + ident
            subprocess.run(["/bin/launchctl", "bootout", label], capture_output=True)
        self.temp.cleanup()

    def cli(self, *args, expected=0):
        result = subprocess.run(["/usr/bin/python3", str(SCRIPT), "--home", str(self.home),
                                 "--agents-dir", str(self.agents), *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stdout

    def create(self, ident, schedule, check=False, notification=False):
        spec = {"id": ident, "description": "integration exercise", "schedule": schedule,
                "action": ["/bin/sh", "act.sh"]}
        if check:
            spec["check"] = ["/bin/sh", "check.sh"]
            (self.source / "check.sh").write_text('test -f ready\n')
        if notification:
            spec["notification"] = {"title": "Schedule test", "message": "One-off smoke notification"}
        (self.source / "act.sh").write_text('printf "fired\\n" >> result\n')
        (self.source / "job.json").write_text(json.dumps(spec))
        self.cli("install", str(self.source))
        return self.home / "jobs" / ident

    def state(self, ident):
        return json.loads(self.cli("show", ident))

    def wait_for(self, ident, predicate):
        for _ in range(100):
            value = self.state(ident)
            if predicate(value):
                return value
            time.sleep(0.1)
        self.fail("timed out waiting for " + ident + ": " + str(value))

    def test_one_off_runs_notification_and_reaps_plist(self):
        past = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)
        job = self.create("once", {"at": past.isoformat()}, notification=True)
        value = self.wait_for("once", lambda v: v["state"]["status"] == "completed")
        self.assertIsNone(value["state"]["last_error"])
        self.assertEqual((job / "result").read_text(), "fired\n")
        self.cli("reap")
        self.assertFalse(self.state("once")["loaded"])
        self.assertFalse((self.agents / (self.prefix + "once.plist")).exists())
        self.assertTrue((job / "state.json").exists())

    def test_until_skips_false_then_completes_once_true(self):
        job = self.create("until", {"every_seconds": 60, "stop_when_matched": True}, check=True)
        self.wait_for("until", lambda v: v["state"]["runs"] >= 1)
        self.assertFalse((job / "result").exists())
        (job / "ready").touch()
        self.cli("run", "until", "--force")
        self.assertEqual(self.state("until")["state"]["status"], "completed")
        self.cli("run", "until", "--force")
        self.assertEqual((job / "result").read_text(), "fired\n")

    def test_recurring_runs_each_slot_and_can_cancel(self):
        job = self.create("repeat", {"every_seconds": 60, "stop_when_matched": False})
        self.wait_for("repeat", lambda v: v["state"]["matches"] >= 1)
        self.cli("run", "repeat")
        self.assertEqual((job / "result").read_text(), "fired\n")
        label = self.domain + "/" + self.prefix + "repeat"
        subprocess.run(["/bin/launchctl", "bootout", label], check=True)
        (self.agents / (self.prefix + "repeat.plist")).unlink()
        self.assertFalse(self.state("repeat")["loaded"])
        self.cli("reap")
        self.assertTrue(self.state("repeat")["loaded"])
        self.assertEqual((job / "result").read_text(), "fired\n")
        self.cli("run", "repeat", "--force")
        self.assertEqual((job / "result").read_text(), "fired\nfired\n")
        self.cli("cancel", "repeat")
        self.assertEqual(self.state("repeat")["state"]["status"], "canceled")
        self.assertFalse(self.state("repeat")["loaded"])


if __name__ == "__main__":
    unittest.main()
