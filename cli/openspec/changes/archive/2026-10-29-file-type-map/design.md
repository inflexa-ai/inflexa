# Design

## Context

`src/modules/fs/file_kind.ts` holds the kind map, and `fileKindOf` is its only entry. `src/server/routes/fs.ts` holds a second map, `LANGUAGE_BY_EXTENSION`, for the text preview. `src/server/routes/files.ts` holds `CONTENT_TYPES`, the media type table of the read route.

## Goals / Non-Goals

**Goals:**

- One table for the kind and the language. The kind function and the language function read it.

**Non-Goals:**

- A kind filter on the ledger. The user removed it from the scope.
- A change to the TUI highlighter. The TUI uses its own grammars and does not read these fields.
- A second media type table. The card preview uses the lookup of the read route.

## Decisions

### One table in `file_kind.ts`

`file_kind.ts` holds one table of rows `[kind, language, keys]`. The module builds two maps from it: one for the extensions and one for the whole names. `fileKindOf(name)` and the new `languageOf(name)` read them. `LANGUAGE_BY_EXTENSION` goes away.

### Name keys

A name key, for example `snakefile` or `nextflow.config`, is in a separate map from the extension keys. Thus a file that is named `R` or `json` does not match an extension key. A name key wins over the extension, thus `nextflow.config` gives `nextflow` and not the extension `config`. A name key can hold a dot, as `nextflow.config` and `.env` do. The rule that the user approved names only the names with no dot. These two names extend the rule, because the user asked for more workflow and config files.

### The languages

Each language is an id of shiki 4.5.0, the version that Flamme uses. Some formats have no grammar in shiki:

- WDL gets `text`.
- Snakemake gets `python`, because a Snakefile is Python with rules.
- CWL gets `yaml`, because a CWL file is YAML.

Shell files get `bash`, the id that the preview already gives. Shiki accepts `bash` as an alias of `shellscript`.

### Collisions of extensions

- `m` gives `matlab`, not Objective-C, because the users are analysts.
- `pl` gives `perl`, not Prolog.
- `cif` gives the kind `structure`, also for a small-molecule CIF file.
- `tif` and `tiff` give the kind `data`, not `figure`. The figure preview gives the file to the browser as an image, and a browser does not show a TIFF file.

### The media type of a card

`files.ts` exports `contentTypeOf(name)`, the lookup that the read route uses. The card preview calls it. Thus the card and the read route give the same type for one name.

### The language of a folder

A folder entry and a link to a folder get `language: null`, as they get `kind: null`. A file that the map does not know gets `text`.

## Risks / Trade-offs

- [The map can go out of date when shiki renames an id.] → The design pins the ids to shiki 4.5.0. A client that cannot load an id shows plain text.
- [The kind `structure` is new in `FILE_KINDS`.] → A client that switches on the kind must add a branch. Flamme adds it in the himmel issue for structures.
