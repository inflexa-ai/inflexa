## Context

The third real session (`report-improvements.v3.md`, thread `27d549b7`) ran on the round-two machinery and proved it. The remaining faults concentrate in five places. The version store refuses the amend loop. The reference surfaces split into two notations. The volcano preset lacks its standard semantics. One dense chart dominates the page bytes. And the authoring input still exposes a hash that the snapshot owns. The prompt and the look checklist trail the new mechanisms.

## Goals / Non-Goals

**Goals:**

- The unbounded amend loop: record, amend, record again, with one version per thread.
- One reference notation and one References appendix.
- The standard volcano from the preset alone, with declared thresholds.
- No giant inline chart option, and a walkable derivation chain on the page.
- The hash leaves the authoring surface.

**Non-Goals:**

- No payload compression (the ~10 MB arm stays recorded and later).
- No hosted view work, and no cli work — the transcript-duration item is its own cli change.
- No version history ladder: one thread keeps one version, and the session chain is the history.

## Decisions

- **The re-record replaces whole, under the same version id.** The store updates the one row of the thread inside the unique constraint, and the record reports created or replaced. The refuse-forever alternative left the stored version diverging from the page, which the third session proved. The version-per-record alternative breaks the one-per-thread lock and bloats the store. The purge footprint does not change.
- **One ladder, one appendix.** The render keeps one counter over both reference kinds, keyed by the existing identities: the stable serialization for an artifact, the citation key for a paper. Entries list flat in number order with kind tags, because a grouped list would shuffle the numbers. The two-section alternative keeps two notations, which is the confusion itself.
- **The volcano classification lives in the preset expansion.** It is per row, against the same threshold pair that draws the guides, thus the colors always land on the lines. The null series takes the muted color by construction. The declared `thresholds` member on the block feeds both surfaces, thus the corrected-significance volcano is one declaration. The agent-side derivation route stays possible, and it is no longer necessary for the standard look.
- **The label flags route per series.** The top-N flags attach to the rows, and the split distributes each flagged row into its own series. This fixes the zero-label defect of the grouped scatter.
- **The density ladder holds two design-source constants.** The hover tier keeps the larger hit symbol at the existing row threshold. The crowd tier, near ten thousand rows, takes a small symbol with reduced opacity. One size cannot serve both scales, and the third session proved the blob.
- **The chart reads the shared payload past an inline bound.** The bound is a design-source constant near 100 KB of serialized option. Past it, the chart reads the registered columnar payload of its artifact, and a table over the same artifact shares that payload. The label rides as a column index. The page stays `file://`-first with classic scripts, and a small chart stays byte-identical.
- **The payload carries the pre-bound total.** The resolution knows the artifact row count before the bound applies, and the footer prints `N of M rows` from it.
- **The derivation script stages as a content-addressed asset.** The record holds the script text, thus the stage writes it beside the page and the chain links it. The sweep governs it as any asset. The chain also links the derived output, which sits inside the session directory already.
- **The manifest statics move under `assets/deps/`.** The manifest entry carries the subpath, thus the renderer, the stage, and the embedder read one source. No compatibility shim: nothing released consumes the old layout.
- **The hash leaves the authoring input.** The input schemas drop the field, a supplied hash drops before the stamp, and `read_block` elides the stored hashes. The stored reference keeps its stamped hash, thus `report-grounding` does not change. The mistype of the third session becomes unrepresentable.
- **The formatter prints the typographic minus** in shown forms alone, and raw text rides the `title` attribute as before.

## Risks / Trade-offs

- [A re-record race between two processes.] → The unique row and the gate bound it: the last gate-passed record wins whole, and no partial state is representable.
- [The payload sharing could drift between the table view and the chart boot.] → One payload derivation feeds both. The byte-identical rule of the payload extends to the chart path.
- [The crowd tier changes the bytes of existing dense charts.] → Intended, and the spec scenario states the new form. No released consumer pins the old bytes.
- [The prompt grows again.] → The pass trims each line that a mechanism now enforces. For example, the hash-probe wording narrows once the field is gone.

## Open Questions

None.
