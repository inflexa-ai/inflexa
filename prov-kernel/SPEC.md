# The Inflexa PROV dialect — wire format

This document gives the exact rules of the Inflexa PROV dialect. The rules are
sufficient for an independent implementation, for example a Go writer. The
source of truth is `src/`. If the code and this document disagree, the code
wins, and this document has a defect.

A document is W3C PROV, serialized as PROV-JSON. The kernel builds it with
`@inflexa-ai/tsprov` and collapses duplicate records with `unified()` at
serialize time.

The serialized form is minified JSON — no whitespace between tokens. Object
members keep record insertion order, and each top-level section (`entity`,
`agent`, `activity`, each relation kind) appears at the position of its first
record. The committed fixture
`src/__fixtures__/golden-document.json` holds the exact bytes of one fully
deterministic document. A conforming producer must reproduce it
byte-for-byte, and the golden test compares the raw serialized string against
it.

## Namespace

Each Inflexa-minted identifier lives under one namespace:

| Item | Value |
|-|-|
| Prefix | `inflexa` |
| URI | `https://inflexa.ai/prov#` |

## The digest function

A short stable digest derives each content-keyed QName suffix and each
relation id. The default digest is:

1. Compute SHA-256 over the UTF-8 bytes of the identity string.
2. Take the first 8 bytes of the digest.
3. Read the 8 bytes as one big-endian unsigned 64-bit integer.
4. Render the integer in base36 with lowercase digits (`0-9a-z`).

The digest is **injectable**. It is identity-load-bearing: each file, input,
command, and model-agent QName embeds its output. A producer with existing
documents must keep its historical digest function, or its identifier space
forks. The default digest is canonical for new documents.

The localpart sanitizer `qnameSafe(s)` replaces each character that is not in
`[A-Za-z0-9_-]` with `_`. Only the user-actor id passes through it. The
`analysisId`, `runId`, and `stepId` values embed **unsanitized** into QNames
and relation ids. The host must supply values that are already QName-safe.

## QName formats

`digest(s)` is the injected digest. `|` is the literal pipe character.

### Agents

| Kind | QName | Attributes |
|-|-|-|
| user | `inflexa:agent-user-{qnameSafe(id)}` | `prov:type` `prov:Person`, optional `inflexa:email` |
| anonymous | `inflexa:agent-anonymous` | `prov:type` `prov:Person`, `prov:label` `Anonymous user` |
| system | `inflexa:agent-system` | `prov:type` `prov:SoftwareAgent`, `prov:label` = host label, `inflexa:version`, optional `inflexa:commit` |
| model | `inflexa:agent-model-{digest(model)}` | `prov:type` `["prov:SoftwareAgent", "inflexa:Model"]`, `prov:label` = model, `inflexa:model` |

The user QName keys on an **opaque stable id**, never on personal data. A
document is immutable and signed, thus the identity-bearing key must not
change when a person changes an email address, and a writer must not be
forced to embed personal data into an identifier. `inflexa:email` is an
optional attribute. A host can choose to include it; a cloud writer must
not.

The model identifier is the vendor-qualified `{provider}/{model}` name.

### Entities

| Kind | QName | Attributes |
|-|-|-|
| analysis subject | `inflexa:analysis-{analysisId}` | `prov:type` `inflexa:Analysis`, optional `inflexa:name`, optional `inflexa:slug` |
| staged input | `inflexa:input-{digest("{anchorId}\|{path}")}` | `prov:type` `inflexa:Input`, `inflexa:path`, `inflexa:isDir` |
| file | `inflexa:file-{digest("{path}\|{hash}")}` | see below |

For the staged-input QName, a null `anchorId` contributes the empty string.

The file digest is `fileDigest = digest("{path}|{hash}")` over the
analysis-relative path and the content hash. A written file and an input read
key into the **same** space, thus a read of a prior run's output resolves to
the entity that the write generated.

A written file carries `prov:type` `inflexa:File`, `inflexa:path`,
`inflexa:hash`, `inflexa:size`, and `inflexa:producer` (`command` or
`file_tool`). A read input carries `inflexa:path`, `inflexa:hash`,
`inflexa:source` (`data`, `upstream`, or `prior`), and optional
`inflexa:fileId`, with no `prov:type`.

### Activities

| Kind | QName | Formal times |
|-|-|-|
| lifecycle action | `inflexa:action-{mintActionId()}` | start = end = the model clock at append time |
| run | `inflexa:run-{runId}` | start from `startedAtMs`, end from `completedAtMs` |
| step | `inflexa:step-{runId}-{stepId}` | end from `completedAtMs` |
| command | `inflexa:cmd-{runId}-{stepId}-{groupDigest}` | none |

`mintActionId` mints one fresh id per genuine user action. The default minter
is a random UUID. The model clock (`now`) defaults to the wall clock. Both are
injectable, and a lifecycle action (`inflexa:CreateAnalysis`,
`inflexa:AddInput`, `inflexa:RemoveInput`, or a host-defined type through the
generic lifecycle-action builder) is deliberately not deterministic by
default.

The command group digest is:

```
groupDigest = digest( sort(map(outputs, fileDigest)).join("|") )
```

Sort the per-output `fileDigest` strings lexicographically, join them with
`|`, then digest the joined string. The command activity carries `prov:type`
`inflexa:Command` with `inflexa:command`, optional `inflexa:args`,
`inflexa:exitCode`, optional `inflexa:durationMs`, and optional
`inflexa:unresolvedScript`. `inflexa:args` is the argument vector joined with
one space, and it is present **only when the vector has at least one
element** — an empty vector emits no attribute. A file-tool write carries
`prov:type` `inflexa:FileToolWrite` and `inflexa:tool`. A command activity
carries **no formal time**: its observation timestamp is replay-unstable, and
a replay-unstable value must not enter an identifier or a formal PROV
position.

Run and step activities carry terminal attributes on completion:
`inflexa:status` and optional `inflexa:durationMs`. A run also carries
`inflexa:runId` and optional `inflexa:planSummary`. A step also carries
`prov:type` `inflexa:Step`, `inflexa:runId`, and `inflexa:stepId`.

### Script resolution

A command ref can name a `scriptPath` with no hash. The builder resolves the
path against `(path, hash)` pairs that it already holds: first the group's
**outputs**, then its **inputs**, first match wins. A resolved script adds a
`used` edge from the command activity to the script's file entity, under the
same `inflexa:used-cmd-…-{fileDigest}` id scheme as every other command read.
Thus a script that is also a listed input gets **one** merged `used` edge, not
two. A path that matches neither list has no `(path, hash)` key, so it seeds
no entity and no edge — the path instead rides the command activity as the
`inflexa:unresolvedScript` attribute.

## Time serialization

Each formal time (`prov:startTime`, `prov:endTime`, and the `prov:time` of a
timed relation) serializes in the Python `datetime.isoformat()` shape:

```
YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00
```

The rules are:

- The offset is always written as `+00:00` for UTC, never `Z`. The kernel
  supplies every instant in UTC, thus the offset is always `+00:00`.
- When the instant has zero milliseconds, there is **no** fractional part.
- When the instant has non-zero milliseconds, the fractional part is exactly
  **6 digits**: the millisecond value times 1000, left-padded with zeros.

Examples: epoch-ms `1700000000000` serializes as `2023-11-14T22:13:20+00:00`;
epoch-ms `1700000100123` serializes as `2023-11-14T22:15:00.123000+00:00`.

## Attribute encodings

PROV-JSON attribute values encode per JSON type of the supplied value:

| Value type | Encoding | Dialect attributes |
|-|-|-|
| string | plain JSON string | `inflexa:path`, `inflexa:hash`, `inflexa:name`, `inflexa:slug`, `inflexa:command`, `inflexa:args`, `inflexa:tool`, `inflexa:source`, `inflexa:fileId`, `inflexa:status`, `inflexa:runId`, `inflexa:stepId`, `inflexa:planSummary`, `inflexa:unresolvedScript`, `inflexa:email`, `inflexa:version`, `inflexa:commit`, `inflexa:model`, `prov:label`, `prov:type` (the type name is a plain string) |
| boolean | plain JSON boolean | `inflexa:isDir` |
| integral number | `{"$": n, "type": "xsd:int"}` | `inflexa:size`, `inflexa:exitCode`, `inflexa:durationMs` |
| non-integral number | `{"$": n, "type": "xsd:double"}` | none in the dialect |
| multiple values | JSON array of the encoded values | the model agent's `prov:type` |

Every numeric dialect attribute is integral, thus each one serializes as an
`xsd:int` typed literal. The integral test is on the value, not on a declared
type.

## Relation identifiers

`unified()` merges records by identifier only. An anonymous relation never
merges. Thus each execution relation carries a deterministic id, and it omits
the formal time argument. `aDigest = digest(agentQName)`.

| Relation | Identifier |
|-|-|
| run associated with agent | `inflexa:assoc-run-{runId}-{aDigest}` |
| run used analysis | `inflexa:used-run-{runId}` |
| step informed by run | `inflexa:informed-{runId}-{stepId}` |
| step associated with agent | `inflexa:assoc-step-{runId}-{stepId}-{aDigest}` |
| command informed by step | `inflexa:informed-cmd-{runId}-{stepId}-{groupDigest}` |
| command associated with agent | `inflexa:assoc-cmd-{runId}-{stepId}-{groupDigest}-{aDigest}` |
| model delegation | `inflexa:delegation-{digest(modelQn)}-{digest(responsibleQn)}` |
| model association | `{assocIdBase}-{digest(modelQn)}` |
| file generation | `inflexa:gen-{fileDigest}` |
| file attribution | `inflexa:attr-{fileDigest}-{aDigest}` |
| file derived from analysis | `inflexa:deriv-{fileDigest}` |
| command used input | `inflexa:used-cmd-{runId}-{stepId}-{groupDigest}-{fileDigest}` |
| step used input | `inflexa:used-input-{runId}-{stepId}-{fileDigest}` |

`assocIdBase` is the agent-association id of the same activity without its
`-{aDigest}` suffix. Thus the actor association and the model association of
one activity share one base and differ in the agent digest.

Exactly **one generation edge exists per file entity**. A file that a command
produced gets its `inflexa:gen-{fileDigest}` edge from the command activity. A
leaf file with no producing command gets the same id from its step activity.
The two authorities write the same identifier, thus re-emission merges.

A lifecycle relation (creation, input add, input remove) carries no explicit
identifier. Only the execution relations obey the deterministic-id rule. On
serialization each identifier-less record receives a blank-node id `_:idN`:
one document-wide counter that starts at 1 and increments per distinct
anonymous record, in record insertion order. Value-equal anonymous records
share one id.

Only the **timed** lifecycle relations stamp the model clock time: the
creation `wasGeneratedBy(analysis, action, time)`, the input-add
`used(action, input, time)`, and the input-remove
`wasInvalidatedBy(input, action, time)`. The lifecycle `wasAttributedTo` and
`wasDerivedFrom` relations carry **no** time.

## The chain rule

A persisted document snapshot participates in a hash chain:

```
seed = SHA-256( empty byte string )
H_1  = SHA-256( seed || bytes(json_1) )
H_n  = SHA-256( bytes(H_{n-1}) || bytes(json_n) )
```

`bytes(H)` decodes the lowercase hex chain hash into its 32 raw bytes.
`bytes(json)` is the UTF-8 encoding of the exact serialized PROV-JSON — no
canonicalization. When there is no previous chain hash, the seed takes its
place. Each chain hash is the lowercase hex encoding of the 32-byte digest.

## Signatures

| Item | Value |
|-|-|
| Algorithm | Ed25519 (WebCrypto) |
| Signed message | the 32 raw bytes that the hex digest decodes to |
| Signature encoding | lowercase hex, 128 characters (64 bytes) |
| Public key | JWK (`kty` `OKP`, `crv` `Ed25519`; key material base64url per JWK) |

The chained path signs the chain hash. The sidecar path signs the payload
digest `SHA-256(bytes(json))`, hex-encoded. In both paths the signature covers
the hex-decoded digest bytes, not the hex string.

## The sidecar

The export sidecar is one JSON object. A recipient verifies with the payload
and the sidecar alone.

```json
{
    "payloadType": "application/json; profile=prov-json",
    "payloadDigestAlgorithm": "SHA-256",
    "payloadDigest": "<lowercase hex SHA-256 of the exact payload bytes>",
    "payloadDigestMethod": "verbatim",
    "signatureAlgorithm": "Ed25519",
    "signature": "<lowercase hex Ed25519 signature over the digest bytes>",
    "publicKey": { "kty": "OKP", "crv": "Ed25519", "...": "signer public JWK" },
    "kid": "<optional signer id>"
}
```

`payloadType`, `payloadDigestAlgorithm`, `payloadDigestMethod`, and
`signatureAlgorithm` are literals. `payloadDigestMethod` `verbatim` means the
digest input is the exact payload bytes. `kid` is optional: when several
writers sign exports of one document, `kid` says which key signed this one.
Verification ignores it. The public key travels in the sidecar, thus the
sidecar proves integrity, not origin. For origin trust a host pins the
signer's public key and compares before verification.

## Unify semantics

Serialization collapses duplicate records with `unified()` under these
options:

```
formalAttributeConflict: "last"
singleValued: ["inflexa:status", "inflexa:durationMs"]
```

The merge is **last-write-wins**. A durable replay re-emits byte-identical
records, thus last equals first and the merge is a dedupe. A run or step that
resumes after a pause re-declares its activity with a newer terminal outcome,
and that outcome supersedes the earlier one. The `singleValued` list keeps the
custom terminal attributes single-valued under the same rule; without it they
would union into a contradictory multi-value.

One first-wins guard exists: a run start time is stamped only when the
`prov:startTime` slot under that QName is still empty. Run and step end times,
status, and duration are written directly and resolve last-wins at unify.
