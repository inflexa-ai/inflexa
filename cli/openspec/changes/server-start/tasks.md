## 1. Commands

- [x] 1.1 Replace `inflexa serve` with `inflexa server start`, which runs the background start, with the hidden child flags. Done when: the policy snapshot shows `inflexa server start` as `blocked` and no `inflexa serve`.
- [x] 1.2 Start the detached child and the client start with `server start`. Done when: the child flag test finds the flags on `server start`.

## 2. The foreground mode

- [x] 2.1 Remove the foreground mode of the server and the re-run with a larger file pool. Done when: the registry has no `serve` command, and the detached child still gets the pool in its environment.

## 3. Verification

- [x] 3.1 Run the full CLI suite one time. Done when: the suite passes.
