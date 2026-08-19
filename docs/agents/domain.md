# Domain docs

How the engineering skills consume the domain documentation of this repository
when they explore the codebase.

## Before you explore, read these

- **`CONTEXT.md`** at the root of the repository — the map. It points to the
  `CONTEXT.md` of each subsystem. Read each one that touches your topic.
- **The `CONTEXT.md` of the subsystem** that you work in, for example
  `cli/CONTEXT.md` or `harness/CONTEXT.md`.
- **The OpenSpec specs of that subsystem** — the design decisions live there.
  The three spec trees are `cli/openspec/specs`, `harness/openspec/specs`, and
  `prov-kernel/openspec/specs`. This repository has no `docs/adr/` directory.

If one of these files does not exist, continue in silence. Do not flag the
absence, and do not suggest the creation of the file. The `/domain-modeling`
skill makes a domain doc lazily, when a term or a decision is resolved. In this
repository, a design decision goes into the OpenSpec specs of the subsystem,
not into an ADR file.

## File structure

```
/
├── CONTEXT.md                    ← the map
├── cli/
│   ├── CONTEXT.md
│   └── openspec/specs/           ← decisions of cli
├── harness/
│   ├── CONTEXT.md
│   └── openspec/specs/           ← decisions of harness
└── prov-kernel/
    └── openspec/specs/           ← decisions of prov-kernel (no CONTEXT.md yet)
```

## Use the vocabulary of the glossary

When your output names a domain concept (in an issue title, a refactor
proposal, a hypothesis, a test name), use the term as `CONTEXT.md` defines it.
Do not drift to a synonym that the glossary avoids.

If the glossary does not have the concept, that is a signal. Either you invent
language that the project does not use (think again), or there is a real gap
(note it for `/domain-modeling`).

## Flag a spec conflict

If your output contradicts a spec, surface the conflict explicitly. Do not
override the spec in silence:

> _This contradicts `harness/openspec/specs/<spec>` — but a reopen has value
> because..._
