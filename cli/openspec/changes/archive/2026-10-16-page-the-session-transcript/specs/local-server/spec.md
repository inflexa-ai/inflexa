# Spec Delta

## MODIFIED Requirements

### Requirement: The API has one error body and one list shape

Each error response MUST have the body `{error, message, details?}`, and each code MUST have one status:

| Code | Status |
|-|-|
| `invalid_json`, `validation_error` | 400 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict`, `busy`, `locked` | 409 |
| `range_not_satisfiable` | 416 |
| `internal_error` | 500 |
| `unavailable`, `draining` | 503 |

A `validation_error` MUST carry the zod flatten output in `details`. A 500 MUST carry a generic message, and the cause MUST go only to the log. An unknown path MUST get 404 `not_found`.

Each list MUST take the query values `page` (zero-based, default 0) and `perPage` (default 100, cap 200). A bad value MUST fall back to the default, and it MUST NOT give a 400. A `page` whose offset, the page times `perPage`, is not a safe integer is a bad value. The response MUST be `{<resource>: T[], total, page, perPage, hasMore}`, where the key names the resource. A list MUST add a different field to this shape only when its own requirement names that field, for example `folder` of the folder list.

The transcript read `GET {T}/messages` is the one list that pages by a cursor. It takes `before` and `limit` in place of `page` and `perPage`, as its own requirement states.

#### Scenario: A body that is not JSON

- **WHEN** a client sends `POST /api/v1/projects` with a body that is not JSON
- **THEN** the server answers 400 with the error `invalid_json`

#### Scenario: A bad page value

- **WHEN** a client sends `GET /api/v1/projects?perPage=abc`
- **THEN** the server answers with `perPage` 100

#### Scenario: A page past the safe integers falls back

- **WHEN** a client sends `GET /api/v1/projects?page=99999999999999999999`
- **THEN** the server answers 200 with `page` 0

## ADDED Requirements

### Requirement: The transcript read gives one page of turns

`GET {T}/messages` MUST give one page of the transcript of the thread. A page holds whole turns, and the pages go from the newest turn to the oldest turn.

The read MUST take these query values:

- `limit`: the maximum count of turns in the page. The default is 20, and the maximum is 100. A value that is absent, or that is not a positive integer, MUST give 20, and it MUST NOT give a 400. A larger value MUST give 100.
- `before`: the cursor that an earlier page of the same thread gave. With no `before`, the read MUST give the newest page. A value that is not a decimal integer from 0 to the largest safe integer MUST give 400 `validation_error`. An empty value is such a value.

The response MUST be `{messages, total, page, perPage, hasMore, before}`:

- `messages` holds the messages of the turns of the page, in chat order: the oldest turn first.
- `before` is the cursor of the next older page, as a string. It is `null` when the page holds the start of the session.
- `total` is the count of the turns of the page, and `page` is 0.
- `perPage` is the limit that the server applied.
- `hasMore` is true when `before` is not `null`.

A cursor is opaque. A client sends back the `before` of a page, and it does not make a cursor.

The server MUST read from the store only the turns of the page. Thus a request costs about the same for a long thread and for a short thread. A thread with no live row MUST give 404 `not_found`. A failed read of the store MUST give 500 `internal_error`.

#### Scenario: A read with no cursor gives the newest turns

- **GIVEN** a thread of 30 turns
- **WHEN** a client sends `GET {T}/messages`
- **THEN** the messages are the messages of the newest 20 turns, in chat order
- **AND** `total` is 20, `perPage` is 20, `hasMore` is true, and `before` is not `null`

#### Scenario: The cursor of a page gives the turns before it

- **GIVEN** a thread of 30 turns, and the `before` of its newest page of 20 turns
- **WHEN** a client sends `GET {T}/messages?before=<that cursor>`
- **THEN** the messages are the messages of the oldest 10 turns, in chat order
- **AND** `total` is 10, `hasMore` is false, and `before` is `null`

#### Scenario: A short thread fits in one page

- **GIVEN** a thread of 3 turns
- **WHEN** a client sends `GET {T}/messages`
- **THEN** the messages are the messages of the 3 turns, `hasMore` is false, and `before` is `null`

#### Scenario: The limit has a maximum and a default

- **WHEN** a client sends `GET {T}/messages?limit=500`, and then `GET {T}/messages?limit=abc`
- **THEN** the first response has `perPage` 100, and the second response has `perPage` 20

#### Scenario: A bad cursor is refused

- **WHEN** a client sends `GET {T}/messages?before=abc`
- **THEN** the server answers 400 with the error `validation_error`, and it reads no turn

#### Scenario: The server reads only the turns of the page

- **GIVEN** a thread of 500 turns
- **WHEN** a client sends `GET {T}/messages?limit=20`
- **THEN** the server reads the 20 newest turns from the store, and no other turn

#### Scenario: A thread with no row

- **WHEN** a client sends `GET {T}/messages` for a thread that has no live row
- **THEN** the server answers 404 with the error `not_found`
