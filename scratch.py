# Throwaway experiment. The loop: build -> solve -> print -> break it.
# Hardcode a few activities here; don't load the YAML yet. Once this works,
# port the clean version into solver.py.

from ortools.sat.python import cp_model

# Times in minutes from midnight. 08:00 = 480, 22:00 = 1320.
HORIZON = 24 * 60
DURATION = {"drive_to_lake": 90, "sail": 120, "drive_home": 90}

model = cp_model.CpModel()

# TODO 1: for each activity make a start var + a fixed-size interval.
#   start = model.new_int_var(0, HORIZON, f"start_{name}")
#   ival  = model.new_fixed_size_interval_var(start, dur, f"ival_{name}")

# TODO 2: model.add_no_overlap([...])   # never two activities at once

# TODO 3: time windows, e.g.
#   model.add(start_drive_to_lake >= 480)
#   model.add(end_drive_home <= 1320)

# TODO 4: solve and print.
#   solver = cp_model.CpSolver()
#   status = solver.solve(model)
#   print(solver.status_name(status))
