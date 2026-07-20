# Tasks

- [x] Add `format` + `contents` to `ReferenceArtifactSchema`, `organism` to `ReferenceDatasetSchema`
- [x] Populate all catalog datasets and artifacts
- [x] Join catalog metadata (incl. `recommendation.group` as category, organism, per-artifact format/contents) in `enrichEntries`
- [x] Render format and contents in `list_available_refs` content; include them in the query filter
- [x] Pin the artifact key set in tests so an integrity field cannot reappear unnoticed
- [x] Assert every artifact carries a format and a non-restating `contents`, and that single-organism datasets declare an organism
