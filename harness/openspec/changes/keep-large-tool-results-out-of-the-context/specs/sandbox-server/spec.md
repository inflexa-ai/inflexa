## ADDED Requirements

### Requirement: The terminal result keeps each stream within the byte budget of the submit

Each stream of the completion payload MUST hold at most the byte budget of the
submit, `stdoutByteCap` or `stderrByteCap`. Past the budget, the server MUST
count the bytes and drop them, and it keeps the start of the stream. The payload
MUST then carry the truncation flag of that stream (`stdoutTruncated` or
`stderrTruncated`) and the total bytes of the stream (`stdoutTotalBytes` or
`stderrTotalBytes`). A budget of 0, or no budget, keeps the whole stream. The
server MUST NOT end a kept stream with a part of a UTF-8 sequence.

#### Scenario: A stream past the budget keeps its start

- **GIVEN** a submit with `stdoutByteCap` 1,048,576, and a command that writes 3,145,728 bytes to stdout
- **WHEN** the command exits
- **THEN** the payload `stdout` holds the first 1,048,576 bytes, `stdoutTruncated` is true, and `stdoutTotalBytes` is 3,145,728
