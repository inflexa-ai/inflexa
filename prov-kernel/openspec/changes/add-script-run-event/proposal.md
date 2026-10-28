# Record a script run as core format

## Why

The conversation agent runs short JavaScript scripts with `run_script`. A
script reads tables of the workspace and writes derived files. A reply can
cite a derived file as evidence. Thus the document must chain a derived file
to the script and to the tables that the script read. The dialect has no event
for this. A `file_written` call write has no `used` edge, and a report
derivation keeps its sources as attributes that the lineage walk does not
follow.

## What Changes

- The core union gains `script_run`. Its payload is the model id and a
  `ProvScriptRunRef`: the invocation id, the optional thread id, the optional
  saved script, the files that the script read, the files that it wrote, the
  tools that it called, and `ok`.
- `applyProvEvent` appends a deterministic activity,
  `inflexa:script-{scriptDigest}`, with the type `inflexa:ScriptRun` and no
  formal time. The digest keys on the thread and the invocation id.
- The activity uses the saved script and each file that the script read. Each
  file that the script wrote gets its entity and its one generation edge under
  the shared `gen-{fileDigest}` id. The producer of such a file is `script`.
- The lineage read model classifies the activity as a `script` activity.
- `SPEC.md` states the new rules.

## Impact

- Code: `src/types.ts`, `src/events.ts`, `src/document.ts`, `src/lineage.ts`,
  `src/index.ts`, and their tests.
- A host that maps the event records the lineage of a script. A host that does
  not map it records nothing new. The golden fixture does not change.
