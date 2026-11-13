## ADDED Requirements

### Requirement: A nested call obeys the order of its run

`run_script` MUST be concurrent. A nested call of a script tool that does not declare `concurrent: true` MUST run under the call lock of the context of the `run_script` call. Thus a nested call that is not concurrent runs alone among the calls of the series. A nested call of a concurrent tool does not wait.

#### Scenario: A script calls a tool that is not concurrent in parallel

- **WHEN** a script calls a tool that is not concurrent two times in one `Promise.all`
- **THEN** the second call starts after the first call ends

#### Scenario: A script calls concurrent tools in parallel

- **WHEN** a script calls a concurrent tool two times in one `Promise.all`
- **THEN** the two calls run at the same time
