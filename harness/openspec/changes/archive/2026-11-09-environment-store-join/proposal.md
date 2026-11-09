# Proposal

## Why

In the run of analysis GSE136961, `knowledge_recommend` gave `present: false` for DESeq2, edgeR, and jsonlite. The join read only the farm lock of the analysis. The farm of a new analysis links only the packages of its launched plans, thus it held none of the three. The run linked the three packages from the package store two minutes after the plan. Then `list_available_packages` gave `present: true` for edgeR, to the planner and to the conversation agent. Thus the recommend answer and the census did not agree.

## What Changes

- The environment join reads the pool-scope inventory of the package store, the same inventory that `list_available_packages` reads for the planner.
- A package of a step gets one of three states: `installed`, `in_store`, or `absent`. `installed` means that the farm lock or the image record names it. `in_store` means that the store holds it, and the launch links it.
- The pool lookup uses the name resolution of `list_available_packages`, in the track that the service names. Thus the join and the census give one answer.
- When the store holds a name in both tracks, the package carries `entry`, the `packages` entry with its track.
- When the host gives no path of the image record, the join reads the record at the container mountpoint of the store, as `list_available_packages` does.
- When the host binds no pool inventory, or the inventory cannot answer, a package that the sandbox does not hold gets no state.
- `environment_source` gets the `pool` field.
- The description of `knowledge_recommend` names the three states.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the environment join gives three package states from the farm, the image record, and the pool inventory.

## Impact

- `src/tools/knowledge/environment.ts`, `src/tools/knowledge/recommend.ts`, `src/tools/knowledge/index.ts`, `src/tools/knowledge/skeleton.ts`, and `src/tools/research/generate-plan.ts` change. `src/tools/sandbox/list-available-packages.ts` exports `bothTrackNames` and `DEFAULT_IMAGE_PACKAGES_FILE`.
- `StepEnvironment.package` has `state` in place of `present`. Only the model-facing answer carries it, and no plan field stores it.
- `KnowledgeToolsDeps` and `EnvironmentPaths` get the optional `readPoolInventory` field.
- The description of `knowledge_recommend` changes, thus `knowledgeToolDefinitionHash` changes.
- The environment match of a rendered template does not change. It does not read the pool inventory, because a step loads only what its farm links. It reads no default image record, because a list from the record alone would read as the whole farm.
