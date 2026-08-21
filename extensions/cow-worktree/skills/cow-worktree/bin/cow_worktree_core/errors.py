"""The one exception type this wrapper raises for handled failures."""


class CowError(Exception):
    """A fatal, user-facing error. Caught in main() and reported cleanly."""
