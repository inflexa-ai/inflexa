## REMOVED Requirements

### Requirement: The planner prompt carries the host resource limits

**Reason**: A plan step carries no resources. The step agent selects the size of its sandbox when it acquires a lease, and the module clamps that size to the per-step ceiling. Thus the planner has no resource value to estimate.

**Migration**: The planner prompt loses its section on the resources and on the timeout of a step. The planner gets no resource policy.

### Requirement: The plan validation enforces the per-step resource ceiling

**Reason**: A plan step carries no `resources`, thus the validation has no declared value to compare with the ceiling. The clamp of the lease request is the only bound.

**Migration**: The shared plan validation takes no resource ceiling. A host that gives `perStep` to the validation, for example the dev plan validation of the CLI, removes that argument.

### Requirement: Resource-infeasible analyses exit via report_blocker

**Reason**: The planner does not reason about the resources of a step. A step agent that cannot do its work in the largest grant reports that with its own `report_blocker`.

**Migration**: None. The planner keeps `report_blocker` for each other cause.
