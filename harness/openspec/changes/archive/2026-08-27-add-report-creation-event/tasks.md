# Tasks — add-report-creation-event

## 1. The vocabulary

- [x] 1.1 Add the `create-session` member to `ReportObservationEvent`, with the kind and the parent
- [x] 1.2 Keep the module comment honest: nine acts, the kind, and the parent

## 2. The emit at the two creation sites

- [x] 2.1 Add the optional observation seam to `ReportSessionSpawnDeps`
- [x] 2.2 Emit through `bindReportObservation` at the spawn, after the child lands
- [x] 2.3 Add the optional observation seam to `PrepareChatTurnDeps`
- [x] 2.4 Emit in the turn, on the branch alone that writes a new conversation thread
- [x] 2.5 Pass the seam from the composition root to the spawn, through the start tool

## 3. Verification

- [x] 3.1 Cover a bound seam, an unbound seam, and a refused spawn in the spawn suite
- [x] 3.2 Cover the one emit of a new thread, and the silence of a thread that exists
- [x] 3.3 Run the touched files, `bun run format:file`, and `tsc --noEmit`
