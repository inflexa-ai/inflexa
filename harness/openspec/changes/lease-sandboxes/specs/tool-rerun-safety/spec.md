## REMOVED Requirements

### Requirement: A derivation runs inside its tool call

**Reason**: The report session loses `derive_table`, and the report-value resolution loses its sandbox arm. No tool call runs a sandbox command of its own. Each sandbox exec goes through a lease of the sandbox module.

**Migration**: None for a caller. The sandbox-leases capability gives the rerun rule of each exec: a rerun of a step finds its lease, and the exec records give the result of the first command.
