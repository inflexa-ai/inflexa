# Spec Delta

## MODIFIED Requirements

### Requirement: The harness pins the copy detector and commits its configuration

The harness MUST declare `jscpd` as a dev dependency at one exact version. The
harness MUST commit a `.jscpd.json` at its root that names, for the code formats
of the `src` and `scripts` trees — TypeScript, TSX, JavaScript, Python, R, and
bash — the minimum size of a reported copy in tokens and in lines. The
configuration MUST carry the reason for that floor, the reason for each ignored
tree, and the reason for the data formats that stay outside the scan, inside the
configuration file. The reason for the floor MUST state the measured clone
counts at the chosen floor and at the floors immediately above and below it, so
a future calibration re-runs the same ladder instead of a new judgment. The
configuration MUST exclude `dist`, `node_modules`, and the generated gallery
data directories from the scan, and MUST NOT exclude any tree that holds
hand-written code of the harness.

#### Scenario: The configuration names the floor and its reasons

- **WHEN** `harness/.jscpd.json` is read
- **THEN** it holds a minimum token count and a minimum line count for a
  reported copy, and the reason for the floor, for each ignored tree, and for
  the data formats left out sits in the same file

#### Scenario: The reason records the calibration ladder

- **WHEN** `harness/.jscpd.json` is read
- **THEN** the reason for the floor states the measured clone counts at the
  chosen floor and at the floors immediately above and below it

#### Scenario: Data formats stay outside the gate

- **WHEN** the scan runs over `src` and `scripts`
- **THEN** it analyzes no JSON, YAML, or plain-text file, because a fixture
  repeats data and not code, and it still analyzes each R and bash file of the
  trees, because those files are code
