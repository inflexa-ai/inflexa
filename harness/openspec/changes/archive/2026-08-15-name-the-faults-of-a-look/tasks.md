## 1. The settled capture

- [x] 1.1 Emulate `prefers-reduced-motion: reduce` in `capturePage`, before the navigation. Make sure that the page object of the chrome connection gives the emulation method.
- [x] 1.2 Extend the capture comments: the design source collapses each transition under the preference, thus the picture shows the final state.
- [x] 1.3 A test where the rig admits it, or a stated reason where the chrome connection blocks one.

## 2. The checklist

- [x] 2.1 Extend the look step of `src/prompts/report-session.ts` with the fault checklist: clipped text, a truncated number, an overflowing card, a raw column name on an axis, an unreadable precision, and invisible content. A found fault is a repair, and never a note.
- [x] 2.2 Extend the prompt assertions of the agent test for the checklist.

## 3. The gates

- [x] 3.1 Run the targeted suites of the touched modules only.
- [x] 3.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
