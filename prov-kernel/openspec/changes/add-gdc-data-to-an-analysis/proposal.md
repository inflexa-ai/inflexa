# Record the origin of a downloaded input

## Why

An input records no origin. The `input_added` event gives only the path, the
directory flag, and the anchor. A host can download public data and add it as
an input. But the chain cannot show the source or the release of that data. It
also cannot show that the bytes agree with the source.

The first host feature that downloads data is the GDC download of the CLI. The
event is not specific to GDC.

## What Changes

- The new core event `input_acquired` records one download of public data into
  an input. It carries these values:
  - the actor who approved the download
  - the input ref, which is the same ref that `input_added` carries
  - the source name, for example `GDC`, the base URL, and the release of the
    source
  - the request, as the source states it, for example the GDC filter
  - for each file: the analysis-relative path, the sha256, the size, the source
    identifier, the URL, and the source digest when the source gives one
- `applyProvEvent` appends an `inflexa:AcquireInput` activity, with the source
  attributes. The agent of the actor is associated with that activity.
- The input entity has the same QName that `input_added` makes. The entity
  `wasGeneratedBy` the acquire activity.
- Each file entity has the same QName that `input_used` makes from the path and
  the hash. Thus the file that a step reads is the same node as the downloaded
  file.
- Each file entity `hadPrimarySource` a source entity, and the acquire activity
  used that source entity. The source entity QName derives from the source name
  and the source identifier. The entity carries the URL, the release, and the
  source digest.
- The host emits `input_acquired`, and then `input_added` for the same input.
  The `input_added` event does not change.
- The lineage read model classifies the acquire activity and the source entity.
  Thus a backward walk from a file that a step used ends at the source file.
- `SPEC.md` states the new rules, and the golden fixture covers the event.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `prov-kernel`: the core union gains `input_acquired`. The acquire activity
  and the source entity become part of the dialect and of the wire format.

## Impact

- `src/types.ts`: the new ref type for a download, with its file rows.
- `src/events.ts`: the union and the switch.
- `src/document.ts`: the new builder for the event. It uses `hadPrimarySource`
  from `@inflexa-ai/tsprov`.
- `src/lineage.ts`: the classification of the acquire activity and of the
  source entity.
- `SPEC.md` and the golden fixture.
- The event adds a member to the union and removes nothing. Thus the package
  gets a minor version bump from `0.7.0`, which is on npm.
- One GDC download for TCGA-BRCA gives 1,231 files. Thus one event can add
  approximately 2,500 entities to the document of the analysis.
