# Tasks

## 1. Consume the harness release

- [x] 1.1 Bump `@inflexa-ai/harness` to 0.23.0 and refresh the lockfile
- [x] 1.2 Bump the cli version to 0.14.0

## 2. Map the part

- [x] 2.1 Add the `report-session` kind to the `Part` union
- [x] 2.2 Add the `readReportSessionStarted` reader beside the other shared readers
- [x] 2.3 Map `data-report-session-started` in the live adapter, with the listing poke
- [x] 2.4 Map `data-report-session-started` on the reload path

## 3. Render the entry

- [x] 3.1 Add `ReportSessionEntry` — the listing join, the absent-row degrade, the in-place open
- [x] 3.2 Add the `report-session` case to the `MessageBlock` switch
- [x] 3.3 Render the unclaimed children at the transcript tail in `Chat`

## 4. Delete the seq-mark placement

- [x] 4.1 Delete `slotFor` and the entry-slot memo from `Chat`
- [x] 4.2 Delete `MessageSeqMark`, the marks signal, its writers, and `seqMarksFor`

## 5. Coverage

- [x] 5.1 Re-anchor the placement render suite on the part; delete the seq-mark unit suite
- [x] 5.2 Cover the two mapping arms (live and reload) in the adapter suite
