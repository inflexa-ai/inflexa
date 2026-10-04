/**
 * `inflexa sbom` — the CycloneDX SBOM of this installation.
 *
 * Each delivered artifact carries its own SBOM, which its build writes and its publish attests:
 *
 * - the release binary embeds its document at compile time (`scripts/build.ts`, `__INFLEXA_SBOM__`)
 * - each image holds its document at {@link IMAGE_SBOM_PATH} (`images/sbom/image-sbom.py`)
 * - the package store carries its document at the store root (`images/sbom/store-sbom.py`)
 *
 * The images and the store update apart from the CLI, thus no release can name the set that one host
 * runs. This command reads the four documents that THIS host holds, and it merges them into one
 * hierarchical document: one top-level component for each part, with the components of that part
 * nested below it. The output goes to stdout, and each part that the host does not hold goes to stderr.
 *
 * The command reads only. It runs `cat` in each image that the container engine already holds, with
 * no network and no pull, and it reads one file of the store.
 */
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import pkg from "../../../package.json";
import { selectedRuntime } from "../../lib/config.ts";
import { capture, firstReadyRuntime, runtimeIds, runtimes, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { provisionerImageFor } from "../libs/images.ts";
import { configuredSandboxImage } from "../libs/pull.ts";
import { STORE_SBOM_FILE } from "../libs/store_download.ts";

// Baked by scripts/build.ts as the SBOM of the binary. A from-source run has no define, thus the
// `typeof` guard sees it undeclared.
declare const __INFLEXA_SBOM__: string | undefined;

/** Where each image holds its SBOM. The image build writes it (`images/sbom/image-sbom.py`). */
const IMAGE_SBOM_PATH = "/opt/inflexa/sbom.cdx.json";

/** The supplier of the merged document and of its subject. */
const SUPPLIER = { name: "Inflexa", url: ["https://github.com/inflexa-ai/inflexa"] };

/** The minimal shape of a CycloneDX document that the merge reads. Every other field passes through. */
const sbomSchema = z
    .object({
        bomFormat: z.literal("CycloneDX"),
        specVersion: z.string(),
        serialNumber: z.string().optional(),
        version: z.number().optional(),
        metadata: z.object({ component: z.object({ name: z.string() }).passthrough() }).passthrough(),
        components: z.array(z.object({}).passthrough()).optional(),
        dependencies: z.array(z.object({ ref: z.string(), dependsOn: z.array(z.string()).optional() }).passthrough()).optional(),
    })
    .passthrough();

type SbomDocument = z.infer<typeof sbomSchema>;

/** One part of the installation: its key (the prefix of its references), what it is, and its document. */
type SbomPart = { readonly key: string; readonly label: string; readonly source: string; readonly document: SbomDocument };

/** A part that this host does not hold, and why. */
type MissingPart = { readonly key: string; readonly label: string; readonly reason: string };

type PartResult = Result<SbomPart, MissingPart>;

/** The SBOM that the binary embeds. A from-source run embeds none. */
function readCliSbom(): PartResult {
    const label = `inflexa ${pkg.version}`;
    if (typeof __INFLEXA_SBOM__ !== "string") {
        return err({ key: "cli", label, reason: "this run is from source, and only a release binary embeds its SBOM" });
    }
    const document = JSON.parseWith(__INFLEXA_SBOM__, sbomSchema);
    if (document === null) return err({ key: "cli", label, reason: "the embedded SBOM is not a CycloneDX document" });
    return ok({ key: "cli", label, source: "embedded in the binary", document });
}

/** The SBOM that one local image holds. The read runs no pull and no network. */
async function readImageSbom(rt: ContainerRuntime | null, key: string, image: string): Promise<PartResult> {
    if (rt === null) return err({ key, label: image, reason: "no container runtime is available (start Docker or Podman)" });
    const id = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (id.code !== 0) return err({ key, label: image, reason: "the image is not on this host — run `inflexa sandbox pull`" });
    const read = await capture(rt, ["run", "--rm", "--pull=never", "--network=none", "--entrypoint", "cat", image, IMAGE_SBOM_PATH]).catch(() => ({
        code: 1,
        stdout: "",
        stderr: "",
    }));
    if (read.code !== 0) {
        return err({ key, label: image, reason: `the image holds no ${IMAGE_SBOM_PATH} (a build before the SBOM) — run \`inflexa sandbox pull\`` });
    }
    const document = JSON.parseWith(read.stdout, sbomSchema);
    if (document === null) return err({ key, label: image, reason: `${IMAGE_SBOM_PATH} is not a CycloneDX document` });
    return ok({ key, label: image, source: `${image} (local image ${id.stdout.trim()})`, document });
}

/** The SBOM that the package store carries at its root. */
async function readStoreSbom(storeRoot: string): Promise<PartResult> {
    const label = "package store";
    const path = `${storeRoot}/${STORE_SBOM_FILE}`;
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return err({
            key: "package-store",
            label,
            reason: `${path} is absent — run \`inflexa store download\`, or \`inflexa store download --update\` for a catalog before the SBOM`,
        });
    }
    let text: string;
    try {
        text = await file.text();
    } catch {
        return err({ key: "package-store", label, reason: `${path} is not readable` });
    }
    const document = JSON.parseWith(text, sbomSchema);
    if (document === null) return err({ key: "package-store", label, reason: `${path} is not a CycloneDX document` });
    return ok({ key: "package-store", label, source: path, document });
}

/** The component tree of one part, with each reference prefixed by the key of the part. */
function prefixComponents(components: unknown[] | undefined, prefix: string): unknown[] | undefined {
    if (components === undefined) return undefined;
    return components.map((entry) => {
        const component = { ...(entry as Record<string, unknown>) };
        if (typeof component["bom-ref"] === "string") component["bom-ref"] = `${prefix}:${component["bom-ref"]}`;
        if (Array.isArray(component.components)) component.components = prefixComponents(component.components, prefix);
        return component;
    });
}

/** A BOM-Link (`urn:cdx:<serial>/<version>`) to the document of one part, when it has a serial number. */
function bomLink(document: SbomDocument): string | null {
    const serial = document.serialNumber?.replace(/^urn:uuid:/, "");
    return serial ? `urn:cdx:${serial}/${document.version ?? 1}` : null;
}

/**
 * The hierarchical merge: the subject of each part becomes one top-level component, and the components
 * of that part nest below it. Each reference of a part gets the key of the part as its prefix, thus two
 * parts that hold the same package keep two distinct references. The dependency graph of each part
 * keeps its edges, and the new subject depends on the subject of each part.
 */
function mergeSboms(parts: readonly SbomPart[], missing: readonly MissingPart[]): Record<string, unknown> {
    const rootRef = "inflexa-installation";
    const components: unknown[] = [];
    const dependencies: Array<{ ref: string; dependsOn: string[] }> = [];
    const partRefs: string[] = [];

    for (const part of parts) {
        const subject = { ...part.document.metadata.component } as Record<string, unknown>;
        const subjectRef = `${part.key}:${typeof subject["bom-ref"] === "string" ? subject["bom-ref"] : part.key}`;
        subject["bom-ref"] = subjectRef;
        const link = bomLink(part.document);
        const references = Array.isArray(subject.externalReferences) ? [...(subject.externalReferences as unknown[])] : [];
        if (link !== null) references.push({ type: "bom", url: link, comment: "the SBOM of this part" });
        if (references.length > 0) subject.externalReferences = references;
        subject.properties = [
            ...(Array.isArray(subject.properties) ? (subject.properties as unknown[]) : []),
            { name: "inflexa:sbom-source", value: part.source },
        ];
        subject.components = prefixComponents(part.document.components, part.key) ?? [];
        components.push(subject);
        partRefs.push(subjectRef);

        for (const dependency of part.document.dependencies ?? []) {
            dependencies.push({
                ref: `${part.key}:${dependency.ref}`,
                dependsOn: (dependency.dependsOn ?? []).map((target) => `${part.key}:${target}`),
            });
        }
    }
    dependencies.push({ ref: rootRef, dependsOn: partRefs });

    const document: Record<string, unknown> = {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        serialNumber: `urn:uuid:${crypto.randomUUID()}`,
        version: 1,
        metadata: {
            timestamp: new Date().toISOString(),
            component: {
                "bom-ref": rootRef,
                type: "application",
                name: "inflexa installation",
                version: pkg.version,
                description: "The Inflexa CLI, the two sandbox images, and the package store that this host holds",
                supplier: SUPPLIER,
            },
            supplier: SUPPLIER,
            tools: { components: [{ type: "application", name: "inflexa", version: pkg.version, supplier: SUPPLIER }] },
            properties: missing.map((part) => ({ name: "inflexa:missing-part", value: `${part.label}: ${part.reason}` })),
        },
        components,
        dependencies,
    };
    // A part that the host does not hold leaves the installation incomplete, and the document says so.
    if (missing.length > 0) document.compositions = [{ aggregate: "incomplete", assemblies: [rootRef] }];
    return document;
}

/**
 * `inflexa sbom` — print the merged SBOM of this installation to stdout. Each missing part goes to stderr,
 * and a missing part makes the exit code 1, thus a script sees an incomplete document.
 */
export async function sbomAction(): Promise<void> {
    const sandboxImage = configuredSandboxImage();
    const provisionerImage = provisionerImageFor(sandboxImage);
    // A read-only command: use the selected runtime, or detect a ready one WITHOUT pinning it, as
    // `inflexa sandbox status` does.
    const rt =
        selectedRuntime() ??
        (await firstReadyRuntime(runtimeIds.map((id) => runtimes[id]))).match(
            (detected) => detected,
            () => null,
        );

    const parts: SbomPart[] = [];
    const missing: MissingPart[] = [];
    const hold = (part: SbomPart): void => void parts.push(part);
    const lack = (part: MissingPart): void => void missing.push(part);
    readCliSbom().match(hold, lack);
    (await readImageSbom(rt, "sandbox-base", sandboxImage)).match(hold, lack);
    (await readImageSbom(rt, "sandbox-provisioner", provisionerImage)).match(hold, lack);
    (await readStoreSbom(env.packageStoreDir)).match(hold, lack);

    console.log(JSON.stringify(mergeSboms(parts, missing), null, 2));
    for (const part of missing) console.error(`inflexa sbom: no SBOM for ${part.label}: ${part.reason}`);
    if (missing.length > 0) process.exitCode = 1;
}
