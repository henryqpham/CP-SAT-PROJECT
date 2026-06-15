"""CP-SAT playground. Run: python scratch/play.py

Mess around here freely, then port what works into src/cpsat_scheduler/.
"""

from ortools.sat.python import cp_model

# 1. A model holds your variables and rules.
model = cp_model.CpModel()

# 2. A variable: when does "sail" start? Minutes since midnight, somewhere in the day.
sail_start = model.new_int_var(0, 24 * 60, "sail_start")

kite_start = model.new_int_var(0, 24 * 60, "kite_start")

# 3. Rules (constraints): leave no earlier than 08:00, and a 2h sail must finish by 22:00.
SAIL_MIN = 120
model.add(sail_start >= 8 * 60)
model.add(sail_start + SAIL_MIN <= 22 * 60)


KITE_BOARD = 90
model.add(kite_start >= 8 * 60)
model.add(kite_start + KITE_BOARD <= 22 * 60)


kite_iv = model.new_fixed_size_interval_var(kite_start, KITE_BOARD, "kite_iv")
sail_iv = model.new_fixed_size_interval_var(sail_start, SAIL_MIN, "sail_iv")
model.add_no_overlap([sail_iv, kite_iv])


# 4. Solve, then read the answer back out.
model.minimize(sail_start + kite_start)
solver = cp_model.CpSolver()
status = solver.solve(model)

if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
    start = solver.value(sail_start)
    kite_start = solver.value(kite_start)
    print(f"sail starts at {start // 60:02d}:{start % 60:02d}")
    print(f"kite starts at {kite_start // 60:02d}:{kite_start % 60:02d}")
else:
    print("no solution:", solver.status_name(status))

