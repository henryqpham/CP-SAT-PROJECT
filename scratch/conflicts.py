"""Which rules conflict? CP-SAT can name them, not just say "INFEASIBLE".

Run with the venv python:  python scratch/conflicts.py
"""

from ortools.sat.python import cp_model

model = cp_model.CpModel()

# One variable: what time do we leave? (minutes since midnight)
leave = model.new_int_var(0, 24 * 60, "leave")

# The trick: give each rule an on/off switch (a bool). The rule only applies when its
# switch is true. Then we ASSUME every switch is on and ask which ones can't all hold.
c1 = model.new_bool_var("c1")
c2 = model.new_bool_var("c2")
c3 = model.new_bool_var("c3")

labels = {
    c1.index: "CON-001: leave no earlier than 08:00",
    c2.index: "sail first thing at 07:00",
    c3.index: "leave no later than 20:00",
}

# .only_enforce_if(switch) = "this rule counts only if its switch is on".
model.add(leave >= 8 * 60).only_enforce_if(c1)
model.add(leave == 7 * 60).only_enforce_if(c2)   # conflicts with c1
model.add(leave <= 20 * 60).only_enforce_if(c3)  # innocent — fits with either

# Turn every rule on, then solve.
model.add_assumptions([c1, c2, c3])
solver = cp_model.CpSolver()
status = solver.solve(model)

if status == cp_model.INFEASIBLE:
    print("INFEASIBLE - these rules can't all hold at once:")
    for idx in solver.sufficient_assumptions_for_infeasibility():
        print("   -", labels[idx])
else:
    print("Feasible. leave =", solver.value(leave))
