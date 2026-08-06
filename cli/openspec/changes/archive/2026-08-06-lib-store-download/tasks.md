## 1. Registry client

- [x] 1.1 Add the registry client beside `src/modules/libs/pull.ts`: the anonymous token GET, the manifest GET, and the digest-pinned blob GET
- [x] 1.2 Route each blob GET through `downloadToFile`, with the bearer token in the injectable `fetch` seam
- [x] 1.3 Compare the returned sha256 against the descriptor digest, and refuse a blob whose hash differs
- [x] 1.4 Resolve the tag to a manifest digest one time at the start, and use digests only after that
- [x] 1.5 Add a test with a stub `fetch`: the token flow, the redirect acceptance, and the digest refusal

## 2. Receipt and background download

- [x] 2.1 Add the store receipt, with the state model of `refs/store.ts`: stage, rename, then write the receipt
- [x] 2.2 When the store root is configured and the receipt is absent, start the download at app open, after the first-download consent
- [x] 2.3 Ask consent with the size before the first download, inside the TUI, with the precedent of `inflexa sandbox pull`
- [x] 2.4 Add a test: an interrupted download reads back as incomplete, and the next run repairs it
- [x] 2.5 Add a test: no store root configured means no download and no receipt
- [x] 2.6 When the receipt reports `update_available`, report it and wait for the ask. Never download an update silently

## 3. The gate

- [x] 3.1 Add the gate that holds each action that makes a sandbox until the receipt reports a complete store
- [x] 3.2 Cover the sandbox image with the same gate, and report the state and the progress while the gate holds. Render the state through the existing notice and status blocks, with no new widget
- [x] 3.3 Report a failed download at the gate, with the remedy and a retry, and never hold without end
- [x] 3.4 Add a test: a sandbox action during a download holds with a visible state, and no sandbox starts with an empty store

## 4. Launch preamble

- [x] 4.1 Remove the app-open block on the image pull at `src/tui/app.launch.tsx:48` and `src/modules/harness/chat.ts:96`
- [x] 4.2 Move the interactive image confirm-and-pull behind the gate, inside the TUI
- [x] 4.3 Add a test: the app opens and chat responds while the image is absent

## 5. Specs and documentation

- [x] 5.1 Apply the `lib-store-download` spec
- [x] 5.2 Apply the `lib-store-provisioning` delta: launch does not block on the image
- [x] 5.3 Apply the `chat-wiring` delta: the image confirm-and-pull leaves the preamble
- [x] 5.4 Document the store download, the consent prompt, and the gate states
