## 1. The server

- [x] 1.1 Run the turn engine over `ChatTurns`: open, read the frames, stop on the abort, and map `outcome`.
- [x] 1.2 Register a turn when it opens, and let a stop of the server wait for a turn that still opens.
- [x] 1.3 Refuse a thread with a turn that runs with 409 `conflict`.
- [x] 1.4 Add `GET {T}/turns/:turnId/stream`.
- [x] 1.5 Answer an ask through `chatTurns.answer`.
- [x] 1.6 Take the failure of a turn from its code and its text.

## 2. The tools and the runtime

- [x] 2.1 Move the approval of `run_inflexa` and `manage_inputs` to the approval hook, and make sure of the input again in `execute`.
- [x] 2.2 Give the local credential for a recovered turn, and the pool and the logger to the run launcher.

## 3. The TUI

- [x] 3.1 Read a turn again after a lost connection, and apply each frame one time.

## 4. Verification

- [x] 4.1 Run the CLI typecheck, the lint, and the tests of the changed files against the linked harness.
