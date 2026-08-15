## Why

Five presentation faults, each verified on the first real report. The navigation shows no reading position. The page names the internal engine. The chart panel wears an application-window costume. The content sits left with a capped prose measure and a dead right margin. The auto-generated appendix wears the title "References", where a reader expects literature.

## What Changes

- **The scrollspy.** The page script highlights the anchor of the section in view, through an observer over the section anchors, with no dependency.
- **The wording.** The panel badge `CORTEX` goes. The footer reads `Powered by Inflexa`. The navigation brand links to the Inflexa site.
- **The chart frame.** The three-dot window chrome and the hover raise go. The chart renders in the square corner-accent card of the identity, with a fixed-height body.
- **The layout.** One centered content column holds every block kind, and the prose fills that column completely. The inner `72ch` cap goes.
- **The provenance appendix.** The auto-generated list renames to "Data provenance", styled as a muted appendix. The literature section stays separate.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-design-system`: the chart component loses the window chrome, the geometry loses its rounded exception, and the architecture gains the centered column and the identity wording.
- `report-render`: the navigation gains the scrollspy, and the reference list becomes the provenance appendix.

## Impact

- `harness/src/report-render/design.ts`, `page.ts`, and the views. No contract change, no tool change, and no store change.
