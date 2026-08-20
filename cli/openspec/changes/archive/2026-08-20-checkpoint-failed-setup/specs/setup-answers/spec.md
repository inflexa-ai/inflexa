## MODIFIED Requirements

### Requirement: One answers mechanism resolves every setup question

Setup SHALL define a single answers schema (`SetupAnswers`) covering every interactive decision point of the setup flow — connection mode, direct-connection facts, credential source, model, Postgres fields, resource share, embedding backend and its values, reference selection, sandbox variant, and runtime. Two front-ends populate it: value flags and the `--config` YAML file, resolved per question with the fixed precedence:

```
flag  >  config-file value  >  interactive prompt (TTY, not --yes, and not before the checkpoint)  >  default-or-error (--yes, non-TTY, or a step before the checkpoint)
```

The checkpoint supplies no value. It withdraws the prompt of a step the operator chose to continue past. That step then resolves through the same no-prompt path `--yes` uses. The full rule is below, in "A failed setup records the step it stopped at".

A supplied answer SHALL skip its prompt even in an interactive run, so a partially-filled config file composes with prompts for the remaining questions. A non-TTY run SHALL resolve exactly as `--yes` does. Every persisted value SHALL flow through the same writers the interactive wizard uses — the answers layer changes where values come from, never where they go.

When a MODE-CARRYING flag (`--connection`, `--embeddings`) moves a block's mode away from the file's, the file's leaves that are exclusive to the superseded mode SHALL be dropped from the merged answers and the run SHALL print a note naming each superseded key and the flag that superseded it — an announced drop, never a silent one, and never a hard failure. Mismatches within one source (flag mode against flag leaves, or file mode against file leaves) remain upfront errors: a same-source contradiction is an authoring mistake, not an override.

#### Scenario: A flag overrides the config file

- **WHEN** setup runs with `--config fleet.yml` (carrying `postgres.password: a`) and `--postgres-password b`
- **THEN** the resolved answer for the Postgres password is `b`

#### Scenario: A config file answers questions interactively; prompts fill the gaps

- **WHEN** setup runs on a TTY without `--yes`, with a config file answering the connection and Postgres questions but not embeddings
- **THEN** the connection and Postgres prompts are skipped, and the embedding question is still asked

#### Scenario: Non-TTY resolves like --yes

- **WHEN** setup runs without a TTY and without `--yes`
- **THEN** no prompt is attempted and every question resolves through the same default-or-error path `--yes` uses

#### Scenario: A mode flag supersedes the file's dependent leaves

- **WHEN** `setup --yes --config fleet.yml --embeddings off` runs with the file answering `embedding: {mode: api-key, baseURL: …, model: …}`
- **THEN** the resolved embedding answer is `off`, the run prints a note naming `embedding.baseURL` and `embedding.model` as superseded by `--embeddings off`, and setup succeeds

#### Scenario: A same-source mode mismatch still fails

- **WHEN** `setup --yes --embeddings off --embeddings-url https://gw.corp/v1` runs (both answers from flags)
- **THEN** setup fails upfront naming the mismatch, exactly as an all-file mismatch does

## ADDED Requirements

### Requirement: A failed setup records the step it stopped at, and a re-run offers to continue

`inflexa setup` MUST record the name of the step it stopped at, when a run fails after the wizard opens. A run that completes MUST delete that record. Thus the record's presence alone means "the last run failed". No list of finished steps is kept.

The record MUST hold the step name and the version of the binary that wrote it. It MUST live at a channel-aware path under the data dir. Thus a dev failure never redirects the wizard of an installed production binary.

A record whose version is not this binary's MUST resolve to "no checkpoint". A release can add, drop, or reorder a step, thus an old position names a step this build cannot honor. Every other read fault MUST resolve the same way: no file, unreadable bytes, invalid JSON, and a foreign schema. An unreadable record MUST never fail a run.

On a run that can prompt, a record MUST produce ONE question, ahead of the wizard's first question. The two answers are "continue from the recorded step" and "ask everything". A run that cannot prompt MUST never offer. It MUST resolve exactly as it does with no record, thus `--yes` and a non-TTY run are unchanged.

A step BEFORE the chosen continue point MUST still run, and it MUST NOT ask its questions. It MUST resolve its value through the same no-prompt path `--yes` uses. Thus the later steps that consume that value see no difference. A step at or after the continue point MUST ask as it does with no record.

The connection-mode question and the connection block that follows it MUST be skipped as one unit. The direct branch has no no-prompt path, thus a partial skip would ask again for the endpoint, the credential, and the model.

The container work MUST NOT be skipped. A continue rewrites the compose file, starts the stack, and waits on Postgres, exactly as a fresh run does. Those steps read live state, not an answer.

A failed record write MUST warn, and it MUST NOT change the outcome of the run. The run already failed, and the record is an affordance for the next run.

#### Scenario: A late failure records its step

- **WHEN** setup fails at the reference-data step
- **THEN** the record names that step and the version of the binary, and the run names the step back to the operator

#### Scenario: A complete run leaves no record

- **WHEN** setup runs to "Setup complete"
- **THEN** no record is on disk, and the next run asks every question

#### Scenario: A record from another version is ignored

- **GIVEN** a record written by a different version of the binary
- **WHEN** setup runs
- **THEN** no continue is offered, the run proceeds as a fresh one, and a complete run deletes the record

#### Scenario: A continue silences the steps before it

- **GIVEN** a record naming the reference-data step
- **WHEN** an interactive setup runs and the operator chooses to continue
- **THEN** the connection and Postgres questions are not asked, their persisted values are resolved, and the reference-data step still asks

#### Scenario: Start again asks everything

- **GIVEN** a record naming the reference-data step
- **WHEN** an interactive setup runs and the operator chooses to start again
- **THEN** every question is asked, and a complete run deletes the record

#### Scenario: A batch run never offers to continue

- **GIVEN** a record naming any step
- **WHEN** `setup --yes` runs
- **THEN** no question is asked, every step resolves through its batch path, and the run exits as it does with no record
