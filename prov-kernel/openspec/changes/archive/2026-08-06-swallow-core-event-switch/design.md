## Context

The create-prov-kernel-package change kept every event vocabulary out of the
kernel: hosts map their events onto the builders. In practice the two hosts
converged on one identical nine-event union and one identical switch — the
Cortex recorder's `appendEvent` and the CLI equivalent dispatch the same
variants onto the same builders in the same order. The duplication is not a
host freedom; it is one piece of format written twice.

The distinction that the original boundary missed: the switch does not decide
*when* to record or *what to do on failure* — it decides *which statements a
fact becomes*. Statement choice and statement order are document bytes, and
the chain hash signs the bytes.

## Goals / Non-Goals

Goals:

- One switch, in the kernel, next to the derivations it feeds.
- The `SPEC.md` "Events" section: the per-event statement contract for an
  independent (Go) writer.
- Unchanged mapping semantics: declaration-before-reference order,
  deterministic relation ids, dedupe of a re-emission under `unified()`.

Non-Goals:

- No recorder lifecycle. The sink, the flush loop, the queue, the CAS
  protocol, and the dirty tracking stay host-owned.
- No emission policy. When a host records, how it contains a builder throw,
  and whether it drops or crashes on a defect are host decisions — the host
  wraps `applyProvEvent` in its own guard.
- No signer wiring and no harness dependency. The `ProvSigner` seam and key
  custody stay as they are.
- No extension events. A host-defined event kind stays outside the union and
  maps onto the exported builders (`appendLifecycleAction` and the statement
  builders).

## Decisions

### The mapping is format

The kernel test for ownership is: does the code determine the serialized
bytes? The switch does — it selects the builders and their order per event.
Thus it moves into the kernel, and the boundary requirement changes from "no
event union" to "the core union and its apply function, and nothing of the
recorder around them".

### The signature is `applyProvEvent(model, doc, event)`

The host reducers already consume exactly this shape: a document model, a
live `ProvDocument`, and one event. The kernel takes the minimal signature
and keeps no document state — the host owns the document's lifetime, its
load, and its persistence.

### The default arm throws

The switch is exhaustive over the union with a `never` default. The default
throws instead of a silent skip: an impossible variant at runtime means a
version skew between a host and the kernel, and the host's guard decides
whether to drop the record or to fail loudly.

### Extension events stay host-mapped

A core event is a fact every Inflexa producer records. A host-specific fact
(for example a CLI-only lifecycle action) does not version the kernel: the
host appends it through the exported builders. The barrel says so in one
line, and the generic `appendLifecycleAction` stays the entry point for
host-defined action kinds.

## Risks / Trade-offs

- **The kernel now versions with the core vocabulary.** A new core event
  bumps the kernel. Accepted: a new *core* event is a format change by
  definition — every producer must append the same statements for it.
- **Hosts must not bypass the switch for core events.** A host that calls the
  builders directly for a core event can drift in order or in arm selection.
  Review guards this at the host side, and the `SPEC.md` "Events" section
  makes the expected statements explicit.
