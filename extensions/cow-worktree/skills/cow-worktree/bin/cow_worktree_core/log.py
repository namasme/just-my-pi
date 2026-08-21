"""Shared stderr logger. `LOG` is a module-level singleton so every other
module reports through the same verbosity setting once main() sets it."""
from __future__ import annotations

import sys
import time


class Log:
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self._t0 = time.time()

    def step(self, msg: str) -> None:
        print(f"==> {msg}", file=sys.stderr)

    def info(self, msg: str) -> None:
        print(f"    {msg}", file=sys.stderr)

    def cmd(self, args: list[str]) -> None:
        if self.verbose:
            print(f"    $ {' '.join(args)}", file=sys.stderr)

    def warn(self, msg: str) -> None:
        print(f"!!  {msg}", file=sys.stderr)


LOG = Log()
