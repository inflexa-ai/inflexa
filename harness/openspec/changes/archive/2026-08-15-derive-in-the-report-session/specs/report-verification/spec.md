# Delta: report-verification

## ADDED Requirements

### Requirement: A derivation is repeatable
The derivation record MUST hold what a second run needs: the script text, the script hash, the source paths with their hashes, and the output hash. A verifier can mount the same pinned inputs, run the recorded script, and compare the output hash. The record is immutable, thus the chain from a derived cell to the pinned evidence stays whole.

#### Scenario: The record admits a re-run
- **WHEN** a verifier reads a derivation record
- **THEN** the record names the script, the sources with their hashes, and the expected output hash
