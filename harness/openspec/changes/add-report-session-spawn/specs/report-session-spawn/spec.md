## ADDED Requirements

### Requirement: The spawn makes a report child thread
The spawn operation MUST make a child thread with the type `report`, the parent thread id, and the anchor. It MUST mint the child thread id, and it MUST give back the full thread row. The child belongs to the analysis of the parent.

#### Scenario: A report session spawns from a conversation
- **WHEN** the caller spawns from a live conversation thread that holds turns
- **THEN** the child holds the type `report`, the parent thread id, and the analysis id of the parent

#### Scenario: The child appears under its parent
- **WHEN** the caller lists the threads narrowed by the parent thread id
- **THEN** the listing holds the spawned child

### Requirement: The anchor is the latest seq at the spawn
The spawn MUST set the anchor to the latest `messages.seq` value of the parent at the moment of the spawn. The read takes no lock. A later append to the parent MUST NOT change the anchor of the child.

#### Scenario: The anchor equals the transcript end
- **WHEN** the caller spawns from a parent whose latest seq is 14
- **THEN** the child holds the anchor 14

#### Scenario: The parent moves on, and the anchor stays
- **WHEN** the parent appends a turn after the spawn
- **THEN** the anchor of the child keeps its value from the spawn

### Requirement: The spawn refuses an absent or archived parent
The spawn MUST refuse a parent id that resolves to no live thread. The refusal is typed data with the reason `parent_not_found`. An archived parent refuses the same way, because a spawn into hidden state is not permitted.

#### Scenario: An unknown parent refuses
- **WHEN** the caller spawns with a parent id that no thread holds
- **THEN** the spawn refuses with `parent_not_found`, and no thread is written

#### Scenario: An archived parent refuses
- **WHEN** the caller spawns from a thread that is archived
- **THEN** the spawn refuses with `parent_not_found`, and no thread is written

### Requirement: The spawn refuses an empty parent transcript
The spawn MUST refuse a parent that holds no messages. The refusal is typed data with the reason `empty_parent_transcript`. A report on an empty transcript reports nothing, thus the refusal is the correct answer.

#### Scenario: An empty conversation refuses
- **WHEN** the caller spawns from a live thread with no messages
- **THEN** the spawn refuses with `empty_parent_transcript`, and no thread is written

### Requirement: The title of the child
The spawn MUST set the child title to `{parent title} — Report N`. N is the count of the existing report children of the parent, plus one. When the parent holds no title, the title MUST be `Report N` alone.

#### Scenario: The first report session
- **WHEN** the caller spawns the first report child of a parent with the title "RNA-seq QC"
- **THEN** the child title is "RNA-seq QC — Report 1"

#### Scenario: The second report session
- **WHEN** the caller spawns again from the same parent
- **THEN** the child title is "RNA-seq QC — Report 2"

#### Scenario: A parent without a title
- **WHEN** the caller spawns from a parent whose title is null
- **THEN** the child title is "Report 1"

### Requirement: The children listing
The operation MUST give the report sessions of one analysis. It narrows the thread listing to the type `report`, and it adds no other predicate. Thus the answer and the thread listing cannot disagree.

#### Scenario: Only the report sessions return
- **WHEN** an analysis holds two conversations and one report session, and the caller lists the report sessions
- **THEN** the listing holds the one report session
