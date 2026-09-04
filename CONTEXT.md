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
data of the user. The container bakes no analysis package. The host package store
mounts read-only, and the container reads each R package and each Python package
from that store. The host then retrieves the result of the command, and an HMAC
signature covers the report.

The agent reads the task knowledge from `skills/`. It makes the report of the
results in a report session.

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
- **`skills/` — shared runtime content.** The harness reads the skill packs at
  runtime. They are not code, and no package holds them. They are at the root,
  thus the two hosts load the same content.
- **`images/` — the execution boundary, and the package store.** `sandbox-base/`
  is the one runtime image, and each step runs one container of it. Its Go
  `sandbox-server` is the counterpart of the sandbox client in the harness.
  `sandbox-provisioner/` is the network-enabled builder. It writes the host
  package store, and it never sees the data of a user. `package-store/manifest.yaml`
  declares the package set that the published catalog holds. Refer to
  `images/README.md`.

## Why this split

The harness runs under any host. Thus the open-source product `cli` and a managed
deployment can share one harness, and they are different only at the seams. Refer
to [`harness/openspec/specs/harness-durable-runtime`](./harness/openspec/specs/harness-durable-runtime/spec.md).

`cli`, `harness`, and `prov-kernel` are independent. They have different lockfiles, and
the root has no workspace. This independence keeps the boundary correct: the host uses the
harness through its published package, and the harness never uses the host.
