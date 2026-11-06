## Context

The dialect records an input in two places, and neither place records an origin.

- `input_added` makes an `inflexa:Input` entity. Its QName derives from the
  anchor and the path (`src/document.ts:153`). An `inflexa:AddInput` action
  uses it (`src/document.ts:264`). The entity has no hash.
- `input_used` makes a file entity when a step reads a file. Its QName derives
  from the path and the hash (`src/document.ts:358`, `src/document.ts:631`). A
  staged input has no generation. Thus a backward walk ends at the staged file.

The CLI can download public data, for example a GEO Series, but the chain
records nothing about that download. The companion harness change adds a GDC
download, and the companion CLI change records it. This change gives the
dialect the words for that record.

Two facts constrain the design:

- A host-private event maps onto `appendLifecycleAction`, and the kernel needs
  no change for it (spec: "The kernel owns the dialect and nothing else"). But
  a private event is private format. The managed host and each reader of the
  document must read the origin of an input.
- `computeLineage` walks only the `generated` and the `used` edges
  (`src/lineage.ts:401`). Thus the origin must connect to the file through
  those two edges, or the walk does not reach it.

`@inflexa-ai/tsprov` gives `hadPrimarySource`, a derivation with the type
`prov:PrimarySource`.

## Goals / Non-Goals

**Goals:**

- A backward walk from a file that a step read reaches the source item, with
  no host logic.
- One event records one download: the source, the release, the request, and
  each file.
- The source digest and the local SHA-256 hash stay side by side. Thus a
  later reader can compare them.

**Non-Goals:**

- A digest comparison in `verifyProvenance`.
- A change to `input_added`.
- A GEO mapping. A later host change can use the same event.

## Decisions

### The download is a core lifecycle event

The core union gains `input_acquired` in the lifecycle family. The event
mints a fresh action activity, as `input_added` does. A host emits it one time
from a live bus, never from a durable replay. Thus a deterministic action
QName gives nothing.

This design rejects two alternatives:

- A host-private kind through `appendLifecycleAction`. The origin of an input
  is format that two hosts and each reader share. A private kind gives each
  host its own spelling.
- An optional origin on `input_added`, in the style of
  `derivedFromAnalysisId`. The download and the addition are two acts. The
  download made the bytes, and the addition put them into the analysis. One
  activity for the two acts hides that difference. The file rows also do not
  fit an event about one input.

### The event shape

```ts
export type ProvAcquiredFileRef = {
    /** The analysis-relative path that a step read records, for example `data/inputs/local/{input path}/…`. */
    path: string;
    /** The SHA-256 hash, in the same hash space as `ProvUsedInputRef.hash`. */
    hash: string;
    size: number;
    /** The identifier that the source gives, for example the GDC file UUID. */
    sourceId: string;
    url: string;
    /** The digest that the source publishes, when it publishes one. */
    sourceDigest?: { algorithm: string; value: string };
};

export type ProvAcquisitionRef = {
    source: { name: string; baseUrl: string; release: string };
    /** The request, in the form that the source defines. For GDC, the filter JSON. */
    request: string;
    files: ProvAcquiredFileRef[];
};

| { type: "input_acquired"; analysisId: string; actor: ProvActor; input: ProvInputRef; acquisition: ProvAcquisitionRef }
```

The `input` ref is the ref that the host gives to the `input_added` event of
the same input. Thus the two events touch one input entity.

### The statements

```
action-{id}          prov:type inflexa:AcquireInput
                     inflexa:source, inflexa:sourceUrl, inflexa:sourceRelease,
                     inflexa:request, inflexa:fileCount
                     wasAssociatedWith → the actor agent
input-{…}            wasGeneratedBy → action-{id}

for each file:
source-{srcDigest}   prov:type inflexa:Source
                     inflexa:source, inflexa:sourceId, inflexa:url,
                     inflexa:sourceRelease, inflexa:sourceDigest ("md5:<hex>")
action-{id}          used → source-{srcDigest}
file-{fileDigest}    prov:type inflexa:File
                     inflexa:path, inflexa:hash, inflexa:size,
                     inflexa:producer "acquisition"
file-{fileDigest}    wasGeneratedBy → action-{id}          id gen-{fileDigest}
file-{fileDigest}    hadPrimarySource → source-{srcDigest}  id primary-{fileDigest}
file-{fileDigest}    wasAttributedTo → the actor agent
```

`srcDigest` is the digest of `{source name}|{sourceId}`. Thus two downloads of
one GDC file make one source entity.

The file QName is `fileQName({ path, hash })`, the QName that `input_used`
makes. Thus the file that a step reads is the downloaded file, and `unified()`
merges the two declarations. The walk then goes from the file, through the
`generated` edge, to the action, and through the `used` edge, to the source.
The `hadPrimarySource` edge gives the direct `derived` edge to a reachability
consumer.

The generation edge uses the `gen-{fileDigest}` id of `file_written`. Thus a
file entity keeps one generation record. A second download of the same bytes
to the same path moves that record to the later action, under
last-write-wins.

### One record set for each file

The step reads files, not a manifest. Thus only a file-level record joins the
download to the read. A single manifest entity cannot make that join.

The cost is approximately 1 KB of PROV-JSON for each file. A TCGA-BRCA
download of the gene counts has 1,231 files. Thus the event adds
approximately 1.2 MB. A step that reads the same files already adds one
entity and one `used` edge for each file today. Thus the download adds a
cost of the same order.

### The lineage read model

- The entity kind `source` classifies an entity with the type
  `inflexa:Source`, and the QName prefix `source-` is the fallback.
- A source node carries `source`, `sourceId`, `url`, `release`, and
  `sourceDigest`. Its label is the `sourceId`.
- The acquire action classifies as an `action` activity with the
  `actionType` `AcquireInput`, under the current rule. Thus no new activity
  kind is necessary.
- A file node carries the producer `acquisition`.
- `findFileEntity` never returns a source node.

### Version

The package goes from `0.7.0` to `0.8.0`. `ProvEvent` and `LineageNode` each
gain a member. A consumer with an exhaustive switch on `LineageNode` fails to
compile until it reads the `source` kind. The CLI change does that work.

## Risks / Trade-offs

- [A host gives a path that no step read records] → The file entity stays
  alone, and the join does not occur. The spec requires the analysis-relative
  path that a step read records, and the CLI change states how it computes
  that path.
- [A large download makes a large document] → The estimate is 1 KB for each
  file, the same order as one step read of the same files. The host decides
  the size ceiling of a download.
- [A source publishes no digest] → `sourceDigest` is optional. The SHA-256
  hash still records the local bytes. The GDC clinical records have no GDC
  digest.
- [The request is opaque to the kernel] → The kernel stores the request as
  text. Each source defines its form. The kernel never parses it.

## Migration Plan

No stored document changes. A document without the event derives as before.
Publish `0.8.0` before the CLI release of the companion change.

## Open Questions

None.
