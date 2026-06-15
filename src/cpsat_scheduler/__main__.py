"""Entry point for ``python -m cpsat_scheduler``."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
