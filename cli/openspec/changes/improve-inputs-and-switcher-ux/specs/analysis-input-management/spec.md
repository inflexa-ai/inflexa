## ADDED Requirements

### Requirement: The flat inputs list removes more than one input in one pass

The TUI MUST give a flat list of the analysis's registered inputs, and that list MUST be
multi-select. Space toggles a row, and one confirm removes each selected input.

The removals MUST go through the shared `removeInput` operation, one call for each
selected row. A failed removal MUST NOT stop the removals that follow it, because each
row is independent.

This surface MUST stay beside the file picker, and MUST NOT fold into it. An analysis can
span any number of folders. The picker seeds an input outside its browse root, but it
renders no row for that input until the user browses to its folder. Thus the flat list is
the one view of the whole input set.

#### Scenario: Two inputs go in one pass

- **WHEN** the user toggles two inputs and confirms
- **THEN** both rows are removed, and each removal emits `prov.input_removed`

#### Scenario: A far input is reachable without browsing

- **GIVEN** an input that lives outside the anchor folder of the analysis
- **WHEN** the user opens the flat inputs list
- **THEN** that input renders as a row, and the user can remove it with no navigation

#### Scenario: One failed removal keeps the others

- **WHEN** one selected row fails to remove and the others succeed
- **THEN** the others are removed, and the surface reports the failure

### Requirement: The flat inputs list names an input by its absolute path

The row title MUST be the absolute path of the input, resolved through
`resolveInputPath`. It MUST NOT be the stored `path`, which is relative to the anchor.

A directory row MUST carry a trailing path separator, as the file picker rows do.

The row MUST carry a `meta` line with the kind, the size, and the modification date. The
row MUST use `meta`, and not `hint`, because an absolute path is long and it wraps.

An input whose file is gone MUST still list, and MUST still be removable. Its `meta` line
reports that the file is absent. Removal resolves against the registered set, never
against the filesystem.

#### Scenario: The row names the full path

- **WHEN** the flat inputs list opens for an analysis with an input under its anchor
- **THEN** the row title is the absolute path, not the anchor-relative stored path

#### Scenario: A directory is distinguishable

- **WHEN** the list holds a directory input and a file input
- **THEN** the directory row ends with a path separator and its `meta` line says directory

#### Scenario: A deleted file is still removable

- **GIVEN** a registered input whose file was deleted from disk
- **WHEN** the user opens the flat inputs list
- **THEN** the row lists, its `meta` line reports the absent file, and removal succeeds
