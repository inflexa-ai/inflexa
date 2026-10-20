## ADDED Requirements

### Requirement: The palette opens the page of the open report session

The palette MUST offer the command `session.open-report-page`, with the title "Open report page", in the Session category. The command MUST be offered only when an analysis is open and the boot state is ready. A dispatch by id under any other state MUST raise a notice, because a leader chord bypasses the offer predicate.

The flow MUST read the open thread first. When that read fails, the flow MUST raise a notice and open nothing. When the open thread is not a report child, the flow MUST raise a notice that names the reason, and it MUST open nothing. A conversation, and a thread with no row, are not report children.

For a report child, the flow MUST ask the server for the access of the page of that thread (`POST {A}/report-sessions/{threadId}/access`). Then it MUST open the URL of the answer in the default browser. Each open asks for a new grant. Thus a page that the person opens again after an older URL expired still loads. The flow MUST NOT open the page file.

When the open analysis or the open thread changed across the reads, the flow MUST open nothing.

The outcomes MUST each give a notice:

- A 404 `not_found` answer MUST give a notice that the session has no page yet.
- Each other failure of the request MUST give a warning that describes the failure.
- An opener that fails MUST give a warning that carries the URL, thus the person can open it manually.
- An open that succeeds MUST give a notice that the page opened in the browser.

#### Scenario: A report session opens its page in the browser

- **GIVEN** an open report session whose preview rendered a page
- **WHEN** the user runs "Open report page"
- **THEN** the TUI opens the URL of the page on the local server in the default browser, and no file path

#### Scenario: A conversation has no page

- **WHEN** the open thread is a conversation and the user runs "Open report page"
- **THEN** a notice names the reason, and nothing opens

#### Scenario: A session with no page yet

- **GIVEN** an open report session whose folder holds no page
- **WHEN** the user runs "Open report page"
- **THEN** a notice says that the session has no page yet, and nothing opens

#### Scenario: The opener fails

- **WHEN** the server gives the URL and the opener of the operating system fails
- **THEN** a warning carries the URL

#### Scenario: A dispatch before the runtime is ready

- **WHEN** the command runs by id and the boot state is not ready
- **THEN** a notice names the state, and nothing opens
