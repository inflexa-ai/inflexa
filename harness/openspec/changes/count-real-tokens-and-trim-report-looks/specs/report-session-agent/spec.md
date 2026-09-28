## MODIFIED Requirements

### Requirement: The read-only roster
The roster of the agent MUST hold: the workspace read tools (`read_file`, `list_files`, `file_stat`, and `grep`), the workspace search, `inspect_run`, `inspect_data_profile`, the authoring tools, the pinned-artifact listing tool, the derivation tool, and the render-and-preview tool. The roster MUST NOT hold a planner, a run launcher, a working-memory write, or a sandbox mutate surface. Thus no tool starts a run, and no tool changes an analysis. A session derivation is a sandbox exec inside the session: it mints no run id, it registers no artifact, and it writes under the session directory alone.

With no input, the listing tool MUST give the pinned artifacts in a deterministic order: the path and the file type of each artifact. For a `.csv` or a `.tsv` artifact, the entry also gives the count of the header columns, from a bounded read of the header. The listing MUST also give the pinned citation ids. The listing is bounded, and a truncated listing MUST carry the total count and a truncation marker.

The listing MUST NOT give a hash, because a reference names the path alone and the session stamps the hash. The listing MUST NOT give the names of the columns. A wide table can have hundreds of columns, and the listing stays in the context of each later request.

With a `path`, the listing tool MUST give that one artifact with the outcome `artifact`: the path, the file type, the count of the header columns, and their names. A path that the pin does not hold MUST give the outcome `not-pinned`, with the path. A header that the bounded read cannot parse whole gives no columns and no count. An unreadable header gives no columns and no error, because absence is a normal condition.

The listing MUST give each pinned citation as its key with the short citation beside it, when the pinned record carries one. Thus the agent reads which id is which paper, and it composes a citation block with no guess. A key with no record lists bare, because absence is a normal condition.

#### Scenario: The roster holds no run starter
- **WHEN** the assembled agent lists its tools
- **THEN** no tool id of the run-starter set or the mutate set is present

#### Scenario: The analysis read surface is present
- **WHEN** the assembled agent lists its tools
- **THEN** the workspace read tools, the search, the run inspection, and the data-profile inspection are present

#### Scenario: The listing gives the pinned set with columns
- **WHEN** the agent calls the listing tool with no input, in a session whose snapshot pins a CSV artifact
- **THEN** the entry carries the path, the file type, and the count of the header columns, and no hash and no column name

#### Scenario: A path gives the header columns
- **WHEN** the agent calls the listing tool with the path of a pinned CSV artifact
- **THEN** the outcome is `artifact`, with the path, the file type, the count of the header columns, and their names

#### Scenario: A path outside the pin gives not-pinned
- **WHEN** the agent calls the listing tool with a path that the snapshot does not pin
- **THEN** the outcome is `not-pinned`, with that path

#### Scenario: An unreadable artifact still lists
- **WHEN** the snapshot pins a path whose bytes are absent from the disk
- **THEN** the result carries the path, with no columns, no count, and no error

#### Scenario: A large pinned set truncates with a marker
- **WHEN** the snapshot pins more artifacts than the listing bound
- **THEN** the result carries the bounded listing, the total count, and the truncation marker

#### Scenario: The listing names the paper beside the key
- **WHEN** the agent calls the listing tool in a session whose pin records `Hugo et al. 2016` under `pmid:26997480`
- **THEN** the listed citation carries the key and the short citation

#### Scenario: A derivation starts no run
- **WHEN** the agent derives a table in a session
- **THEN** no run row and no artifact row lands, and the output sits under the session directory

## ADDED Requirements

### Requirement: The prompt limits the looks and the finish calls

Each look and each tool result stays in the context of each later request of the turn. Thus the prompt MUST teach a build loop with few looks and few finish calls. The prompt MUST state these rules:

- When the agent knows the content of a section, it adds the section with its atoms in one `add_block` call. It adds an empty section only when its content waits for a derivation.
- After the first preview that passes, the agent looks at the whole page one time. It makes each repair that this look shows before it looks again.
- After a repair, the agent previews. Then it looks only at each block that it repaired, and it gives the block id to the look tool.
- The record accepts a look at one block of the current page.
- A `block` coverage holds the named block alone, and the rest of the page is absent from that look.
- The agent does not call `finish_draft` directly before a preview. The preview runs the same finish, and it gives the same gaps and warnings.
- An amend is the whole set of changes of one user request. The agent makes the whole amend, and then it runs the loop again.
- Before the agent names a column, it gives the path of the artifact to the listing tool. It takes the column name from the columns that the tool gives.

#### Scenario: The prompt teaches the short loop

- **WHEN** a reviewer reads the prompt module
- **THEN** the add of a whole section, the one look at the whole page, and the block look after a repair are present
- **AND** the rule against a finish before a preview, and the whole amend, are present

#### Scenario: The prompt names the block coverage

- **WHEN** a reviewer reads the prompt module
- **THEN** a `block` coverage names the rest of the page as absent from the look

#### Scenario: The prompt routes a column name through the path

- **WHEN** a reviewer reads the prompt module
- **THEN** the agent takes a column name from the listing tool, called with the path of the artifact
