# reference-downloads Specification

## Purpose
Let an agent download reference data over HTTPS into the reference store. An unknown host needs the approval of the user, and later agents use the data again.

## Requirements

### Requirement: The download_ref tool exists only when the host binds downloads

The harness MUST give the `download_ref` tool to the conversation agent and to each step agent only when the embedder binds the download options. With no download options, no agent MUST get the tool. `download_ref` MUST be the only tool that writes a downloaded file to disk.

#### Scenario: A host with download options

- **GIVEN** an embedder that binds the download options
- **WHEN** a conversation agent and a step agent are built
- **THEN** each one has the `download_ref` tool

#### Scenario: A host with no download options

- **GIVEN** an embedder that binds no download options
- **WHEN** the agents are built
- **THEN** no agent has the `download_ref` tool

### Requirement: The URL gives the store path of a download

The tool MUST write each file to `<store>/<host>/<path of the URL>`, with no query string. When the response gives a file name in `Content-Disposition`, that name MUST replace the last segment of the path. The tool MUST refuse a path segment that is empty, `.`, or `..`.

#### Scenario: A plain file URL

- **WHEN** an agent downloads `https://ftp.ensembl.org/pub/release-116/fasta/x.fa.gz`
- **THEN** the file is at `/mnt/refs/ftp.ensembl.org/pub/release-116/fasta/x.fa.gz`

#### Scenario: A query string and a header name

- **WHEN** an agent downloads `https://zenodo.org/records/1/files/ref.tar?download=1` and the response names `ref.tar`
- **THEN** the file is at `/mnt/refs/zenodo.org/records/1/files/ref.tar`

### Requirement: A call downloads from one host over HTTPS

A call MUST take a list of URLs. Each URL MUST use HTTPS, and each URL MUST have the same host. The tool MUST refuse a different call before any download. The tool MUST accept at most 5 redirects, each hop MUST use HTTPS, and each resolved address MUST be a public address.

#### Scenario: Two hosts in one call

- **WHEN** a call gives URLs on `ftp.ebi.ac.uk` and on `ftp.ensembl.org`
- **THEN** the call fails with an error that names the two hosts, and no file is written

#### Scenario: A redirect to a private address

- **WHEN** a download redirects to an address in a private range
- **THEN** that file fails, and no file is written for it

### Requirement: A download from an unknown host needs approval for the host

A download from a host on the auto-approve list MUST run with no ask. A host matches an entry when it is the entry or a subdomain of it. A download from a different host MUST ask the user before it runs. The ask MUST name the host and each URL. Its grant key MUST be `download-ref:<host>` with the user scope, thus an `always` reply grants that host to the user in each analysis.

#### Scenario: A host on the list

- **GIVEN** `ncbi.nlm.nih.gov` on the auto-approve list
- **WHEN** an agent downloads from `ftp.ncbi.nlm.nih.gov`
- **THEN** the download runs, and no ask is raised

#### Scenario: An always reply covers the host in a different analysis

- **GIVEN** a user who answered `always` to a download from `zenodo.org` in one analysis
- **WHEN** an agent of the same user downloads from `zenodo.org` in a different analysis
- **THEN** the download runs with no prompt

### Requirement: A completed download is visible in full or not at all

The tool MUST write each file to a `.part` file beside its target. It MUST rename the file to its target only after a complete transfer. A download that starts again MUST continue a `.part` file with a range request when the server accepts it. A failed file MUST NOT leave a file at its target path.

#### Scenario: A transfer that breaks

- **WHEN** the connection breaks during a download
- **THEN** no file is at the target path, and the result names the failed URL

### Requirement: The tool extracts an archive on request

With `extract: true`, the tool MUST extract a tar, gzip-compressed tar, or zip file into a directory beside it, named for the archive without its suffix. Then the tool MUST delete the archive. The extraction MUST write only regular files and directories, and it MUST skip each link entry. It MUST refuse an entry whose path is absolute or contains `..`. A gzip file of one file MUST stay compressed. The result MUST give the paths of the extracted files, up to a fixed limit, and the count of the files past the limit.

#### Scenario: A tarball

- **WHEN** an agent downloads `.../unite.tgz` with `extract: true`
- **THEN** its files are under `.../unite/`, `.../unite.tgz` is not in the store, and the result gives the path of each file

#### Scenario: An entry that escapes

- **WHEN** a tar file holds the entry `../../etc/x`
- **THEN** the extraction fails, and no file is written outside the directory of the archive

### Requirement: Each download records its source

Each completed file MUST add one line to `<store>/.inflexa/sources.jsonl` with its store path, its URL, and its time. Before a download, the tool MUST look for the URL in the record. When the record names the URL and its file is present, the tool MUST give that path and MUST NOT download again.

#### Scenario: A second agent asks for the same URL

- **GIVEN** a URL that an earlier call downloaded
- **WHEN** a different agent downloads the same URL
- **THEN** the call gives the existing path, and no transfer occurs

### Requirement: A URL that the server does not have gives the files of its folder

When the server answers 404 for a URL, the tool MUST read the page of the folder of that URL, with the same HTTPS rule, redirect limit, and address guard as a download. The failed file MUST then name the entries that the page links to inside that folder, at most 100. A folder that does not answer MUST leave the plain reason.

#### Scenario: A file name that is wrong

- **GIVEN** a folder page that links to `Homo_sapiens.GRCh38.dna.primary_assembly.fa.gz`
- **WHEN** an agent downloads a file of that folder that the server does not have
- **THEN** the failed file names the folder and `Homo_sapiens.GRCh38.dna.primary_assembly.fa.gz`

#### Scenario: A folder that does not answer

- **WHEN** an agent downloads a missing file, and its folder answers 404 too
- **THEN** the failed file gives the reason `the server answered HTTP 404`

### Requirement: The tool reports the progress of a call

While a call runs, the tool MUST emit `data-tool-progress` parts under one id for the call, with the id of the tool call and one line of text. A line MUST go out at the start of each file and at the start of each extraction. Between them, at most one line MUST go out in each interval of 2 seconds. A line MUST name the file, the bytes that arrived, the size when the server gives it, and the place of the file when the call has more than one file. The registry MUST mark the part as a transient conversation part that reconciles, thus the stored transcript does not hold it. A failed write of a line MUST NOT change the download.

In a sandbox step, the step MUST show the text of the line as the current activity of the step, under the activity key of the tool call. The line MUST NOT add an entry to the activity history.

#### Scenario: A call with two files

- **WHEN** an agent downloads `a.txt` of 1 byte and `b.txt` of 2 bytes in one call
- **THEN** the call emits the lines `a.txt: 0 B of 1 B, file 1 of 2` and `b.txt: 0 B of 2 B, file 2 of 2` under one id

#### Scenario: A download in a step

- **WHEN** a step agent downloads a file
- **THEN** the current activity of the step gives the line of the download, and the activity history holds no entry for the line
