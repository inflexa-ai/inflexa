# Design

## Context

`src/modules/fs/file_kind.ts` holds the table `FILE_TYPES` and two maps from it: one for a whole name, and one for an extension. `fileKindOf` and `languageOf` read the maps. The routes `fs`, `artifacts`, and `analyses` call the two functions. The preview (`previewHead` in `src/server/routes/fs.ts`) selects the `table` member only for a file of the kind `table`.

Flamme highlights with shiki 4.5.0 (`packages/ui/src/highlight-code.ts` in the himmel repository). It sends the language of the server to shiki, and it uses `text` for an id that shiki does not bundle. The cli has no shiki dependency.

## Goals / Non-Goals

**Goals:**

- A file in a language that shiki 4.5.0 supports gets the shiki id of the language, also when the table does not list it.
- The table keeps its control of the readings of an analyst, for example `m` is MATLAB.

**Non-Goals:**

- No change in Flamme. The client map in `packages/ui/src/components/tables/file-tree.tsx` of himmel stays.
- No detection from the content of a file, for example a shebang line. The kind stays a function of the name.
- No TUI change. The TUI uses no file system route.

## Decisions

### The Linguist data is the fallback, and the table stays first

The `linguist-languages` package (9.5.0, MIT, data only) gives the extensions, the file names, the aliases, and the type of each GitHub Linguist language. The user approved it. A hand list covers only the languages that a person remembers to add. A dependency on shiki in the cli would add the grammars, and shiki has no map from an extension to a language.

The table stays first for its extensions, because Linguist gives some of them to a different language. A Linguist file name still wins over an extension of the table. For example, `tsconfig.json` gets the language `jsonc`, and it keeps the kind `data`. For example, Linguist gives `.m` to MATLAB, to Objective-C, and to five other languages.

### The cli holds a frozen list of the shiki ids

The join from a Linguist language to a shiki id needs the shiki ids in the cli. A constant in `file_kind.ts` holds each id of the `bundledLanguagesInfo` of shiki 4.5.0, with its aliases and its display name in lower case. The list comes from the installed shiki of himmel, as text. Thus the cli adds no shiki dependency. The list is in the production code, because the join reads it at runtime. The join by name and alias takes the place of a table of overrides, with one exception. FreeMarker has the alias `ftl`, and CQL has the alias `cql`. In shiki, these are the aliases of Fluent and of Cypher. Thus a deny set gives FreeMarker and CQL no shiki id.

The join tries, in order, the Linguist name in lower case, the same name with each space as `-`, and each Linguist alias. The first candidate in the shiki list gives the canonical shiki id. The join does not use `aceMode` or `codemirrorMode`, because they name an editor mode, not a grammar. For example, the `aceMode` of Vim script is `text`.

### The order of the lookup

The order is: a table name, a Linguist file name, a table extension, and a Linguist extension. A whole name is more specific than an extension. Thus `CMakeLists.txt` is CMake and not a text note. The `.gz` rule stays before the Linguist steps, and it reads the table only.

### The Linguist maps build on the first lookup

The import of the package loads each data module. The import of `file_kind.ts` loads the Linguist data, approximately 0.29 MB in the bundle. The maps build one time, on the first lookup that the table does not answer. The build is one pass over each Linguist language.

### The kind of a Linguist language comes from its type

`programming` and `markup` give `code`. CSS, Vue, and Svelte are `markup` in Linguist, and they are code for an analyst. `prose` gives `doc`, and `data` gives `data`.

### A `.txt` file is a doc, and the preview finds a table from the content

The kind comes from the name only. Thus `txt` gets `doc`, and the gate of `previewHead` also admits a `doc` file whose extension is `txt`. A Linguist file name such as `CMakeLists.txt` gives `code`, thus it stays code. The rule for the header record and the separator does not change. A GEO count matrix such as `GSE78220_counts.txt` still opens in the table viewer. It shows the Doc badge in a list, because the list does not read the content.

### `jsx` and `tsx` keep their own shiki ids

Issue #830 gives `jsx` to `javascript` and `tsx` to `typescript`. Shiki has the grammars `jsx` and `tsx`, and the `typescript` grammar does not read the JSX syntax. Thus the table gives `jsx` and `tsx` their own ids.

## Risks / Trade-offs

- [A shiki upgrade in Flamme can make the frozen list stale] → Then a new shiki language shows as plain text. Flamme uses `text` for an unknown id, thus a removed id also shows as plain text.
- [A Linguist upgrade can change the language of an extension] → The table controls each extension that an analysis uses often. The tests pin the scenarios of the spec.
- [The Linguist data adds approximately 590 KB to the binary] → The user accepted the dependency.
