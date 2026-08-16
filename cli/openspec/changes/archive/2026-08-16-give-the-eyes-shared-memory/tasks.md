# Tasks: give-the-eyes-shared-memory

## 1. The shared-memory allowance

- [x] 1.1 Add a shared-memory size constant beside `DEFAULT_LIFETIME_SECONDS` in `src/modules/harness/eyes.ts`, with a comment that states why the runtime default loses a full-page capture.
- [x] 1.2 Add `--shm-size` with that constant to the `run` args of the acquire, between the detach flags and the port publication.

## 2. The proof

- [x] 2.1 Extend the run-args assertions in `src/modules/harness/eyes.test.ts`: the composed args carry the shared-memory size.
- [x] 2.2 Run the targeted suite `bun run test src/modules/harness/eyes.test.ts`, and `bun run typecheck`.
