## 1. Implementation

- [x] 1.1 Add `createWorkspaceReadLineage`, which resolves a read to its analysis-relative path and hash, and tracks the reads of a call in the collector.
- [x] 1.2 Give `read_file` and `grep` an optional read lineage. Attach the reads as the call record, and fold them into the collector.
- [x] 1.3 Give `read_pdf` an optional read lineage, and fold its `reads` into the collector from a script.
- [x] 1.4 Wire the read lineage from the step collector in `createSandboxAgent`.
- [x] 1.5 Tests: a data read, a window read of a dependency, a refused sibling read, a grep, one key for an exec and a read, and `read_pdf` in a script.
