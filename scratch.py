# Throwaway experiment. The loop: build -> solve -> print -> break it.
# Hardcode a few activities here; don't load the YAML yet. Once this works,
# port the clean version into solver.py.

from ortools.sat.python import cp_model

# Times in minutes from midnight. 08:00 = 480, 22:00 = 1320.
HORIZON = 24 * 60
DURATION = {"drive_to_lake": 90, 
            "sail": 120, 
            "drive_home": 90,
            "eat_lunch": 30,
            "surfing": 60,
            }

model = cp_model.CpModel()

# TODO 1: for each activity make a start var + a fixed-size interval.
#   start = model.new_int_var(0, HORIZON, f"start_{name}")
#   ival  = model.new_fixed_size_interval_var(start, dur, f"ival_{name}")

SAIL_BOAT = model.new_int_var(0, HORIZON, "sail_boat")
SURFING = model.new_int_var(0, HORIZON, "surfing")
DRIVE_TO_LAKE = model.new_int_var(0, HORIZON, "drive_to_lake")
DRIVE_HOME = model.new_int_var(0, HORIZON, "drive_home")
EAT_LUNCH = model.new_int_var(0, HORIZON, "eat_lunch")

sail_boat = model.new_fixed_size_interval_var(SAIL_BOAT, DURATION["sail"], "sail_boat_ival")
surfing = model.new_fixed_size_interval_var(SURFING, DURATION["surfing"], "surfing_ival")
drive_to_lake = model.new_fixed_size_interval_var(DRIVE_TO_LAKE, DURATION["drive_to_lake"], "drive_to_lake_ival")
drive_home = model.new_fixed_size_interval_var(DRIVE_HOME, DURATION["drive_home"], "drive_home_ival")
eat_lunch = model.new_fixed_size_interval_var(EAT_LUNCH, DURATION["eat_lunch"], "eat_lunch_ival")

# TODO 2: model.add_no_overlap([...])   # never two activities at once
model.add_no_overlap([sail_boat, surfing, drive_to_lake, drive_home, eat_lunch])

# TODO 3: time windows, e.g.
#   model.add(start_drive_to_lake >= 480)
#   model.add(end_drive_home <= 1320)
model.add(SAIL_BOAT >= 480)
model.add(DRIVE_TO_LAKE >= 480)
model.add(DRIVE_HOME <= 1320)
model.add(EAT_LUNCH <= 1320)
# TODO 4: solve and print.
#   solver = cp_model.CpSolver()
#   status = solver.solve(model)
#   print(solver.status_name(status))
solver = cp_model.CpSolver()
status = solver.solve(model)
print(solver.status_name(status))