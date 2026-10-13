# Spec Delta

## ADDED Requirements

### Requirement: Seen mark and analysis name functions

The system MUST give these functions, each returning `Result<…, DbError>`:

- `recordRunSeen(runId, analysisId, atMs)`: one `INSERT` of a seen mark that keeps an existing mark. It MUST return the rows-changed count: `1` for a new mark, and `0` when the run has a mark. A second call MUST keep the first `seen_at`.
- `getRunSeenState()`: the `since` of the seen baseline, or `null` when no baseline row exists, and the run id of each seen mark. It sends two statements: one for the baseline and one for the marks.
- `listAnalysisNames(ids)`: the name of each analysis of the list that has a row, as a map from the id to the name, in one statement. An id with no row MUST have no entry. An empty list MUST give an empty map and send no query.

#### Scenario: A second mark keeps the first time

- **GIVEN** a seen mark of run `r1` at time T
- **WHEN** `recordRunSeen("r1", "a1", T + 1000)` runs
- **THEN** it returns 0, and the `seen_at` of the mark stays T

#### Scenario: The seen state

- **GIVEN** the baseline row and marks of runs `r1` and `r2`
- **WHEN** `getRunSeenState()` runs
- **THEN** it returns the `since` of the baseline and the ids `r1` and `r2`

#### Scenario: The names of a list

- **GIVEN** analyses `a1` named `trial` and `a2` named `bulk`
- **WHEN** `listAnalysisNames(["a1", "a2", "gone"])` runs
- **THEN** it returns `a1` to `trial` and `a2` to `bulk`, with no entry for `gone`, from one statement
