/**
 * Per-shape header readout — the one part of the scan that needs the sandbox.
 *
 * A bounded prefix read compared against a magic table runs on the host; a DECODER
 * over user-supplied bytes does not. zlib, HDF5, and PDF parsers in the long-lived
 * multi-tenant harness process are exactly the exposure the ephemeral sandbox exists
 * to contain, so every decode below runs there.
 *
 * Cost is O(shapes), not O(files): shapes are observed from names and sizes alone, so
 * enrichment decodes a bounded number of members per shape — roughly four files for
 * the 3513-file tree that motivated this capability. One exec covers every shape, so
 * even the round trip does not scale with the tree.
 *
 * Nothing ships in `sandbox-base` for this: the decoder is a Python program passed on
 * the command line through the existing `runSandboxExec` path, so the capability
 * releases on the harness's own path rather than on the image's manual one.
 */

import type { EmitFn } from "../tools/define-tool.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { SandboxRef } from "../sandbox/types.js";
import { runSandboxExec } from "../tools/workspace/run-exec.js";

import type { FileShape, HeaderReadout } from "./types.js";

/** Members decoded per shape. One is enough to characterise a set whose names already match. */
export const MEMBERS_DECODED_PER_SHAPE = 1;

/** Wall-clock bound on the whole readout exec — it reads prefixes, nothing more. */
const ENRICH_TIMEOUT_SECONDS = 120;

/**
 * The decoder, as a self-contained program. Reads a bounded prefix of each path and
 * prints one JSON object per line: `{"path": …, "fields": {…}}` or `{"path": …,
 * "unavailable": …}`. It never reads a file in full except a size-capped document,
 * whose page count lives in a trailer no prefix can reach.
 */
const DECODER = String.raw`
import sys, json, zlib, io, os, csv

PREFIX = 262144
MEMBER = 1048576
DOC_MAX = 33554432

def prefix_bytes(path, n=PREFIX):
    with open(path, "rb") as fh:
        return fh.read(n)

def gunzip_prefix(raw):
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        return d.decompress(raw, MEMBER)
    except zlib.error:
        return b""

def sniff_delimiter(line):
    counts = {d: line.count(d) for d in [",", "\t", ";", "|"]}
    best = max(counts, key=lambda d: counts[d])
    return best if counts[best] > 0 else None

def text_fields(text):
    lines = [l for l in text.splitlines() if l.strip() != ""]
    if not lines:
        return {}
    head = lines[0]
    if head.startswith("##fileformat=VCF") or head.startswith("##"):
        fields = {}
        for line in lines[:200]:
            if line.startswith("##fileformat="):
                fields["fileformat"] = line.split("=", 1)[1][:40]
            elif line.startswith("##reference="):
                fields["reference"] = line.split("=", 1)[1][:80]
            elif line.startswith("#CHROM"):
                cols = line.split("\t")
                samples = cols[9:]
                fields["sampleCount"] = len(samples)
                fields["samples"] = ", ".join(samples[:5])[:120]
                break
        fields["metaLines"] = sum(1 for l in lines if l.startswith("##"))
        return fields
    if head.startswith(">"):
        return {"firstRecord": head[1:80], "recordsInPrefix": sum(1 for l in lines if l.startswith(">"))}
    if head.startswith("@") and len(lines) > 1 and not head.startswith("@HD"):
        return {"firstRecord": head[1:80], "readLength": len(lines[1])}
    if head.startswith("@HD") or head.startswith("@SQ"):
        return {"referenceSequences": sum(1 for l in lines if l.startswith("@SQ")), "readGroups": sum(1 for l in lines if l.startswith("@RG"))}
    delim = sniff_delimiter(head)
    if delim:
        columns = next(csv.reader([head], delimiter=delim))
        return {
            "delimiter": {",": "comma", "\t": "tab", ";": "semicolon", "|": "pipe"}[delim],
            "columnCount": len(columns),
            "columns": ", ".join(c.strip()[:24] for c in columns[:12])[:200],
            "linesInPrefix": len(lines),
        }
    return {"firstLine": head[:120]}

def hdf5_fields(path):
    try:
        import h5py
    except Exception:
        return {"unavailable": "h5py not installed in this sandbox"}
    try:
        with h5py.File(path, "r") as f:
            keys = list(f.keys())[:20]
            out = {"rootKeys": ", ".join(keys)[:200], "rootKeyCount": len(f.keys())}
            for probe in ("X", "obs", "var", "matrix"):
                if probe in f:
                    node = f[probe]
                    shape = getattr(node, "shape", None)
                    if shape:
                        out[probe + "Shape"] = "x".join(str(d) for d in shape)
            return out
    except Exception as exc:
        return {"unavailable": "hdf5 open failed: " + str(exc)[:80]}

def pdf_fields(path):
    if os.path.getsize(path) > DOC_MAX:
        return {"unavailable": "document too large to page-count within the scan's bound"}
    try:
        from pypdf import PdfReader
        reader = PdfReader(path)
        text = (reader.pages[0].extract_text() or "")[:200] if reader.pages else ""
        return {"pageCount": len(reader.pages), "firstPageText": " ".join(text.split())[:200]}
    except Exception as exc:
        return {"unavailable": "pdf read failed: " + str(exc)[:80]}

def docx_fields(path):
    if os.path.getsize(path) > DOC_MAX:
        return {"unavailable": "document too large to inspect within the scan's bound"}
    try:
        import zipfile, re
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            out = {"parts": len(names)}
            if "docProps/app.xml" in names:
                app = z.read("docProps/app.xml").decode("utf8", "replace")
                for tag in ("Pages", "Words"):
                    m = re.search("<" + tag + ">(\\d+)</" + tag + ">", app)
                    if m:
                        out[tag.lower()] = int(m.group(1))
            return out
    except Exception as exc:
        return {"unavailable": "docx read failed: " + str(exc)[:80]}

def describe(path):
    ext = path.lower()
    if ext.endswith(".pdf"):
        return pdf_fields(path)
    if ext.endswith(".docx"):
        return docx_fields(path)
    if ext.endswith((".h5", ".hdf5", ".h5ad", ".loom")):
        return hdf5_fields(path)
    raw = prefix_bytes(path)
    if raw[:2] == b"\x1f\x8b":
        wrapper = "bgzip" if len(raw) > 13 and raw[3] & 4 and raw[12:14] == b"BC" else "gzip"
        inner = gunzip_prefix(raw)
        if inner[:4] == b"BAM\x01":
            l_text = int.from_bytes(inner[4:8], "little")
            header = inner[8:8 + min(l_text, 65536)].decode("utf8", "replace")
            fields = text_fields(header)
            fields["wrapper"] = wrapper
            fields["container"] = "bam"
            return fields
        if inner[:4] == b"BCF\x02" or inner[:3] == b"BCF":
            return {"wrapper": wrapper, "container": "bcf"}
        fields = text_fields(inner.decode("utf8", "replace"))
        fields["wrapper"] = wrapper
        return fields
    if raw[:8] == b"\x89HDF\r\n\x1a\n":
        return hdf5_fields(path)
    return text_fields(raw.decode("utf8", "replace"))

for path in sys.argv[1:]:
    try:
        fields = describe(path)
    except Exception as exc:
        fields = {"unavailable": type(exc).__name__ + ": " + str(exc)[:80]}
    note = fields.pop("unavailable", None)
    record = {"path": path, "fields": fields}
    if note:
        record["unavailable"] = note
    sys.stdout.write(json.dumps(record) + "\n")
`;

export interface EnrichShapesArgs {
    readonly shapes: readonly FileShape[];
    readonly sandboxClient: SandboxClient;
    readonly sandbox: SandboxRef;
    /** Absolute in-sandbox path of the analysis root (`/{analysisId}`). */
    readonly mountRoot: string;
    readonly execId: string;
    readonly deadlineMs: number;
    readonly emit: EmitFn;
}

/**
 * Decode one member per shape and attach the readout.
 *
 * A shape whose decode failed keeps its `unavailable` note rather than losing the
 * shape: the readout is enrichment, and a manifest without it still carries every
 * structural observation the agent's grouping rests on.
 */
export async function enrichShapes(args: EnrichShapesArgs): Promise<FileShape[]> {
    const { shapes, mountRoot } = args;
    const targets = shapes.map((shape) => ({ shape, paths: shape.examplePaths.slice(0, MEMBERS_DECODED_PER_SHAPE) })).filter((t) => t.paths.length > 0);
    if (targets.length === 0) return [...shapes];

    const absolute = new Map<string, string>();
    for (const { shape, paths } of targets) {
        for (const path of paths) absolute.set(`${mountRoot}/${path}`, shape.id);
    }

    const result = await runSandboxExec({
        sandboxClient: args.sandboxClient,
        sandbox: args.sandbox,
        execId: args.execId,
        command: ["python3", "-c", DECODER, ...absolute.keys()],
        timeoutSeconds: ENRICH_TIMEOUT_SECONDS,
        deadlineMs: args.deadlineMs,
        emit: args.emit,
    });

    const readouts = new Map<string, HeaderReadout>();
    for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let parsed: { path?: string; fields?: Record<string, string | number | boolean>; unavailable?: string };
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }
        const shapeId = parsed.path ? absolute.get(parsed.path) : undefined;
        if (!shapeId || !parsed.path) continue;
        readouts.set(shapeId, {
            path: parsed.path.startsWith(`${mountRoot}/`) ? parsed.path.slice(mountRoot.length + 1) : parsed.path,
            fields: parsed.fields ?? {},
            ...(parsed.unavailable ? { unavailable: parsed.unavailable } : {}),
        });
    }

    return shapes.map((shape) => {
        const header = readouts.get(shape.id);
        return header ? { ...shape, header } : shape;
    });
}
