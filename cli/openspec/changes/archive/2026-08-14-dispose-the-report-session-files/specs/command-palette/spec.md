## ADDED Requirements

### Requirement: The delete-session command offers to remove the page files it orphans

The delete-session command MUST offer to remove the page files that its erase orphans. It erases a thread and every descendant of it. A report session owns a page directory on disk, named by its thread id. That id is gone after the erase, thus no surface can name the directory again.

The flow MUST ask in the same ritual as the name confirmation. Thus the user answers once, and nothing runs before that.

The flow MUST ask on every delete, and it MUST test no directory first. The delete is irreversible, thus the user meets one ritual and never two shapes of it. A subtree with no page on disk answers a question about nothing, and that costs one keystroke.

The two answers MUST be "remove" and "keep". Nothing archives a page, thus the two-way choice of the analysis delete does not carry here.

The flow MUST unbind the scope before the removal, and the removal MUST run before the landing. Each step after the erase awaits, thus a bound scope that names an erased thread lets a turn mint the row back. The landing binds a different conversation, thus the removal must not race it.

One notice MUST report both the erase and the fate of the files, in place of the success line that the flow raises today. Two notices for one action are two claims about one event.

The removal MUST run after the erase succeeds. A refused erase and a failed erase each leave every file, because the rows that name those pages survive.

The set of directories MUST come from the ids that the purge gives back. A listing before the erase and the erase itself are two operations. A spawn between them makes a child that the erase removes and the listing never saw.

The flow MUST name each directory through the helper that the harness exports. It MUST spell no directory name of its own, because the layout of a workspace belongs to the harness.

The removal MUST be best-effort. The rows are gone when it runs, thus a directory that survives MUST NOT read as a failed delete. An absent directory MUST NOT read as a failure either. The outcome notice MUST name what stayed.

A workspace root that does not resolve MUST remove nothing, and the notice MUST tell its two causes apart. A tree that was never written holds no page, thus the notice MUST report that no page remains. A tree that the host cannot locate can hold one, thus the notice MUST warn and MUST give that cause. One line for both would send the user to the anchor for a page that never existed.

The flow MUST keep the gate that it has on a running chat turn. A render of a page runs inside a turn, thus that one gate covers a delete that would race a write into the same directory.

#### Scenario: A delete with a report child asks about the files

- **GIVEN** an open conversation with one report session that rendered its page
- **WHEN** the user runs the delete-session command and confirms the name
- **THEN** the flow asks whether to remove the page files before it erases anything

#### Scenario: A delete with no page on disk asks the same question

- **GIVEN** an open conversation with no report child
- **WHEN** the user runs the delete-session command and confirms the name
- **THEN** the flow asks the same file question, and the removal that follows finds nothing and reports no failure

#### Scenario: The answer reaches every erased session

- **GIVEN** an open conversation with two report sessions, each with a page on disk
- **WHEN** the user confirms the delete and accepts the removal
- **THEN** both page directories are gone

#### Scenario: A delete from inside a report session removes its own page

- **GIVEN** the user opened a report session and reads its page
- **WHEN** the user runs the delete-session command, confirms the name, and accepts the removal
- **THEN** that one thread is erased, its page directory is gone, and the parent conversation is unchanged

#### Scenario: A declined removal keeps each file

- **WHEN** the user confirms the delete and declines the removal
- **THEN** the rows are erased, and each page directory stays on disk

#### Scenario: A failed erase leaves each file

- **GIVEN** a delete that the store refuses
- **WHEN** the failure is observed
- **THEN** no page directory is removed, and the notice reports the failed delete

#### Scenario: A directory that resists removal does not fail the delete

- **GIVEN** a confirmed delete whose rows are erased
- **WHEN** one page directory cannot be removed
- **THEN** the delete reports its success, and the notice names the directory that stayed

#### Scenario: An analysis with no workspace tree reports that no page remains

- **GIVEN** an analysis that ran nothing, thus it has no workspace tree on disk
- **WHEN** the user confirms the delete and accepts the removal
- **THEN** the notice reports that no report page remains, and it raises no warning

#### Scenario: A workspace that the host cannot locate warns

- **GIVEN** an analysis whose workspace tree the host cannot locate
- **WHEN** the user confirms the delete and accepts the removal
- **THEN** the notice warns that the pages stayed, and it gives that cause
