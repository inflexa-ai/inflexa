# Tasks

## 1. Severity of a registry rejection

- [ ] 1.1 Adapter: exclude a not-referenced rejection from `failedCount`, keeping it in `failed[]` with its path and reason; output and cascaded rejections stay counted.
- [ ] 1.2 `registerStepArtifacts` — when `failedCount` is 0 and `failed` is non-empty, log one warn record naming each rejected path and the registry's reason.

## 2. Byte sync independent of registration

- [ ] 2.1 `sandbox-step` post-step body — attempt `ArtifactRegistry.sync` whatever registration returned, including when it threw.
- [ ] 2.2 Keep the registration error as the surfaced cause; log a sync failure that follows one with its own detail rather than replacing the cause.

## 3. Tests

- [ ] 3.1 A step whose only rejection is a not-referenced file completes, with the rejection logged.
- [ ] 3.2 An output rejection still fails the step with the per-file detail.
- [ ] 3.3 Registration throws — sync is still called and the accepted rows upload; the step fails with the registration error.

## 4. Spec

- [x] 4.1 Delta on `artifact-manifest`: rejection severity follows what is at risk; uncounted rejections are surfaced; sync is attempted independently of the registration outcome.
- [x] 4.2 Hand-rewrite the **Purpose** section the delta does not carry — it claimed every registry rejection is terminal.
- [ ] 4.3 Archive (`openspec archive`) once the code lands; validate `--strict`.
