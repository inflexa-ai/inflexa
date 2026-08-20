## Why

`inflexa setup` asks a long questionnaire, and it holds no memory of where a run stopped. Thus
a failure at the reference-data step or the sandbox step costs the operator every question
before it. The machine is already provisioned up to that point.

Each step is idempotent against `config.json`, so the re-run is not dangerous. It is only
tedious, and the tedium is what makes an operator abandon a half-provisioned machine. A Windows
install that failed at the container step is the reported case. The compose file was the fault,
and every re-attempt re-asked the connection mode, the Postgres user, and the port.

The config cannot supply the memory on its own. `explicitPostgresFields` writes nothing when
every answer equals a default, so "the user accepted the default" and "setup never asked" are
the same document. The wizard needs its own small record.

## What Changes

- **A failed run records the step it stopped at.** The record holds one step name and the
  version of the binary that wrote it. A complete run deletes it, so the file's presence alone
  means "the last run failed".
- **A re-run after a failure offers to continue.** One question, ahead of the wizard's first
  question: continue from the recorded step, or ask everything. A re-run after a SUCCESS is
  unchanged and asks the full questionnaire, which is what a deliberate re-run is for.
- **A step before the continue point still runs, and asks nothing.** It resolves its value
  through the same no-prompt path a batch run takes. Thus the later steps that consume `mode`
  and `pgConn` see no difference.
- **The connection-mode question and the connection block are one skip unit.** The direct
  branch has no no-prompt path, because `collectDirectConnection` can only prompt. A partial
  skip would ask again for the endpoint, the credential, and the model.
- **The container work is never skipped.** A continue rewrites the compose file, starts the
  stack, and waits on Postgres as a fresh run does. Those steps read live state, not an answer.
- **A record from another binary version resolves to "no checkpoint".** A release can add,
  drop, or reorder a step, so an old position names a step this build cannot honor. Every other
  read fault resolves the same way, and an unreadable record never fails a run.

## Impact

- Affected specs: `setup-answers`
- Affected code: `src/modules/infra/setup.ts`, `src/lib/env.ts`
- `env.setupStatePath` is a new channel-aware stack path, so a dev failure never redirects the
  wizard of an installed production binary.
- Batch resolution is untouched. A run that cannot prompt never offers, thus `--yes` and a
  non-TTY run resolve exactly as before.
- `infra-state-resilience` needs no change. A deleted data dir, a truncated file, and a foreign
  schema all resolve to "no checkpoint", which is the convergence that spec already demands.
