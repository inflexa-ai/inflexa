# Inflexa — repository context

Inflexa changes a plain-language analysis request into sandboxed bioinformatics
computation. The computation is reproducible, and it has full provenance.

This file maps the repository. Each subsystem has its own deeper `CONTEXT.md`.

## The product, in one path

A request starts in `cli/`, which is the local host. `cli/` supplies the terminal
UI, the SQLite store, and the authentication.

Then `cli/` uses `harness/`, which is the host-agnostic harness. The harness has
the agent loop and the DBOS durable workflows.

A step with a large computation runs in the `images/sandbox-base/` container. The
container runs the R code and the Python code that the agent writes, against the
data of the user. Then the container sends a report through a callback with an
HMAC signature.

The agent reads the task knowledge from `skills/`. It uses `templates/` to make
the report of the results.

## Subsystem boundaries

- **`cli/` — the embedder.** The local-first host. It connects the capability
  seams of the harness to simple local realizations. Examples are the local
  authentication, the artifact registry on the file system, and the billing that
  does nothing. `cli/` has each host-specific part: the terminal UI, the anchors
  on disk, the SQLite store, and the configuration of the provider and the key.
  Refer to `cli/CONTEXT.md`.
- **`harness/` — the harness.** Host-agnostic. The harness has the seams, and it
  gives local realizations. It never touches a concern of the host directly. It
  also has the agent loop, the sandbox submit and receive protocol, the durable
  workflows, the providers, and the model of the workspace paths. Refer to `harness/CONTEXT.md`
  and `harness/openspec/specs/`.
- **`prov-kernel/` — the provenance format kernel.** It publishes `@inflexa-ai/prov-kernel`:
  the PROV dialect vocabulary, the document model, and the chain and signature
  primitives. The harness emits observation hooks. Each host owns its recorder
  and consumes this kernel.
- **`skills/` and `templates/` — shared runtime content.** The harness reads them
  at runtime. They are not code, and no package holds them. They are at the root,
  thus the two hosts load the same content.
- **`images/sandbox-base/` — the execution boundary.** One sandbox image for each
  step. Its Go `sandbox-server` is the counterpart of the sandbox client in the
  harness.

## Why this split

The harness runs under any host. Thus the open-source product `cli` and a managed
deployment can share one harness, and they are different only at the seams. Refer
to [`harness/openspec/specs/harness-durable-runtime`](./harness/openspec/specs/harness-durable-runtime/spec.md).

`cli`, `harness`, and `prov-kernel` are independent. They have different lockfiles, and
the root has no workspace. This independence keeps the boundary correct: the host uses the
harness through its published package, and the harness never uses the host.
