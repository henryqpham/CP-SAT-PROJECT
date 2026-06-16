# The real model lives here once scratch.py works. You write this part —
# it's the CP-SAT you're here to learn. Don't let me fill it in for you.
#
# Shape to aim for:
#   1. load activities.yaml + scenario.yaml (pyyaml)
#   2. one interval var per activity
#   3. constraints: no_overlap, time windows, "no kite -> sail twice as long"
#   4. an objective (e.g. minimize when you get home), then solve + print
#
# CP-SAT toolbox: CpModel, new_int_var, new_interval_var,
# new_fixed_size_interval_var, add_no_overlap, only_enforce_if,
# add_max_equality, minimize, CpSolver().solve(model).


def solve():
    raise NotImplementedError("Write the CP-SAT model here.")


if __name__ == "__main__":
    solve()
