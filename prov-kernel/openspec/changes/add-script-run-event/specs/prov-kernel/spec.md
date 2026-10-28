## ADDED Requirements

### Requirement: A script run is core format

The core union MUST carry a `script_run` member with the model id and a
script run ref. `applyProvEvent` MUST append one activity,
`inflexa:script-{scriptDigest}`, with the digest of
`{threadId}|{invocationId}`. The activity MUST carry the type
`inflexa:ScriptRun` and no formal time. It MUST be associated with the actor
agent and with the model agent.

#### Scenario: A re-emission merges

- **WHEN** `applyProvEvent` maps the same `script_run` two times
- **THEN** the unified document equals the document of one mapping

### Requirement: A script run chains its files

The script run activity MUST have a `used` edge to the saved script and to each
file that the script read. Each file that the script wrote MUST get its entity,
with the producer `script`, and its generation edge to the activity under the
shared `gen-{fileDigest}` id. The lineage read model MUST classify the activity
as a `script` activity.

#### Scenario: A derived file chains to the table that its script read

- **GIVEN** a `script_run` that read `runs/r1/s1/output/de.csv` and wrote
  `conversation-sessions/t-1/derived/top.csv`
- **WHEN** a lineage walk goes backward from the derived file
- **THEN** the walk reaches the script run activity through the generation
  edge, and the table through the `used` edge
