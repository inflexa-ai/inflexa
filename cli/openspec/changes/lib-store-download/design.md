## Context

The harness change `content-addressed-lib-store` publishes the store to GHCR as an OCI artifact, one for each architecture (decided 2026-08-05). The CLI must bring it onto the user machine. Two proven patterns exist in this codebase. `src/lib/download.ts` gives `downloadToFile`: https only, a sha256 record, a stage path, then an atomic rename. `src/modules/refs/store.ts` gives the receipt pattern, with the states `missing`, `installed`, `update_available`, `partial`, and `invalid_receipt` (`store.ts:47`).

Today the app blocks at open: `src/tui/app.launch.tsx:48` and `src/modules/harness/chat.ts:96` wait for the image pull. The harness side is blind to a half-arrived store: `libStoreUsable` (`docker-client.ts:126`) reports false, and the mount drops with a warning only (`docker-client.ts:285`).

## Goals / Non-Goals

**Goals:**

- The store arrives without a container engine, over https, with each byte digest-verified.
- The app starts at once. Chat, the workspace read surface, and the planner do not wait.
- No sandbox starts against an incomplete store. The wait is visible, and it names its reason.
- A rollback is one cleared config key.

**Non-Goals:**

- The CI publish. The harness change owns it (the `lib-store-build` delta, tasks section 10).
- The mount, the inventory source, and the provisioning commands. The sibling change `lib-store-mount-and-provisioning` owns them.
- The managed service. It is decoupled (2026-08-05), and no decision here waits for it.
- The farm-subset fetch (roadmap §8.8). This change downloads the whole store.

## Decisions

**Pull with a small registry client, not with docker and not with ORAS.** The pull is three https steps: an anonymous token GET, a manifest GET, and one blob GET for each layer. A blob GET is a plain https download, thus `downloadToFile` serves it as it is. The client is roughly one hundred lines. A docker dependency would drag the engine into a path that must run before any container exists.

**Do not change `downloadToFile`.** The bearer token rides the injectable `fetch` seam (`options.fetch`), because the utility itself sends no headers. GHCR answers a blob GET with an https redirect to a GitHub CDN host, and the `insecure_redirect` check accepts an https redirect. The returned sha256 compares against the descriptor digest, thus the caller owns the verification, as the utility documents.

**Resolve the tag one time, then pin the digest in the receipt.** A `latest` tag can move during a download. The client resolves the tag to a manifest digest at the start, and every later fetch uses digests only. The receipt records the manifest digest, thus a check against the receipt is exact.

**Adopt the receipt pattern of the reference store.** Stage, rename, then write the receipt. A crash reads back as incomplete, and the next run repairs it. This is proven in `refs/store.ts`, and it wants no invention.

**Gate the sandbox actions, not the app.** Chat, the workspace read surface, and the planner use no sandbox, thus they must start at once. Each action that makes a sandbox waits on the receipt, with a visible state. The same gate covers the image pull, which removes the app-open block at `app.launch.tsx:48` and `chat.ts:96`. The alternative — block the app — is what makes the current pull painful, and a second download would double it.

**Ask consent before the first multi-gigabyte download.** `inflexa sandbox pull` sets the precedent: a large, network-touching action confirms its size on first use. The first store download asks one time. A later update of an installed store runs in the background without a new prompt.

**Default the download off.** With no store root configured, nothing downloads and nothing changes. The sibling change owns the store-root key. A rollback clears it.

## Risks / Trade-offs

- **GHCR names no contractual rate limit** → One pull per version, with retry and backoff through the `retry` option of `downloadToFile`. The Homebrew scale is the practical proof.
- **The gate holds forever on a failed download** → The gate reports the failure and the remedy, and it offers a retry. It never spins silently.
- **A moved `latest` tag during a pull** → Digests are pinned at resolve time, thus a moved tag cannot mix two versions in one store.
- **Disk cost, about 9 GB beside the image** → The consent prompt names the size. The farm-subset fetch (§8.8) is the real cure, and it is deferred.
- **The store arrives but the sibling change is not configured** → The two changes share the store-root key. A downloaded store without a mount is inert, not harmful.

## Migration Plan

1. Land the registry client and the receipt. Nothing calls them yet.
2. Start the background download at app open when the store root is configured.
3. Add the gate, and remove the app-open block on the image pull.
4. Rollback is one cleared key. The image path stays untouched.

## Open Questions

- The update cadence is decided (2026-08-05): when `latest` moves, the receipt reports `update_available`, and the CLI asks before the download. A silent multi-gigabyte download is not permitted.
- Retention on the user disk stays open: does an update remove the old store version, or keep it until a farm stops naming it? If a task needs this answer, mark it `BLOCKED`.
