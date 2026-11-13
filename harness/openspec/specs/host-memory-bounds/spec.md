# host-memory-bounds Specification

## Purpose
Define the standard for memory-heavy work in the host process of the harness. A decode of untrusted file content and the VM of a script each run in a worker thread with a V8 heap limit, not on the main thread.

Under Node, a decode past its limit ends only its worker. Its call fails, and the host process continues. Bun accepts the heap limit of a worker, but it does not enforce it. Each heavy worker starts from one worker entry, thus a bundled host embeds one file for all of them.

A heavy task waits for a slot in the queue of its kind, and each queue has a fixed width for the whole process. The host gives the memory that its workers hold together, and the harness fits its slots in that memory. Thus the host can size its own heap limit beside it. A nested result of a script has a JSON size limit before it goes into the VM.

## Requirements

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

The harness MUST hold one queue for the decode workers and one queue for the script workers, each of a fixed width for the whole process. A task that finds each slot held MUST wait for a slot, and it MUST NOT fail for the wait. A slot MUST be free again when its worker exits, for each outcome of the task. A read MUST hold its decode slot before it loads the bytes of the file, thus a read that waits holds no bytes. A cancel of a read that waits MUST take it out of the queue, and the read MUST NOT load or decode the file.

#### Scenario: A third decode waits

- **GIVEN** two decodes that hold the two decode slots
- **WHEN** a third read starts
- **THEN** the third read waits, and it decodes when the first slot is free

#### Scenario: A waiting read holds no bytes

- **GIVEN** two reads that hold the two decode slots
- **WHEN** a third read starts
- **THEN** the third read loads no bytes until a slot is free

#### Scenario: A cancel while a read waits

- **GIVEN** a read that waits for a decode slot
- **WHEN** its call is cancelled
- **THEN** the read leaves the queue, and it does not load or decode the file

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

### Requirement: The host gives the memory of its heavy workers

A host MUST be able to give the memory in MiB that the heavy workers of its process hold together, as `hostWorkerMemoryMib` of `assembleCoreRuntime`. The harness MUST fit its slots in that memory: a decode slot holds 400 MiB and a script slot holds 400 MiB. Two fifths of the slots, rounded, MUST decode, and the others MUST run scripts. Each kind MUST get at least one slot, also when the memory holds fewer than two slots. With no memory, the harness MUST keep two decode slots and three script slots (2000 MiB). The harness MUST log the slots and their memory at boot, and it MUST warn when the slots hold more than the host gave.

#### Scenario: A small host

- **WHEN** a host gives 800 MiB
- **THEN** the process runs one decode worker and one script worker at the same time

#### Scenario: A large host

- **WHEN** a host gives 4000 MiB
- **THEN** the process runs four decode workers and six script workers at the same time

#### Scenario: Less than the smallest budget

- **WHEN** a host gives 100 MiB
- **THEN** the process runs one decode worker and one script worker, and the boot log warns that the slots hold 800 MiB
