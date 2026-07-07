# harness-workspace-tools — delta

## REMOVED Requirements

### Requirement: Mutate surface records SHA-256 content snapshots for provenance

**Reason**: The write-snapshot seam this requirement mandates
(`workspace/provenance-collector.ts`, `recordSnapshot`) has zero production
implementations — the mutate tools' recording branch sits behind an optional dependency
no composition root has ever supplied, and the requirement's claim that "artifact
registration consumes these snapshots as lineage without re-computing the hash" has
never matched the code: registration content-attests from disk via
`reconcileManifestWithDisk` (see the artifact-manifest spec's reconcile rules). The seam
and its plumbing are deleted with this change.

**Migration**: None for existing deployments — no realization of the seam ever existed,
so no data or behavior is lost. If harness-side tool-write lineage is wanted later, the
step-scoped lineage collector already models it (`ProvenanceCollector.recordFileToolWrite`,
`src/provenance/collector.ts`); wiring the mutate tools to that collector is the
tool-write half of the tool-I/O lineage coverage gap tracked as a
`deepen-run-provenance` follow-up, a separate change.
