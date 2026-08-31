# Proposal: store-add-raw-name

## Why

`store add GO.db --lang r` fails, because the flight applies the PEP 503 rule to the name and sends `go-db` to the installer. An R name is case-sensitive, and it can carry dots, thus pak resolves nothing. Worse, an add without `--lang` probes the R side with the mangled name, thus the both-hit guard cannot arm. A PyPI package under the mangled spelling would then install silently in place of the R package.

## What Changes

- A request carries two names. The raw spelling of the user rides the pending row, the flight row, and the provisioner spec. The canonical form stays the identity for the keys, the pool, and the graph.
- The installer receives the raw spelling. The provisioner already probes each ecosystem in its own spelling, thus no provisioner change is necessary.
- Every render shows the raw spelling: the sidebar pipeline, `store ls`, the refusal messages, and the both-hit ask.
- One additive migration: a `raw_name` column on `pending_store_adds` and on `package_store_flights`, with the canonical name as the backfill.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `package-store-management`: the request gains the two-name contract, and the ecosystem search gains the own-spelling rule.
- `farm-composition`: the canonical name gets its boundary — a lookup identity, never an installer ref.

## Impact

- `src/modules/libs/store_flight.ts`: the spec type, the enqueue, the batch, the provisioner spec, and the messages.
- `src/db/primary_migrations.ts`, `src/db/primary_query.ts`, `src/db/primary_mutation.ts`, `src/types/store.ts`: the `raw_name` column and its carriage.
- `src/tui/hooks/sandbox_gate.tsx` and `src/modules/libs/store.ts`: the renders.
- The provisioner (`images/sandbox-provisioner`) stays untouched.
