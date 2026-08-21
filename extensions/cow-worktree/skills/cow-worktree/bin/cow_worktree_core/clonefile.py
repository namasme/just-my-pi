"""Direct `clonefile(2)` binding via ctypes.

A `/bin/cp -c` subprocess per path would be prohibitively expensive at
the monorepo's ~370k-file scale, so this calls into libSystem directly. There
is intentionally no byte-copy fallback: if clonefile is unavailable or the
volume can't clone, creation fails closed (see references/design.md,
"Limitations")."""
from __future__ import annotations

import ctypes
import os

CLONE_NOFOLLOW = 0x0001

_LIBSYSTEM = ctypes.CDLL(None, use_errno=True)
_CLONEFILE = getattr(_LIBSYSTEM, "clonefile", None)
if _CLONEFILE is not None:
    _CLONEFILE.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    _CLONEFILE.restype = ctypes.c_int

CLONEFILE_AVAILABLE = _CLONEFILE is not None


def clonefile_path(src: bytes, dst: bytes) -> None:
    assert _CLONEFILE is not None
    ctypes.set_errno(0)
    if _CLONEFILE(src, dst, CLONE_NOFOLLOW) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), os.fsdecode(src), os.fsdecode(dst))
