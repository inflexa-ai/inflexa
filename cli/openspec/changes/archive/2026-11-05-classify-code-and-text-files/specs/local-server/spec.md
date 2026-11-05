## MODIFIED Requirements

### Requirement: The server gives the home folder and the entries of a folder

`GET /api/v1/fs/home` MUST give `{path}`, the canonical path of the home folder of the OS user that runs the server. When the server cannot resolve the home folder, it MUST give the home path as the operating system gives it.

`GET /api/v1/fs/list?path=<absolute path>` MUST give the entries of one folder in the list shape, with the key `entries`. The response MUST also give `folder: {path, readable}`. `folder.path` is the canonical path of the folder, with each symbolic link resolved. `folder.readable` is the verdict of the mode bits and the owner ids for the server user.

Each entry MUST give these fields:

- `name`, and `path`: the canonical folder path joined with the name
- `type`: `file`, `folder`, or `symlink`, from the folder read. Each other type of entry is `file`.
- `kind`: the kind of the file from the kind map of the file system routes. It is `null` for a folder, for a link whose `targetKind` is `folder`, and for a name that the map does not know.
- `language`: the highlighter language of the file from the map of the file system routes. It is `null` for a folder and for a link whose `targetKind` is `folder`. It is `text` for a name that the map does not know.
- `link`: `null` for an entry that is not a link. For a link, it is `{target, broken, targetKind}`:
  - `target`: the text that the link stores, or `null` when the server cannot read it
  - `broken`: true when the read of the target fails with `ENOENT` or `ENOTDIR` (the target does not exist), or with `ELOOP` (the chain of links loops). Each other failure, for example `EACCES`, gives `false`.
  - `targetKind`: `file` or `folder`, or `null` when the server cannot read the target
- `size`: the size in bytes of a file, or `null` for a folder
- `modifiedAt`: the time of the last change, as an ISO 8601 string
- `mode`: the permission bits
- `readable` and `writable`: the verdict of the mode bits and the owner ids for the server user
- `hidden`: true when the name starts with `.`
- `itemCount`: for a folder and for a link whose `targetKind` is `folder`, the count of the names in that folder. The count obeys the `hidden` value of the request. Thus it is equal to the `total` of a list of that folder with the same value. It is `null` for each other entry, and for a folder that the server cannot read.
- `isInput`: true when the entry is a declared input of the analysis of `analysisId`, or is inside a declared input folder. The server compares the path of the entry with the canonical absolute path of each input. A declared input file marks only its own path. A declared input folder marks its own path and each path inside it, with a boundary-safe test: `/a/bc` is not inside `/a/b`. An input whose anchor folder the server cannot locate marks no entry.
- `origin`: `{runId, stepId}` of the step that wrote the file, from the artifact ledger of the analysis of `analysisId`. It is `null` when the ledger has no row for the path, or when its row has no run or no step. It is also `null` for a path outside the workspace folder of the analysis.

Without `analysisId`, each `isInput` MUST be false and each `origin` MUST be `null`. Thus one route serves the picker of an analysis and the folder browser of a new analysis.

For a link, `size`, `modifiedAt`, `mode`, `readable`, and `writable` MUST describe the target. A fact that the server cannot read MUST be `null`, and the entry MUST stay in the list. `folder.readable` MUST be `null` when the server cannot read the facts of the folder. On a platform with no POSIX user ids, `mode`, `readable`, `writable`, and `folder.readable` MUST be `null`.

The sort MUST use the type from the folder read: each `folder` first, then each other entry. Each group MUST be in case-insensitive name order, with a fixed order for two names that differ only in case. Thus a link to a folder sorts with the files.

The list MUST hide each hidden entry. The query value `hidden=true` MUST show them. `total` MUST count the entries after this filter.

The query value `namePrefix` MUST select the entries whose name starts with the prefix, with no regard to case. A hidden entry MUST come back only when the prefix starts with a dot. With a non-empty prefix, `hidden` does not change which entries come back. An absent or empty `namePrefix` is no prefix, and the hidden rule of the request applies. `total` MUST count the entries after the prefix filter.

The list MUST take the paging values of the other lists. The server MUST read the facts, the item count, the input mark, and the origin only for the entries of the page. It MUST read the facts and the item counts in a queue of fixed width.

The server MUST read the declared inputs and locate the workspace folder at most one time for each request. It MUST send at most one read of the artifact ledger for each page. It MUST send no ledger read when no entry of the page is inside the workspace folder.

The server MUST read the artifact ledger only when the runtime boot is ready. Before that, each `origin` MUST be `null`, and the list MUST still answer. A failed ledger read MUST give `null` for each `origin`, and the list MUST still answer. A failed read of the declared inputs or of the workspace folder of the analysis in the database of the server MUST give 500 `internal_error`.

The server MUST run each read of the list off the event loop. A folder on a hung mount MUST stop only its own request.

#### Scenario: The home folder

- **WHEN** a client sends `GET /api/v1/fs/home`
- **THEN** the server answers 200 with the canonical path of the home folder of the server user in `path`

#### Scenario: A home folder behind a link

- **GIVEN** a server user whose home path holds a symbolic link
- **WHEN** a client sends `GET /api/v1/fs/home`
- **THEN** `path` is the real path of the home folder, with each link resolved

#### Scenario: A folder lists folders first

- **GIVEN** a folder that holds the folder `beta`, the files `alpha.txt` and `Zeta.txt`, and the file `.env`
- **WHEN** a client lists the folder
- **THEN** the entries are `beta`, `alpha.txt`, and `Zeta.txt`, in this order, and `total` is 3
- **AND** `beta` has the type `folder`, the kind `null`, and a `null` size
- **AND** `alpha.txt` has the kind `doc`, its size, its time, its mode, and `readable` true

#### Scenario: The hidden entries show on request

- **GIVEN** the same folder
- **WHEN** a client lists it with `hidden=true`
- **THEN** the entries include `.env` with `hidden` true, and `total` is 4

#### Scenario: A link gives its target

- **GIVEN** a folder that holds a link `data` to a folder, and a link `gone` to a path that does not exist
- **WHEN** a client lists the folder
- **THEN** `data` has the type `symlink`, its stored target, `broken` false, `targetKind` `folder`, and the kind `null`
- **AND** `gone` has `broken` true, `targetKind` `null`, and `null` facts
- **AND** both links sort after each `folder` entry

#### Scenario: A page of a large folder

- **GIVEN** a folder that holds 250 files
- **WHEN** a client lists it with `page=1` and `perPage=100`
- **THEN** the entries are the 101st to the 200th entry of the sort, `total` is 250, and `hasMore` is true

#### Scenario: The canonical path of a folder

- **GIVEN** a link `l` to a folder `f`
- **WHEN** a client lists the path of `l`
- **THEN** `folder.path` is the canonical path of `f`, and the path of each entry starts with it

#### Scenario: The item count of a folder

- **GIVEN** a folder that holds the folder `sub` with the files `a.csv` and `.hidden`, and the file `b.csv`
- **WHEN** a client lists the folder
- **THEN** `sub` has `itemCount` 1, and `b.csv` has `itemCount` `null`
- **AND** with `hidden=true`, `sub` has `itemCount` 2

#### Scenario: A folder that the server cannot read

- **GIVEN** a folder that holds the folder `locked` with mode 000, and a server that does not run as root
- **WHEN** a client lists the folder
- **THEN** `locked` stays in the list with `itemCount` `null`

#### Scenario: A name prefix

- **GIVEN** a folder that holds `Counts.csv`, `counts-raw.csv`, `meta.json`, and `.counts`
- **WHEN** a client lists it with `namePrefix=cou`
- **THEN** the entries are `counts-raw.csv` and `Counts.csv`, in the order of the sort, and `total` is 2

#### Scenario: A name prefix with a dot

- **GIVEN** the same folder
- **WHEN** a client lists it with `namePrefix=.c` and no `hidden`
- **THEN** the one entry is `.counts`

#### Scenario: No analysis

- **GIVEN** a folder that is a declared input of analysis `a1`, with a file that a step of `a1` wrote
- **WHEN** a client lists the folder with no `analysisId`
- **THEN** each entry has `isInput` false and `origin` `null`

#### Scenario: A declared input folder

- **GIVEN** analysis `a1` with the declared input folder `/data/study`
- **WHEN** a client lists `/data` with `analysisId=a1`
- **THEN** the entry `study` has `isInput` true, and the entry `study-old` has `isInput` false
- **AND** a list of `/data/study` with `analysisId=a1` gives `isInput` true for each entry

#### Scenario: The step that wrote a file

- **GIVEN** analysis `a1` whose workspace folder is `<W>`, and the ledger row `runs/r1/s1/output/de.csv` of run `r1` and step `s1`
- **WHEN** a client lists `<W>/runs/r1/s1/output` with `analysisId=a1`, after the runtime boot is ready
- **THEN** the entry `de.csv` has `origin` `{runId: "r1", stepId: "s1"}`
- **AND** an entry with no ledger row has `origin` `null`

#### Scenario: One ledger read for each page

- **GIVEN** analysis `a1`, and a folder of its workspace that holds 150 files
- **WHEN** a client lists the folder with `analysisId=a1` and `perPage=100`
- **THEN** the server sends one ledger read with the 100 relative paths of the page

#### Scenario: A folder outside the workspace

- **GIVEN** analysis `a1`, and a folder outside its workspace folder
- **WHEN** a client lists the folder with `analysisId=a1`
- **THEN** the server sends no ledger read, and each `origin` is `null`

#### Scenario: The origin before the runtime boot is ready

- **GIVEN** analysis `a1`, and a server whose runtime boot is not ready
- **WHEN** a client lists a folder of the workspace of `a1` with `analysisId=a1`
- **THEN** the server answers 200, and each `origin` is `null`

### Requirement: The file system routes take the kind of a file from its extension

The server MUST hold one map from the extension or the name of a file to the kind and the highlighter language of the file. Each route that gives the kind or the language of a file MUST use this map, thus a client keeps no map of its own. Each language MUST be a language id of the shiki highlighter, or `text`. The map is:

| Kind | Language | Extensions and names |
| --- | --- | --- |
| `table` | `text` | `xlsx`, `xls`, `parquet` |
| `table` | `csv` | `csv` |
| `table` | `tsv` | `tsv`, `tab` |
| `figure` | `text` | `png`, `jpg`, `jpeg`, `gif`, `webp` |
| `figure` | `xml` | `svg` |
| `code` | `python` | `py`, `smk`, the name `Snakefile` |
| `code` | `r` | `r` |
| `code` | `json` | `ipynb` |
| `code` | `bash` | `sh`, `bash`, `zsh`, `sbatch`, `slurm` |
| `code` | `awk` | `awk` |
| `code` | `perl` | `pl`, `pm` |
| `code` | `julia` | `jl` |
| `code` | `matlab` | `m` |
| `code` | `sql` | `sql` |
| `code` | `nextflow` | `nf`, the name `nextflow.config` |
| `code` | `groovy` | `groovy` |
| `code` | `text` | `wdl` |
| `code` | `yaml` | `cwl`, `yaml`, `yml` |
| `code` | `stata` | `do` |
| `code` | `sas` | `sas` |
| `code` | `jinja` | `j2`, `jinja` |
| `code` | `make` | `mk`, the name `Makefile` |
| `code` | `docker` | the names `Dockerfile` and `Containerfile` |
| `code` | `toml` | `toml` |
| `code` | `ini` | `ini`, `cfg` |
| `code` | `dotenv` | the name `.env` |
| `code` | `gnuplot` | `gp` |
| `code` | `c` | `c`, `h` |
| `code` | `cpp` | `cpp`, `cc`, `hpp` |
| `code` | `rust` | `rs` |
| `code` | `go` | `go` |
| `code` | `java` | `java` |
| `code` | `javascript` | `js`, `mjs`, `cjs` |
| `code` | `jsx` | `jsx` |
| `code` | `typescript` | `ts`, `mts`, `cts` |
| `code` | `tsx` | `tsx` |
| `code` | `fortran-fixed-form` | `f` |
| `code` | `fortran-free-form` | `f90` |
| `code` | `diff` | `diff`, `patch` |
| `log` | `log` | `log` |
| `data` | `json` | `json` |
| `data` | `jsonl` | `jsonl` |
| `data` | `xml` | `xml` |
| `data` | `text` | `h5ad`, `h5`, `hdf5`, `loom`, `rds`, `rdata`, `rda`, `npy`, `npz`, `pkl`, `feather`, `mtx`, `bam`, `sam`, `cram`, `bai`, `vcf`, `bcf`, `bed`, `gff`, `gff3`, `gtf`, `fa`, `fasta`, `fna`, `faa`, `fastq`, `fq`, `bw`, `bigwig`, `bedgraph`, `fai`, `nwk`, `newick`, `sdf`, `mol2`, `tif`, `tiff`, `zip`, `tar`, `bz2`, `xz`, `zst` |
| `doc` | `markdown` | `md`, `rmd`, `qmd` |
| `doc` | `html` | `html`, `htm` |
| `doc` | `latex` | `tex` |
| `doc` | `bibtex` | `bib` |
| `doc` | `rst` | `rst` |
| `doc` | `text` | `txt`, `docx`, `pdf` |
| `structure` | `text` | `pdb`, `ent`, `cif`, `mmcif`, `bcif` |

The extension of a file name is the text after its last dot. A file name has no extension in each of these cases:

- It has no dot.
- Its only dot is its first character.
- It ends with a dot.

A name entry of the map MUST match the whole file name, and it wins over the extension. The match of an extension and of a name MUST have no regard to case.

For a file name that the table does not know, the server MUST use the language data of GitHub Linguist. The order of the lookup is:

1. A name entry of the table.
2. A Linguist language whose file names hold the whole file name.
3. The extension in the table.
4. A Linguist language whose extensions hold the extension.

The server MUST use only a Linguist language that has a shiki language id. The language id comes from the name or an alias of the Linguist language. FreeMarker and CQL have no shiki language id, because their aliases name the grammars of Fluent and of Cypher. When an extension has more than one such Linguist language, the language whose primary extension it is wins. The primary extension is the first extension of the Linguist language. Otherwise the first language in the order of the Linguist names wins. When a file name has more than one such Linguist language, the first language in the order of the Linguist names wins.

The kind of a Linguist language comes from its type:

| Linguist type | Kind |
| --- | --- |
| `programming` | `code` |
| `markup` | `code` |
| `prose` | `doc` |
| `data` | `data` |

The shiki language ids are the ids and the aliases of shiki 4.5.0, the highlighter of Flamme. A Linguist alias of a shiki id gives the shiki id, not the alias.

A file name that the table and the Linguist data do not know MUST give the kind `null` and the language `text`.

A file name whose extension is `gz` MUST take the kind of the extension before `.gz`, when the table knows that extension. Otherwise it MUST take the kind `data`. Its language MUST be `text`.

The kind and the language MUST come from the file name only. The folder of the file does not change them. Thus the kind can differ from the `fileType` of the artifact ledger, which comes from the folder.

#### Scenario: A table

- **WHEN** the server takes the kind of `counts.csv` and of `Counts.CSV`
- **THEN** each kind is `table`, and each language is `csv`

#### Scenario: A compressed table

- **WHEN** the server takes the kind of `counts.csv.gz`
- **THEN** the kind is `table`, and the language is `text`

#### Scenario: A compressed file of an unknown kind

- **WHEN** the server takes the kind of `reads.gz` and of `archive.tar.gz`
- **THEN** each kind is `data`

#### Scenario: An R script

- **WHEN** the server takes the kind of `analysis.R`
- **THEN** the kind is `code`, and the language is `r`

#### Scenario: A workflow file with no extension

- **WHEN** the server takes the kind of `Snakefile` and of `Dockerfile`
- **THEN** each kind is `code`, and the languages are `python` and `docker`

#### Scenario: A protein structure

- **WHEN** the server takes the kind of `1abc.cif`
- **THEN** the kind is `structure`

#### Scenario: A script of run_script

- **WHEN** the server takes the kind of `call_1.js` and of `plot.tsx`
- **THEN** each kind is `code`, and the languages are `javascript` and `tsx`

#### Scenario: A text note

- **WHEN** the server takes the kind of `README.txt`
- **THEN** the kind is `doc`, and the language is `text`

#### Scenario: A language that only Linguist knows

- **WHEN** the server takes the kind of `build.kts`, `main.swift`, and `Gemfile`
- **THEN** each kind is `code`, and the languages are `kotlin`, `swift`, and `ruby`

#### Scenario: A Linguist file name

- **WHEN** the server takes the kind of `.bashrc`
- **THEN** the kind is `code`, and the language is `shellscript`

#### Scenario: A Linguist file name wins over the extension in the table

- **WHEN** the server takes the kind of `CMakeLists.txt`
- **THEN** the kind is `code`, and the language is `cmake`

#### Scenario: A Linguist alias that names a different grammar

- **WHEN** the server takes the kind of `query.cql`
- **THEN** the kind is `null`, and the language is `text`

#### Scenario: The table wins over Linguist

- **WHEN** the server takes the kind of `fit.m` and of `run.do`
- **THEN** the languages are `matlab` and `stata`

#### Scenario: A name with no known kind

- **WHEN** the server takes the kind of `notes.xyz`, `README`, and `draft.`
- **THEN** each kind is `null`, and each language is `text`

### Requirement: The server gives a preview of a file or a folder

`GET /api/v1/fs/preview?path=<absolute path>` MUST give one member of the preview union for the file or the folder at the path. The path can name each file and each folder of the machine. The query value `analysisId` MUST NOT change the preview.

The server MUST remove each `.` and `..` segment of the path as text. It MUST resolve each symbolic link of the path, and preview the real path. Thus a link gives the preview of its target. A symbolic link that replaces the last part of the real path after this resolve MUST NOT give a preview of its target. For a folder, the server MUST make sure after the read that the real path is still the folder that it opened. Otherwise it MUST answer 403 `forbidden`.

The kind of a file comes from the name of the real path, through the kind map of the file system routes. The members are:

- `figure`, for a regular file of the kind `figure`: `{kind, src, alt}`. `src` is the URL of the read route for the real path, `/api/v1/fs/read?path=<the encoded real path>`, relative to the origin of the server. `alt` is the name of the file. The server MUST NOT read the bytes of a figure.
- `folder`, for a folder: `{kind, items, kinds, names}`. `items` is the count of the entries that are not hidden, in one level of the folder. `kinds` gives `{kind, count}` for each kind with a count above 0: `folder` first, then the order of the kind map. An entry whose name has no kind counts in `items` only. `names` gives `{name, dir, kind}` for the first 10 entries in the order of the folder list. `dir` is true for a folder, and `kind` is `null` for a folder. The kind and `dir` come from the folder read. Thus the server takes no `stat` of an entry, and a link to a folder counts as a file.
- `table`, for a delimited file: `{kind, text, separator, columnCount, rowCount}`. A delimited file has the kind `table`, or it has the kind `doc` and the extension `txt`. Its head holds the full header record, and its header holds a tab or a comma. The header record is the text before the first line end outside double quotes. `text` is the text of the head. `separator` is a tab when the header holds one, and a comma otherwise. `columnCount` is the count of the fields of the header. A separator inside double quotes does not split a field. `rowCount` is the count of the records after the header when the head holds the full file, and `null` otherwise. A line end inside double quotes does not end a record. An empty last line does not count.
- `text`, for each other file whose head is text: `{kind, language, code}`. `code` is the text of the head. `language` comes from the map of the file system routes. It is `text` for a name that the map does not know.
- `card`, for a file whose head holds a NUL byte, or a byte sequence that is not UTF-8: `{kind, format, mediaType}`. `format` is the extension of the name in lower case, or `null` for a name with no extension. `mediaType` is the `Content-Type` that `GET /api/v1/fs/read` gives for the name. Thus a client can select a renderer, for example for a PDF file, with no map of its own.

The server MUST read at most a fixed maximum count of bytes from the start of a file, the head. When the file is longer than the head, the text of the head MUST end at its last line end. A head with no line end keeps its text, and it ends at its last whole character. A head holds the full header record when it holds the full file, or when it holds a line end outside double quotes. A head that does not hold the full header record never gives `table`.

The server MUST read one level of a folder, with no `stat` for an entry. Its memory MUST NOT grow with the count of the entries.

The server MUST run each disk operation of the route off the event loop. A file or a folder on a hung mount MUST stop only its own request. The route MUST lift the idle timeout of its connection.

#### Scenario: A table

- **GIVEN** the file `counts.csv` with the text `gene,"a,b",c\nTP53,1,2\nEGFR,3,4\n`
- **WHEN** a client asks for the preview of the file
- **THEN** the server answers 200 with `kind` `table`, the full text, the separator `,`, `columnCount` 3, and `rowCount` 2

#### Scenario: A table longer than the head

- **GIVEN** a TSV file that is longer than the head
- **WHEN** a client asks for its preview
- **THEN** the member is `table` with the separator tab, the text ends with a line end, and `rowCount` is `null`

#### Scenario: A text file

- **GIVEN** the file `analysis.py`
- **WHEN** a client asks for its preview
- **THEN** the member is `text` with the language `python` and the text of the file

#### Scenario: A table file with no separator

- **GIVEN** the file `counts.tsv` whose first line holds no tab and no comma
- **WHEN** a client asks for its preview
- **THEN** the member is `text` with the language `tsv`

#### Scenario: A text note

- **GIVEN** the file `notes.txt` whose first line holds no tab and no comma
- **WHEN** a client asks for its preview
- **THEN** the member is `text` with the language `text`

#### Scenario: A code file with the extension txt

- **GIVEN** the file `CMakeLists.txt` whose first line holds a comma
- **WHEN** a client asks for its preview
- **THEN** the member is `text` with the language `cmake`

#### Scenario: A delimited text file

- **GIVEN** the file `GSE78220_counts.txt` with the text `gene\tS1\tS2\nTP53\t1\t2\n`
- **WHEN** a client asks for its preview
- **THEN** the member is `table` with the separator tab, `columnCount` 3, and `rowCount` 1

#### Scenario: A binary file

- **GIVEN** the file `matrix.h5ad`, whose head holds a NUL byte
- **WHEN** a client asks for its preview
- **THEN** the member is `card` with the format `h5ad` and the media type `application/octet-stream`

#### Scenario: A figure

- **GIVEN** the file `<P>/volcano.png`
- **WHEN** a client asks for its preview
- **THEN** the member is `figure` with `src` `/api/v1/fs/read?path=<the encoded path of the file>` and `alt` `volcano.png`

#### Scenario: A folder

- **GIVEN** a folder that holds the folder `raw`, the files `a.csv`, `b.csv`, `plot.png`, and `README`, and the file `.cache`
- **WHEN** a client asks for its preview
- **THEN** the member is `folder` with `items` 5
- **AND** `kinds` is `[{kind: "folder", count: 1}, {kind: "table", count: 2}, {kind: "figure", count: 1}]`
- **AND** `names` starts with `raw`, with `dir` true

#### Scenario: A link to a file

- **GIVEN** a symbolic link `latest.csv` to the file `run7.csv`
- **WHEN** a client asks for the preview of the link
- **THEN** the member is the preview of `run7.csv`

#### Scenario: A folder that is not the opened folder after the read

- **GIVEN** a folder whose real path names a different folder after the server opened it
- **WHEN** the server ends the read of the folder
- **THEN** the server answers 403 `forbidden`

#### Scenario: A link that replaces the file after the resolve

- **GIVEN** a file whose last part becomes a symbolic link after the server resolved the path
- **WHEN** the server opens the real path
- **THEN** the server answers 403 `forbidden`, and the response holds no byte of the target

#### Scenario: A PDF file

- **GIVEN** the file `paper.pdf`, whose head holds a byte sequence that is not UTF-8
- **WHEN** a client asks for its preview
- **THEN** the member is `card` with the format `pdf` and the media type `application/pdf`

