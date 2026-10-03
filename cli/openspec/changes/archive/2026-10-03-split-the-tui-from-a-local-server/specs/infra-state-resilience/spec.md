## MODIFIED Requirements

### Requirement: Commands are order-independent and self-provisioning

Every infra/provisioning command (`setup`, `up`, the boot of the local server, `sandbox pull`, and the dev `run --plan`, which boots its own runtime) SHALL validate and provision its own preconditions rather than assuming any other command ran first. A client of the local server provisions nothing: the server boot is the gate that its routes depend on. No sequence of commands, executed in any order against any on-disk state — including state the user deleted or half-created and state a container engine manufactured — SHALL produce a state that no product command can recover from.

#### Scenario: `up` before `setup` on a fresh machine

- **WHEN** `inflexa up` runs on a machine where `inflexa setup` has never run and the data dir is absent
- **THEN** the command provisions what it needs (config, compose file, mount sources) and starts the stack, and a subsequent `inflexa setup` completes normally

#### Scenario: Any command after a user clears the data dir

- **WHEN** the user deletes the inflexa data dir and then runs any infra command
- **THEN** the command either converges to a working state or fails with an error naming the exact remediation — it never leaves state behind that wedges a later command
