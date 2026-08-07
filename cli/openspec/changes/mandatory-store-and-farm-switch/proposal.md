## Why

The harness change `preserve-farm-tracks-and-single-runtime-image` retires the
baked variants `sandbox-python` and `sandbox-python-r`. `sandbox-base` becomes the
only runtime image, and its `/mnt/libs/current` is empty. The image keeps each
language interpreter, the system libraries, and the two tracks that a farm cannot
carry, which are conda and Node. The store carries packages only, and it never
carries an interpreter. Thus a sandbox with no store mounted has no R library and
no Python library.

Three parts of the CLI depend on the old shape:

- The store is an opt-in switch, `harness.libStore`, and it defaults to off. The
  key existed so a user could depend on the packages that the image baked. With
  the switch off the product now ships a sandbox with no library.
- The download gate holds only when a store is configured
  (`src/tui/hooks/sandbox_gate.tsx`, the `disabled` phase). An unconditional
  requirement wants an unconditional gate.
- The inventory falls back to the image label cache when the store is unusable
  (`src/modules/harness/runtime.ts:678-695`). The image label now names an empty
  set, thus the fallback reports nothing useful.

Two smaller defects also block the store today. `harness.provisionerImage` is a
user configuration string with no default (`src/modules/harness/config.ts:52`).
Each store command that runs the container fails until the user sets it by hand
(`src/modules/libs/store.ts:129-134`). The provisioner has no variant choice, thus
it is not a user setting.

And nothing can switch the active farm. The store holds one pool and per-analysis
farms, and `current` selects the active farm. A downloaded `catalog` farm arrives
unreachable when a local farm already owns `current`, because the download never
moves `current` by design.

## What Changes

- **BREAKING** — the `harness.libStore` opt-in is removed. The key existed so a
  user could depend on the packages that the image baked. No image bakes a library
  after the harness change, thus an off state gives a sandbox with no library. The
  switch has no off position that works, and the CLI always passes the store root.
- **BREAKING** — `inflexa sandbox pull` loses its variant argument and its
  interactive variant prompt. `inflexa setup` loses the variant question, and
  `--sandbox` loses its `python|python-r` value grammar.
- **The provisioner image reference becomes a code constant**, beside the GHCR
  namespace constant in `src/modules/libs/images.ts`. `inflexa setup` pulls it, the
  same way it pulls the sandbox image. The `harness.provisionerImage` key is
  removed.
- **The provisioner container starts only to install packages.** Each other store
  operation is a host filesystem action that the CLI does directly: the read of
  `current`, the list, the reclaim preview, and the switch of the active farm.
- **The gate makes sure of a store, and it no longer waits only when one is
  configured.** The `disabled` phase leaves the gate. An unusable store is a hard
  failure with a remedy, not a silent degradation.
- **The first run has a stated shape.** The app opens at once, and the consent
  opens one time. The first action that makes a sandbox holds, and the gate reports
  which state it is in. A failed download leaves a usable app, a refused sandbox
  action, and a retry.
- **The inventory has one source.** It comes from the active farm of the store.
  When it is unreadable, the CLI reports the store as the fault and names the
  remedy. It does not read the image label cache.
- **New command `inflexa store use <farm>`.** It switches the active farm on the
  host, with no container, and it writes `current` atomically. Its policy is
  `approval`.
- **`inflexa store ls` reports more.** It says whether `current` resolves to a farm, and
  it names the track set of each farm. It stays `auto`, and it gains no flag.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `package-store-management`: the opt-in requirement is removed, because the store
  is mandatory. The provisioner image becomes a constant that setup pulls. The
  container starts only for an install. `inflexa store use <farm>` is added, with
  its guards, and `inflexa store ls` reports the pointer state and the tracks.
- `lib-store-provisioning`: the variant surface is removed, the CLI passes the
  store root unconditionally, and the inventory has no fallback.
- `lib-store-download`: the download is no longer conditional on a switch, and the
  gate makes sure of a store rather than waits for a configured one.
- `setup-answers`: `--sandbox` loses its variant value grammar, and setup pulls the
  provisioner image beside the sandbox image.

## Requirements that this change removes

This change removes three published requirements. Each removal carries its reason
and its migration note in the delta that holds it:

- `package-store-management`, `A local package store is optional and opt-in` — no
  image bakes a library, thus an off state gives a sandbox with no library.
- `lib-store-provisioning`, `The user chooses the image variant; architecture is
  automatic` — one runtime image is published, thus a user chooses nothing. The
  automatic-architecture half stays, in a new requirement of its own.
- `lib-store-provisioning`, `inflexa sandbox pull selects and pulls a sandbox
  image variant` — the command stays, and only the variant selection goes.

## Impact

- `src/modules/libs/images.ts`: the variant table, `variantImage`, `parseVariant`,
  and `variantOfImage` retire. One sandbox image constant and one provisioner image
  constant take their place, beside `GHCR_NAMESPACE`.
- `src/modules/libs/pull.ts`: the variant prompt and the variant argument retire.
- `src/modules/libs/store.ts`: `store use` joins it. The `image_unconfigured` error
  retires. `removeFarm` and `reclaim` keep the container, because both mutate the
  store under the store lock.
- `src/modules/harness/config.ts`: the `libStore` key and the `provisionerImage`
  key are removed, together with `resolveLibStore` and `resolveProvisionerImage`.
- `src/modules/harness/runtime.ts`: the store root passes unconditionally, and the
  inventory fallback at `:678-695` gives way to a reported failure.
- `src/tui/hooks/sandbox_gate.tsx`: the phase model loses `disabled`.
- `src/modules/infra/setup.ts`: the variant question retires, and setup pulls the
  provisioner image.
- `src/cli/index.ts`: `store use` registers with the `approval` policy.
- `openspec/specs/package-store-management/spec.md`,
  `openspec/specs/lib-store-provisioning/spec.md`,
  `openspec/specs/lib-store-download/spec.md`, and
  `openspec/specs/setup-answers/spec.md`: delta specs.
- This change depends on the harness change
  `preserve-farm-tracks-and-single-runtime-image`. That change retires the variant
  images, and it makes a provisioning run preserve the tracks of a farm. Without
  the preservation, `store use` would point `current` at a farm that a later
  `store add` silently reduces.
- `chat-wiring` does not change. The app still opens at once, and the wait still
  happens at the first action that makes a sandbox.

Out of scope: the farm-subset download (roadmap §8.8), the agent-facing install
tool, the retention policy for an old store version, and the managed service.
