## Context

The house rules of `src/lib/result.ts` model a failure as a value. A storage accessor gives `ResultAsync<_, DbError>` through `tryQuery` or `tryMutation` (`src/lib/db-result.ts`). A workflow body or a step body changes an `err` into a throw with `unwrapOrThrow`. Other code keeps the Result.

`runDataProfile` and `triggerDataProfile` are API entry points. A host calls them from an HTTP route or from a CLI command. Before this change, `runDataProfile` rejected on a failed start and resolved on a refusal. `triggerDataProfile` caught each fault and gave `"failed"`.

## Goals / Non-Goals

**Goals:**

- A caller of `runDataProfile` gets a refusal and a failed start as an `err`.
- A caller of `triggerDataProfile` can tell a refused call from a ledger fault.
- Each artifact accessor obeys the storage rule of its sibling state modules.

**Non-Goals:**

- A change to the ledger writes of the trigger, of the run, or of the body.
- A change to the fire-and-forget dispatch of `triggerDataProfile`.
- A change to the SQL of an artifact accessor.

## Decisions

### D1: The trigger keeps the fire-and-forget dispatch

`triggerDataProfile` gives `"started"` or `"restarted"` after the claim, and it does not wait for the authorization or the start. The dispatch settles its own row. Thus a refusal after a claim still shows on the ledger only. The error channel of the trigger is `DbError`: a failed ledger read, a failed claim, or a failed empty-set stamp.

Alternative: wait for the dispatch, and give the refusal as an `err`. This changes when the trigger returns, and a host would get `"started"` or an `err` for one claim. The change keeps the current trigger contract.

### D2: `DataProfileStartError` has no `DbError` variant

`runDataProfile` does not claim. The caller claims with `tryRetryDataProfile` before the call. The compensation of a claimed row stays best-effort: a failed compensation write is logged, and the `err` names the primary cause. The host takes the same action for each variant: it revokes what it minted.

### D3: A rejected `authorize` promise passes through

A hook whose promise rejects has a defect of the host (the `host-hooks` spec). The dispatch settles the claimed row, and then the rejection passes through `runDataProfile` with no change. The trigger logs the defect and drops it, because its dispatch is fire-and-forget. Only the throw of `DBOS.startWorkflow` becomes `start_failed`.

### D4: `refused` carries the fields of the host

The variant carries `reason` and `suspend`, the two fields of `GateFailure`. The package root exports `GateFailure` but not `GateRefusal`. Thus a host reads the variant with the vocabulary of its own hook.

### D5: The registration names a failed ledger write

`registerStepArtifacts` keeps its `Promise<Result<…>>` shape, and its error union gets a tag: `{ kind: "refused"; refusal }` or `{ kind: "ledger_failed"; error: DbError }`. `StepRegistrationFailure` extends that union with `rejected`. The sandbox step fails with `lineage_attestation` for each variant that does not suspend, the same class that a driver throw gave.

## Risks / Trade-offs

- [An embedder that awaits one of the changed functions and reads the value directly] → The compiler rejects the old use, because each return type changes. The proposal marks each change as breaking.
- [A refusal on the trigger path still reaches the host only through the ledger] → D1 keeps this. A host that must revoke on a refusal can claim and call `runDataProfile`.
