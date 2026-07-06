"""Run the whole test suite with one command: python run_tests.py

Two parts:
  1. backend  — pytest over tests/ (solver, IR, extractors, Flask routes)
  2. UI       — node --test over tests/ui/ (jsdom dashboard flows)

The UI part needs Node plus a one-time `npm install` inside tests/ui (jsdom
stays out of the repo). If Node or jsdom is missing it's reported as SKIP,
and the exit code only reflects the parts that ran.
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> int:
    failed = False

    print("== backend: pytest ==", flush=True)
    r = subprocess.run([sys.executable, "-m", "pytest"], cwd=ROOT)
    failed = failed or r.returncode != 0

    print("\n== UI: node --test (jsdom) ==", flush=True)
    node = shutil.which("node")
    ui_dir = ROOT / "tests" / "ui"
    if node is None:
        print("SKIP: Node is not installed (the UI tests need Node 20+).")
    elif not (ui_dir / "node_modules").exists():
        print("SKIP: jsdom is not installed — run `npm install` once inside tests/ui.")
    else:
        r = subprocess.run([node, "--test", "--test-reporter=spec"], cwd=ui_dir)
        failed = failed or r.returncode != 0

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
