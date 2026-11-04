## ADDED Requirements

### Requirement: Each test is independent of the order of the suite

The suite runs in one process, thus the process-wide state is shared across each test file. A test MUST make the state that it reads before it reads it: a file or a folder in the test sandbox, and a property of a process-wide object such as a stdio stream. A test that changes a property of a process-wide object MUST restore the original property after the test. The original property is the own descriptor that the object had before the change, or no own property when it had none. A hook that cleans the state of a test MUST also work after a test that did not make that state.

#### Scenario: The suite passes in a random order

- **WHEN** `bun test --randomize --seed=<n>` runs in `cli/` with each seed `<n>` of 804, 11, 22, 33, 44, 55, 66, 77, 88, and 99
- **THEN** no test fails

#### Scenario: A replaced stdio property comes back as it was

- **WHEN** a test replaces `isTTY` or `columns` of `process.stderr` or `process.stdin`, and the test ends
- **THEN** the stream has the own descriptor that it had before the test, or no own property when it had none, and a later plain assignment of the property works as it did before the test

### Requirement: The assertion count of a test does not depend on the timing

A test that reads the output of a real timer MUST NOT call `expect()` one time for each item of that output. It MUST assert the whole output in a fixed number of calls. Thus the `expect()` count of such a test does not depend on the timer schedule of the machine.

#### Scenario: The exit indicator width test

- **WHEN** the test of the exit indicator checks that each frame fits a row of 12 columns
- **THEN** it makes the same number of `expect()` calls, whatever the number of frames that the timer drew
