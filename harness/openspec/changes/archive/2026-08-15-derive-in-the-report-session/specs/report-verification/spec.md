# Delta: report-verification

## ADDED Requirements

### Requirement: A derivation is repeatable
The derivation record MUST hold what a second run needs: the script text, the script hash, the source paths with their hashes, and the output hash. A verifier can run the recorded script over the analysis tree and compare the output hash. The record is immutable, thus the chain from a derived cell to the pinned evidence stays whole.

The record states two bounds honestly. The record pins the declared sources, and the read reach of the script is the whole tree. The record pins no image reference, thus a different sandbox image can give a different hash. The declared-input wall and the image pin are later hardenings.

#### Scenario: The record admits a re-run
- **WHEN** a verifier reads a derivation record
- **THEN** the record names the script, the sources with their hashes, and the expected output hash
