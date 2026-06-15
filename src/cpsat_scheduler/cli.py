"""Command-line interface: python -m cpsat_scheduler {list,solve,compare}."""

from __future__ import annotations


def main(argv: list[str] | None = None) -> int:
    # Wire up argparse with three subcommands, then dispatch:
    #   list                  -> data_loader.list_scenarios
    #   solve <scenario>      -> scenario.run_scenario + save_result, print the schedule
    #   compare <a> <b>       -> compare.format_diff over two saved results
    # Tip: on Windows, sys.stdout.reconfigure(encoding="utf-8") avoids unicode print errors.
    raise NotImplementedError


if __name__ == "__main__":
    raise SystemExit(main())
