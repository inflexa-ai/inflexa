# Proposal

## Why

Some harness specs describe behavior that the code does not have. A reader that trusts such a spec designs against a tool, a field, or a step that does not exist. This change makes each of these specs state the code as it is.

The change also records one fix of the code. The conversation agent wrote under the staged inputs, which the storage layout calls immutable. Its mutator now refuses that write.

## What Changes

- `run-event-stream`: the synthesis runs in the body of the run workflow, not inside one step. Each read and each write is a step, and each model call and each tool call is a step. Thus the `at` of a synthesis entry comes from the checkpointed clock, and a replay writes no entry again. The rule that a reader merges two entries with the same id goes, because the body writes no entry two times.
- `run-synthesis-outcome`: the code has no `validationAttempts` and no count of the `submit_synthesis` refusals. The requirement of that telemetry goes. The requirement of the skip warn returns under a new name, without the telemetry.
- `literature-search`: the code has one `pubmed` tool with an `action` of `search`, `details`, or `fulltext`. The three tool requirements become the three action requirements, with the inputs, the defaults, and the outputs of the code.
- `chembl-tools`: the code has one `chembl` tool with an `action` of `compounds`, `drug`, `mechanism`, `bioactivity`, or `targets`. The five tool requirements become the five action requirements, with the `limit` defaults of the code.
- `pubchem-tools`: the code has one `pubchem` tool with an `action` of `compound`, `crossrefs`, or `assays`. The three tool requirements become the three action requirements. By default, the `assays` action keeps only the active assays, and its `limit` is 25.
- `harness-workspace-tools`: the session-scoped mutator refuses a write or an edit under `data/inputs/` with the `read_only` data variant and a reason. The landing also refuses a symbolic link that aims into the staged inputs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `run-event-stream`: "Each activity emission carries its time and keeps its history".
- `run-synthesis-outcome`: "A non-fatal synthesis skip is logged" replaces "Non-fatal synthesis skips are logged". "Validation-rejection telemetry is captured and surfaced" goes.
- `literature-search`: the requirements of `search_pubmed`, `get_article_details`, and `get_article_full_text` get the names and the text of the three actions of `pubmed`.
- `chembl-tools`: "ChEMBL tools wrap the ChEMBL REST API", the five tool requirements, and "Error handling, retry, and timeout".
- `pubchem-tools`: the three tool requirements, and "Cheminformatics agent teaches PubChem as Mode C".
- `harness-workspace-tools`: "The conversation agent holds the write pair confined to the analysis root".

The Purpose of `literature-search`, `chembl-tools`, and `pubchem-tools` still names the split tools. An OpenSpec delta cannot change the Purpose of a spec that exists, thus this change does not touch it.

`workspace-layout` says that each surface treats the whole `data/` tree as read-only. The conversation agent can still write under `data/` outside `data/inputs/`. This change refuses only the staged inputs.

### The overlap with the open changes

- `add-script-tools` modifies one requirement of `literature-search`, of `chembl-tools`, and of `pubchem-tools`: the requirement that names the consumers of the tool. This change does not touch those requirements, and it names the same merged tools.
- `remove-literature-reviewer` modifies the same requirement of `literature-search`. This change does not touch it.
- `trim-conversation-prompt` modifies "Conversation guidance treats synthesis as present only when produced" of `run-synthesis-outcome`. This change does not touch it.

An archive of this change before the open changes and an archive after them give the same specs.

## Impact

- `harness/src/tools/workspace/mutator.ts`: the `read_only` variant and the refusal of the staged inputs.
- `harness/src/workspace/paths.ts`: `STAGED_INPUT_ROOT`, which `harness/src/tasks/data-profile.ts` also uses.
- `harness/src/tools/workspace/write-file.ts` and `harness/src/tools/workspace/edit-file.ts`: the descriptions name `read_only`.
- `harness/src/tools/workspace/test/mutator.test.ts`: the tests of the refusal.
- The other deltas change no code.
