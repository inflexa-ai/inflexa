## MODIFIED Requirements

### Requirement: Log rotation and retention
The system MUST write to a per-day log file named `inflexa-<YYYY-MM-DD>.log`, where the date is the local calendar date of the machine. The retention sweep and the size scan run at logger initialization and at each midnight roll. The sweep MUST delete each log file whose date is more than 7 days old on the same local calendar. The scan MUST roll to a numbered sibling file (`inflexa-<date>.<n>.log`) when the file of the day is at or above 20MB. While the process lives, the system MUST move to the file of the new day at local midnight: a timer fires at the next local midnight, the destination reopens on the new name, and the timer arms again. The roll MUST flush the buffered records into the old file before the reopen. The roll MUST NOT add work to the write path, and it MUST NOT keep the process alive. A rotation failure MUST NOT prevent logging.

#### Scenario: The file name carries the local date
- **WHEN** the CLI starts at 01:00 local on a machine at UTC+03:00
- **THEN** the records go to the file named for the local date, not for the UTC date of the day before

#### Scenario: A live session moves to the new day at midnight
- **WHEN** a session logs at 23:59 local and then at 00:01 local
- **THEN** the record at 23:59 is in the file of the first day. The record at 00:01 is in the file of the second day

#### Scenario: Old logs are deleted
- **WHEN** the CLI starts and the log directory contains a log file dated more than 7 days ago
- **THEN** that file is deleted and logging proceeds in today's file

#### Scenario: Oversized file rolls at startup
- **WHEN** the CLI starts and today's log file is 20MB or larger
- **THEN** new records are written to the next numbered file for today
