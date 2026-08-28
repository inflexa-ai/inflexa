# Shape the lineage chain

## Why

The manual run showed two faults. The popover renders the flat node set of
the walk. Thus a three-hop chain shows thirty rows, siblings and bookkeeping
included, and the panel overflows the page. The control is a bare text glyph,
and it reads poorly beside the marker.

## What Changes

- The popover renders the chain from the edges of the walk. The rail
  alternates the artifact, its producing command with the script and the step,
  and the files that the command read. Each input continues with its own
  producer, down to the raw inputs. Off-chain files collapse behind one count
  row, and bookkeeping nodes never render.
- The control becomes a stroke-drawn branch glyph, muted at rest and primary
  on hover, with an accessible label.
- The popover takes the locked anatomy. A header carries the hop count. The
  rows carry type tags, dimmed path prefixes, hash heads, and connector
  labels. The body scrolls inside a capped height, above a completion footer.
- The design fixture covers the new anatomy, and the render tests pin it.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `report-render`: the popover requirement gains the edge-walk rail, the
  sibling collapse, and the scroll cap.
- `report-design-system`: the popover component requirement gains the branch
  glyph and the rail tints.

## Impact

- `src/report-render/page.ts` — the chain builder over the walk edges, and
  the popover script.
- `src/report-render/views/lineage.tsx`, `views/references-view.tsx` — the
  control glyph.
- `src/report-render/design.ts` — the popover and rail classes.
- `src/report-render/fixture.ts`, the render tests, and the validity gate.
- The reference mockup is the design canvas artboard "Main", from this
  session's exploration.
