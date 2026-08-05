# Download the CI-built package store from GHCR, and gate sandbox creation on it

## Why

The harness change `content-addressed-lib-store` publishes the package store to GHCR as an OCI artifact, one for each architecture (decided 2026-08-05). No path brings that artifact onto a user machine. The mount half is also blind to a half-arrived store: `libStoreUsable` reports false for an incomplete store, and the harness then drops the mount with a warning only. With a background download, "incomplete" becomes a normal temporary state. An analysis that starts too early then runs a sandbox with no packages, and nothing tells the user.

The app also blocks at open today: `src/tui/app.launch.tsx:48` and `src/modules/harness/chat.ts:96` both wait for the image pull. A user cannot say anything until a multi-gigabyte download completes. A second large download must not make that worse. Chat, the workspace read surface, and the planner do not use a sandbox, thus they must start at once.

## What Changes

- **The CLI pulls the store artifact from GHCR.** The pull is an anonymous token GET, then a manifest GET, then one digest-verified blob GET per layer, all over https. The blob GET goes through `downloadToFile`, with the bearer token in the injectable `fetch` seam. The returned sha256 must equal the descriptor digest, or the layer is refused.
- **The download runs at app open, in the background.** It uses the receipt pattern of `src/modules/refs/store.ts`: stage, rename, then receipt, so a crash reads back as incomplete and the next run repairs it.
- **A gate holds each action that makes a sandbox** until the receipt reports a complete store. The gate reports the state to the user while it holds. The same gate covers the sandbox image pull. The app itself starts at once.
- **The download is configured off by default.** A rollback clears the key. With the key unset, nothing downloads and nothing changes.

## Capabilities

### New Capabilities

- `lib-store-download`: the GHCR artifact pull, the digest verification, the receipt-backed background download, and the gate that holds sandbox creation until the store is complete.

### Modified Capabilities

- `lib-store-provisioning`: launch no longer blocks on a required image. The wait moves behind the gate, to the first action that makes a sandbox.
- `chat-wiring`: the chat turn starts without a wait for the image pull. The confirm-and-pull moment moves behind the gate.

## Impact

- `src/lib/download.ts`: consumed as-is. The bearer token rides the injectable `fetch`, and the utility itself does not change.
- New download module beside `src/modules/libs/pull.ts`: the registry client (token, manifest, blob), the receipt, and the gate.
- `src/tui/app.launch.tsx:48` and `src/modules/harness/chat.ts:96`: the app-open block on the pull is removed, and the gate replaces it.
- The store-root config key is shared with the sibling change `lib-store-mount-and-provisioning`, which owns it.
- Depends on the harness change `content-addressed-lib-store` for the published artifact (the `lib-store-build` delta and its tasks section 10).

Out of scope: the CI publish (the harness change), the mount and the provisioning commands (the sibling change), the managed service (decoupled, 2026-08-05), and the farm-subset fetch (roadmap §8.8, later).
