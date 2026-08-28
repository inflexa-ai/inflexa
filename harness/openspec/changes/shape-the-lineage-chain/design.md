# Design — shape-the-lineage-chain

## Context

The walk returns `nodes` and `edges`, and the popover script flattens `nodes`
(`src/report-render/page.ts:1142-1145`). The edges carry the structure: a
`generated` edge binds an artifact to its command, and a `used` edge binds a
command to a file it read. The locked mockup is the design canvas artboard
"Main": the hop rail, the branch glyph, and the collapse row.

## Goals / Non-Goals

**Goals:**

- The popover shows the true chain, and it never overflows the page.
- The control reads as a quiet branch glyph beside the marker.

**Non-Goals:**

- No walk change in tsprov. The engine result already carries the edges.
- No drawer and no drawn rail. The anchored popover stays.

## Decisions

### D1 — The script builds the rail from the edges

Start at the pinned entity. Its `generated` edge gives the command, and the
node attributes give the command label, the step, and the script. The `used`
edges of that command give the files it read. Each input file continues with
its own producer. The other `generated` edges of the same
command become one count row. A cycle guard and the walk frontier bound the
recursion. The dialect attribute names come from the kernel writer, the same
source the pin selector reads.

### D2 — The rail forms

Three row forms carry the chain. The pinned artifact takes the primary tint.
A producer row carries the glyph, the script, the step, and the hash head.
An input row carries the dimmed prefix. A raw input takes the terminal tint,
and it ends its branch. Connector labels sit on indent rails between rows. The body
scrolls inside a capped height.

### D3 — The control

One inline stroke SVG on the 16px grid, drawn in the view, muted at rest and
primary on hover. The accessible label stays on the button. The glyph rides
the shared marker emission point, thus every grounded kind gets it unchanged.

## Risks / Trade-offs

- [A document can carry two producers for one path] → The pin resolves by
  path and hash, thus the walk starts at one entity. The rail reads the edges
  of that entity only.
- [A deep pipeline] → The scroll cap bounds the panel, and the frontier mark
  stays honest.

## Migration Plan

Renderer-only. The next preview of any session picks the new page up.

## Open Questions

None. The mockup locks the anatomy.
