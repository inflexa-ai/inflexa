# Inflexa — repository context

Inflexa turns a plain-language analysis request into sandboxed, reproducible bioinformatics computation with full provenance. This file maps the repository; each subsystem keeps its own deeper `CONTEXT.md`.

## The product, in one path

A request enters through **`cli/`** (the local host: TUI, SQLite, auth), which drives **`harness/`** (the host-agnostic harness: agent loop + DBOS-durable workflows). Compute-heavy steps run inside the **`images/sandbox-base/`** container, which executes generated R/Python against the user's data and reports back over an HMAC-verified callback. The agent loads task knowledge from **`skills/`** and renders results with **`templates/`**.

## Subsystem boundaries

- **`cli/` — the embedder.** The local-first host that wires the harness's capability seams to trivial local realizations (local auth, filesystem artifact registry, no-op billing). Owns everything host-specific: the terminal UI, on-disk anchors, the SQLite store, provider/key config. See `cli/CONTEXT.md`.
- **`harness/` — the harness.** Host-agnostic: declares seams and ships local realizations, never reaching a host concern directly. Owns the agent loop, the sandbox submit/recv protocol, the durable workflows, the providers, and the workspace path model. See `harness/CONTEXT.md` and `harness/openspec/specs/`.
- **`skills/`, `templates/` — shared runtime content.** Read by the harness at runtime; not code, not packaged. They live at the root, not inside either package, so both hosts load the same content.
- **`images/sandbox-base/` — the execution boundary.** The single sandbox image for every step; its Go `sandbox-server` is the protocol counterpart to the harness's sandbox client.

## Why this split

`harness` is written to run under any host, so the OSS product (`cli`) and a managed deployment can share one harness and differ only at the seams — see [`harness/openspec/specs/harness-durable-runtime`](./harness/openspec/specs/harness-durable-runtime/spec.md). The independence of `cli` and `harness` (separate lockfiles, no root workspace) keeps that boundary honest: the host depends on the harness through its published package surface, never the reverse.
