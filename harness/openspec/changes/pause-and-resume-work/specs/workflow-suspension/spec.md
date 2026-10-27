## REMOVED Requirements

### Requirement: A suspension starts only from a suspend error or from a gate failure with the suspend flag

**Reason**: A suspend error and a gate failure with the suspend flag pause the work now. They are two of the causes of a pause.

**Migration**: Refer to "A failure that a person or time can repair pauses the work" in the `work-pause` capability.

### Requirement: The owner of the result of a workflow selects the mechanism of a suspension

**Reason**: No workflow cancels itself for a suspension. Each workflow waits in place, and work inside a step keeps the refusal as a value.

**Migration**: Refer to "A pause is a durable wait inside the workflow" in the `work-pause` capability.

### Requirement: One function marks the analysis as suspended

**Reason**: The analysis has no suspended state. The row of a pause records the paused work.

**Migration**: A versioned migration moves each analysis row `suspended_insufficient_funds` to `active`. A host lists the paused work with `pausedWork.list`.

### Requirement: A sandbox step sends a typed suspension to its parent

**Reason**: A sandbox step pauses in its own workflow, and the parent waits for its result. The parent cancels no sibling for a pause.

**Migration**: None. The topic `child-suspended` has no reader.

### Requirement: The harness carries the reason of a suspension to each place that records it

**Reason**: The reason of the host goes to the row and to the part of a pause. A run, a step row, and `RunCharge.close` do not end with a suspension.

**Migration**: Refer to "Each waiting workflow writes a row and a part" in the `work-pause` capability.
