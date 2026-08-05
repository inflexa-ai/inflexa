## 1. Configuration and paths

- [ ] 1.1 Add an optional store-root key to the harness config schema, defaulting to unset
- [ ] 1.2 Add the store root to `src/lib/env.ts`, distinct from `libsDir`, which is the per-image inventory cache
- [ ] 1.3 Add a resolver that reports whether a store is configured and where it is, so no call site infers it from a path check

## 2. Mount the store

- [ ] 2.1 Pass `libStorePath` into `createSandbox` at `src/modules/harness/runtime.ts` when a store is configured, and omit it otherwise
- [ ] 2.2 Do not re-implement the harness's store usability check; add a test asserting the CLI still passes the path when the store is incomplete
- [ ] 2.3 Add a test asserting no `/mnt/libs` bind is requested when no store is configured

## 3. Inventory source

- [ ] 3.1 Resolve `packagesFile` from the active farm when a store is configured, and from the image label cache otherwise
- [ ] 3.2 Add a test asserting the inventory follows the mount in both directions
- [ ] 3.3 When a store is configured but unusable, read the image label cache and warn (decided 2026-08-05). The inventory must never describe something the sandbox did not mount

## 4. Provisioning

- [ ] 4.1 Add a provisioning module beside `pull.ts`, starting the provisioner through `src/lib/container.ts`
- [ ] 4.2 Add the command that provisions a package into a named farm, and flip the active farm on success
- [ ] 4.3 Surface a concurrent-run conflict as an actionable message, not an unhandled fault
- [ ] 4.4 Report progress during provisioning, following the reference-store installer's observer pattern, where an observer cannot fail the install
- [ ] 4.5 Give provisioning the `approval` policy in the command tree, and update the policy tree test

## 5. Inspection and reclamation

- [ ] 5.1 Add the command that reports the store's packages, farms, and disk use, with the `auto` policy and no configuration writes
- [ ] 5.2 Add the command that removes a farm, with the `approval` policy
- [ ] 5.3 Add the command that reclaims unreferenced store content, reporting what it would remove before removing it, with the `approval` policy
- [ ] 5.4 Add a test asserting no other command removes store content

## 6. Specs and documentation

- [ ] 6.1 Apply the `lib-store-provisioning` delta: the CLI may create a `/mnt/libs` bind mount when a store is configured
- [ ] 6.2 Document opting in, and keep `inflexa sandbox pull` documented as the default path
- [ ] 6.3 Record the macOS bind-mount performance cost where a developer will meet it, and re-measure on Linux before recommending the store as the default

## 7. Integration

- [ ] 7.1 End-to-end test: provision a package into an empty store, launch a sandbox, import the package, and confirm it appears in `list_available_packages`
- [ ] 7.2 End-to-end test: with no store configured, confirm behaviour is identical to before this change
- [ ] 7.3 Bump the `@inflexa-ai/harness` dependency once the harness change is released; until then this subsystem's CI fails on the unreleased dependency, which is expected for a cross-subsystem change
