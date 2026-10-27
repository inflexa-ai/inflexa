# Spec Delta

## ADDED Requirements

### Requirement: The server searches the names under a folder

`GET /api/v1/fs/search?path=<absolute path>&q=<text>` MUST give the entries under the folder whose name matches `q`. The body is `{hits, truncated}`. Each hit is `{entry, subpath}`:

- `entry`: the entry in the shape of a list entry of `GET /api/v1/fs/list`, with each field of that shape and the same enrichment: `kind`, `itemCount`, `isInput`, and `origin`.
- `subpath`: the path of the folder that holds the entry, relative to the canonical scope, with `/` as the separator. It is the empty string for a direct child of the scope.

The match MUST use the subsequence contract of the fuzzy scorer against the name of the entry. A folder and a file are both entries. An empty or absent `q` MUST match each entry. The hits MUST be in the order of the score, best first. Two hits with one score MUST be in the order of their depth, the shallower first, and then in code-unit order of their name.

The query value `limit` MUST bound the count of the hits, with the default 50 and the maximum 200. A value that is not a positive integer gives the default. The server MUST keep only the best `limit` hits during the score. It MUST NOT sort each match.

The query value `hidden` MUST take the values of `fs/list`. Without `hidden=true`, the walk MUST skip each hidden entry and MUST NOT enter a hidden folder. With `hidden=true`, the walk MUST index each hidden entry and enter each hidden folder.

The server MUST read the facts, the item count, the input mark, and the origin only for the hits of the response. It MUST send at most one read of the artifact ledger for each response, with the rules of the list.

`truncated` MUST be true when the walk of the scope is not complete at the time of the score. It MUST also be true when a cap stopped the walk. It MUST be false when the walk ended with no cap. A folder that the walk skipped, because the server cannot read it, MUST NOT set `truncated`.

#### Scenario: A nested hit

- **GIVEN** the scope `/data` that holds `raw/counts.csv` and `figures/volcano.png`
- **WHEN** a client sends `GET /api/v1/fs/search?path=/data&q=volc`
- **THEN** the server answers 200 with one hit, whose `entry.name` is `volcano.png`, whose `entry.path` is `/data/figures/volcano.png`, and whose `subpath` is `figures`
- **AND** `entry.kind` is `figure`

#### Scenario: A folder is a hit

- **GIVEN** the scope `/data` that holds the folder `figures`
- **WHEN** a client searches `/data` for `fig`
- **THEN** one hit has `entry.name` `figures`, `entry.type` `folder`, and `subpath` the empty string

#### Scenario: A hidden entry stays out of the hits

- **GIVEN** the scope `/data` that holds `.cache/volcano.png` and `figures/volcano.png`
- **WHEN** a client searches `/data` for `volcano` with no `hidden`
- **THEN** the hits hold `figures/volcano.png` only
- **AND** a search with `hidden=true` gives the two entries

#### Scenario: The best hits only

- **GIVEN** a scope with 30 entries whose name matches `a`
- **WHEN** a client searches for `a` with `limit=10`
- **THEN** the response holds 10 hits, in the order of the score

#### Scenario: One ledger read for the hits

- **GIVEN** analysis `a1` whose workspace folder is the scope, and a runtime that is ready
- **WHEN** a client searches the scope with `analysisId=a1` and gets 5 hits
- **THEN** the server sends one read of the artifact ledger, for the paths of the 5 hits
- **AND** each hit inside the workspace folder carries the `origin` of its ledger row

#### Scenario: The facts come for the hits only

- **GIVEN** a scope with 1000 entries, of which 3 match the query
- **WHEN** a client searches the scope
- **THEN** the server reads the facts of the 3 hits, and of no other entry

### Requirement: A search walks a scope one time and keeps a name index

The server MUST keep one name index for each canonical scope and `hidden` value. The first search of a scope MUST start the walk of the scope. A later search of the same scope MUST score the index in memory, while the walk runs or after it. It MUST NOT start a second walk. Two concurrent searches of one scope MUST share one walk.

A search during the walk MUST score the entries that the walk reached so far, with `truncated` true. A search MUST wait for the read of the scope itself. Then it MUST wait for the walk only until a short bound (500 ms) after the start of the walk. Thus a search of a small scope answers complete in one request, and a later keystroke during the walk answers at once.

The walk MUST read each folder with one read of its names and types. It MUST take no `stat` of an entry. It MUST NOT enter a symbolic link. It MUST skip a folder that it cannot read, and the search MUST still answer. The walk MUST read folders in a queue of fixed width.

The index MUST keep the name and the parent of each entry. It MUST NOT keep a full path string for each entry. The server MUST build the full path of a hit only for the hits of a response.

A client disconnect MUST NOT stop the walk. The walk belongs to the index, and the next keystroke of the same picker reads the same index. The walk stops only at a cap, at the end of the scope, or when the server evicts the index.

#### Scenario: A second search scores the index

- **GIVEN** a scope whose walk is complete
- **WHEN** a client searches the scope a second time with a different `q`
- **THEN** the server reads no folder of the scope, and it answers from the index

#### Scenario: Concurrent searches share one walk

- **WHEN** two clients search one scope at the same time
- **THEN** the server reads each folder of the scope one time

#### Scenario: An unreadable folder is skipped

- **GIVEN** a scope that holds the folder `locked` with mode 000 and the file `open.csv`
- **WHEN** a client searches the scope for `open`
- **THEN** the server answers 200 with `open.csv`, and `locked` is an entry of the index
- **AND** `truncated` is false after the walk ends

#### Scenario: A symbolic link is not entered

- **GIVEN** a scope that holds a link `ext` to a folder that holds `deep.csv`
- **WHEN** a client searches the scope for `deep`
- **THEN** the hits are empty, and a search for `ext` gives the link entry

#### Scenario: A disconnect keeps the walk

- **GIVEN** a search whose walk runs
- **WHEN** the client closes the connection before the response
- **THEN** the walk continues, and the next search of the scope finds the index more complete

### Requirement: A search is bounded in time and memory

The server MUST stop a walk at each of these caps, and the response MUST then carry `truncated` true:

- a depth below the scope
- a count of entries for one index
- a count of entries across all indexes
- a time budget for the walk

The server MUST also bound the count of indexes. The server MUST evict an index that no search used for a TTL, with or without a later search. When a new index would exceed the count across all indexes, the server MUST evict the least recently used index first. An eviction MUST stop the walk of the evicted index.

#### Scenario: The entry cap truncates

- **GIVEN** a server whose entry cap for one index is 10, and a scope with 25 entries
- **WHEN** a client searches the scope
- **THEN** the response has `truncated` true, and the index holds at most 10 entries

#### Scenario: The depth cap truncates

- **GIVEN** a server whose depth cap is 2, and a scope with the file `a/b/c/deep.csv`
- **WHEN** a client searches the scope for `deep`
- **THEN** the hits are empty, and `truncated` is true

#### Scenario: An idle index is evicted

- **GIVEN** a server whose TTL is 1 s, and a scope that a client searched
- **WHEN** 2 s pass and the client searches the scope again
- **THEN** the server walks the scope again

#### Scenario: The total cap evicts the oldest index

- **GIVEN** a server whose total cap holds two indexes and not three
- **WHEN** a client searches three scopes in order
- **THEN** the index of the first scope is evicted, and the two later indexes stay

#### Scenario: A later keystroke does not wait

- **GIVEN** a scope whose walk started more than 500 ms ago and still runs
- **WHEN** a client searches the scope
- **THEN** the server answers at once with the entries so far, and `truncated` is true

### Requirement: The search refuses a bad request with a named error

The search route MUST take the `path` rules of the list: 400 `validation_error` for an absent, relative, or NUL path, and for a `hidden` value that is not `true` or `false`. It MUST answer 404 `not_found` when the scope does not exist, and 400 `validation_error` when the scope names a file. It MUST answer 403 `forbidden` with `details.code` when the server cannot read the scope. The route MUST take the analysis guard of the file system routes.

#### Scenario: A relative scope

- **WHEN** a client sends `GET /api/v1/fs/search?path=data&q=a`
- **THEN** the server answers 400 `validation_error`

#### Scenario: An absent scope

- **WHEN** a client searches an absolute path that does not exist
- **THEN** the server answers 404 `not_found`

#### Scenario: An unreadable scope

- **GIVEN** a folder whose mode is 000, and a server that does not run as root
- **WHEN** a client searches the folder
- **THEN** the server answers 403 `forbidden`, and `details.code` is `EACCES`

#### Scenario: An unknown analysis

- **WHEN** a client sends `GET /api/v1/fs/search?path=/&q=a&analysisId=nope`, and no analysis has the id `nope`
- **THEN** the server answers 404 `not_found`, and it reads no folder
