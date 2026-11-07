# Spec Delta

## ADDED Requirements

### Requirement: A decode of file content runs in a bounded worker

The harness MUST decode untrusted file content in a worker thread with a V8 heap limit, never on the main thread of the host. The decodes are a table (CSV, TSV, JSON, parquet), the list and the entries of a compressed file, and the text of a PDF. A decode that passes the heap limit MUST end only its worker, and its caller MUST get a failure with the kind `out_of_memory`. The host process MUST continue. A new tool that decodes file content MUST use the same workers.

#### Scenario: A decode past the heap limit

- **GIVEN** a table whose decode needs more memory than the heap limit of a decode worker
- **WHEN** a script reads the table under Node
- **THEN** the read fails with an error that names the memory limit
- **AND** the host process continues, and the next call of the script runs

#### Scenario: The main thread gives the bytes with no copy

- **WHEN** a tool decodes a file of 10 MiB
- **THEN** the main thread transfers the bytes to the worker, and the bytes are not copied

### Requirement: The heavy workers of a process wait in queues of fixed width

The harness MUST hold one queue for the decode workers and one queue for the script workers, each of a fixed width for the whole process. A task that finds each slot held MUST wait for a slot, and it MUST NOT fail for the wait. A slot MUST be free again when its worker exits, for each outcome of the task.

#### Scenario: A third decode waits

- **GIVEN** two decodes that hold the two decode slots
- **WHEN** a third read starts
- **THEN** the third read waits, and it decodes when the first slot is free

#### Scenario: A failed decode frees its slot

- **WHEN** a decode worker runs out of memory
- **THEN** its slot is free, and the next decode starts

### Requirement: The worker entry of a bundled host serves each heavy worker

The decode workers and the script workers MUST start from one worker entry, `tools/script/codemode-worker.js`. The entry MUST select its task from its worker data. A host that gives `ScriptRuntime.workerUrl` to `assembleCoreRuntime` MUST get that entry for each heavy worker. A host that gives none MUST get the entry beside the module.

#### Scenario: A bundled host

- **GIVEN** a host that gives the embedded path of the entry as `scriptRuntime.workerUrl`
- **WHEN** a script reads a table and a step agent reads a PDF
- **THEN** each decode starts its worker from the embedded path

### Requirement: A nested result has a size limit before it goes to the VM

Before the harness gives the result of a nested call to the VM, it MUST measure the size of the JSON text of the result, with no copy of the result, and it MUST stop the measure at the limit of 32 MiB. A result over the limit MUST be a failed call, with an Error that names the size and the limit. This limit MUST hold for each script tool, also for a tool that a host adds. A result that JSON cannot carry MUST be a failed call too.

#### Scenario: A lookup result over the limit

- **GIVEN** a host script tool that returns 40 MiB of JSON
- **WHEN** a script calls it
- **THEN** the call throws an Error that names 32 MiB, and the VM receives nothing of the result

### Requirement: The host declares the memory of its heavy workers

The harness MUST export `HOST_WORKER_MEMORY_MIB`, the sum of the heap limits of the decode slots, and of the heap limits and the VM memory of the script slots. A host MUST be able to size its main heap beside it.

#### Scenario: The sum

- **WHEN** a host reads `HOST_WORKER_MEMORY_MIB`
- **THEN** the value is the decode slots times their heap limit, plus the script slots times their heap limit and their VM memory
