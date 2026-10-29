## MODIFIED Requirements

### Requirement: The server gives the bytes of a file at an absolute path

`GET /api/v1/fs/read?path=<absolute path>` MUST give the bytes of the file at the path. The path can name each file of the machine: a file of a workspace, a file of a declared input, or a file outside each analysis. The query value `analysisId` MUST NOT change which file the route reads.

The server MUST do these steps:

- It removes each `.` and `..` segment of the path as text.
- It resolves each symbolic link of the path, and gets the real path of the file. Thus a link gives the bytes of its target.
- It reads the bytes from the real path. A symbolic link that replaces the last part of the real path after this resolve MUST NOT give the bytes of its target.

The response MUST have these headers:

- `Content-Type` from the extension of the last part of the requested path, or `application/octet-stream` for an extension that the server does not know
- `X-Content-Type-Options: nosniff`
- `Accept-Ranges: bytes`
- `ETag`: a tag that changes when the size or the time of the last change of the file changes
- `Cache-Control: no-cache`, thus a browser asks again with the tag before it uses a copy
- `Content-Length`

The server MUST give a protein structure file a type of its format, thus a client can tell a structure from other data. A text format MUST get a `text/` type, thus a browser can show it. The types are:

| Extension | `Content-Type` |
| --- | --- |
| `.pdb`, `.ent` | `text/x-pdb; charset=utf-8` |
| `.cif`, `.mmcif` | `text/x-mmcif; charset=utf-8` |
| `.bcif` | `application/x-bcif` |

A type that a browser runs as a document with script MUST also get `Content-Security-Policy: sandbox`. These types are HTML, XHTML, SVG, and XML. Thus a script in such a file cannot use the session of the browser on the origin of the server. Without this header, a script in a file can read each file on the machine through this route.

The query value `download=1` MUST add `Content-Disposition: attachment` with the last part of the requested path as the file name.

A request whose `If-None-Match` names the current tag, or `*`, MUST get 304 with no body.

A `Range` header with one range of the unit `bytes` MUST give that part of the file with 206 and `Content-Range`. The forms are `bytes=<first>-<last>`, `bytes=<first>-`, and `bytes=-<count of last bytes>`. A `<last>` past the end of the file means the end of the file.

A range that starts at or after the size of the file MUST get 416 `range_not_satisfiable` with `Content-Range: bytes */<size>`. The server MUST ignore a `Range` header that holds more than one range, a different unit, or a bad form. It then gives the full file with 200. An `If-Range` header that does not name the current tag MUST also make the server ignore the `Range` header.

A `HEAD` request MUST get the same status and headers as the `GET`, and no body.

The server MUST stream the body from the open file, and it MUST NOT read a whole file into memory. It MUST run each disk operation of the route off the event loop. A file on a hung mount MUST stop only its own request. The route MUST lift the idle timeout of its connection. This rule does not cover the guard of `analysisId`. That guard reads the database and takes the lock as the guard of each `{A}` route does.

A read that fails after the server sent the status MUST end the body with an error, and the server MUST close the file. The client then gets fewer bytes than `Content-Length`, and it cannot read the cut body as complete.

The route accepts the bearer token or the session cookie of a browser sign-in, as each route under `/api/` does.

#### Scenario: A figure of a run

- **GIVEN** a browser that signed in, and the file `runs/R/A/figures/volcano.png` in the workspace `<W>` of analysis `a1`
- **WHEN** the browser sends `GET /api/v1/fs/read?path=<W>/runs/R/A/figures/volcano.png&analysisId=a1` with its session cookie
- **THEN** the server answers 200 with the bytes of the file, `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, and an `ETag`

#### Scenario: A file of a declared input

- **GIVEN** a declared input folder `/data/study`, outside the workspace, that holds `counts.csv`
- **WHEN** a client reads the absolute path `/data/study/counts.csv`
- **THEN** the server answers 200 with the bytes of the file

#### Scenario: A file outside the analysis

- **GIVEN** analysis `a1`, and the file `/tmp/notes.txt` outside its workspace and outside each of its declared inputs
- **WHEN** a client sends `GET /api/v1/fs/read?path=/tmp/notes.txt&analysisId=a1`
- **THEN** the server answers 200 with the bytes of the file

#### Scenario: A link gives the bytes of its target

- **GIVEN** a symbolic link `/data/latest.csv` to the file `/data/run7.csv`
- **WHEN** a client reads `/data/latest.csv`
- **THEN** the server answers 200 with the bytes of `/data/run7.csv` and `Content-Type: text/csv`

#### Scenario: A part of a file

- **GIVEN** a file of 1000 bytes
- **WHEN** a client reads it with `Range: bytes=0-99`
- **THEN** the server answers 206 with `Content-Range: bytes 0-99/1000` and the first 100 bytes

#### Scenario: A range past the end of the file

- **GIVEN** a file of 1000 bytes
- **WHEN** a client reads it with `Range: bytes=1000-`
- **THEN** the server answers 416 `range_not_satisfiable` with `Content-Range: bytes */1000`

#### Scenario: An unchanged file

- **GIVEN** a client that got a file and its `ETag`
- **WHEN** the client reads the same file with `If-None-Match` set to that tag, and the file did not change
- **THEN** the server answers 304 with no body

#### Scenario: A changed file

- **GIVEN** a client that got a file and its `ETag`
- **WHEN** a run writes the file again with a different size, and the client reads it with `If-None-Match` set to the old tag
- **THEN** the server answers 200 with the new bytes and a different `ETag`

#### Scenario: A download

- **WHEN** a client reads `<W>/runs/R/A/output/de.csv` with `download=1`
- **THEN** the response has `Content-Disposition: attachment` with the file name `de.csv`

#### Scenario: An HTML file runs in a sandbox

- **WHEN** a client reads an HTML file
- **THEN** the response has a `text/html` content type and `Content-Security-Policy: sandbox`

#### Scenario: An SVG file runs in a sandbox

- **WHEN** a client reads an SVG file
- **THEN** the response has an `image/svg+xml` content type and `Content-Security-Policy: sandbox`

#### Scenario: A HEAD request

- **WHEN** a client sends `HEAD` for a file
- **THEN** the server answers 200 with the headers of the `GET`, and no body

#### Scenario: A protein structure file gets the type of its format

- **WHEN** a client reads a file with each of the extensions `.pdb`, `.ent`, `.cif`, `.mmcif`, and `.bcif`
- **THEN** each response has the `Content-Type` that the table gives for the extension, and no `Content-Security-Policy`
