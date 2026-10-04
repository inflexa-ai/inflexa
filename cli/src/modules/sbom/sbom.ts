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
import { capture, firstReadyRuntime, runtimeIds, runtimes, type ContainerRuntime, type ContainerRuntimeError } from "../../lib/container.ts";
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

/**
 * A CycloneDX object that the merge copies without reading most of its fields. The schema validates only the
 * fields that the merge reads, and every other field passes through as it is, thus its values stay `unknown`.
 */
type CdxObject = Record<string, unknown>;

/** The four parts of an installation. The key of a part is the prefix of each of its references. */
type PartKey = "cli" | "sandbox-base" | "sandbox-provisioner" | "package-store";

/** One part of the installation: its key, what it is, where the document came from, and the document. */
type SbomPart = { readonly key: PartKey; readonly label: string; readonly source: string; readonly document: SbomDocument };

/** A part that this host does not hold, and why. */
type MissingPart = { readonly key: PartKey; readonly label: string; readonly reason: string };

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

/** The first line of a command's error output, for one line of a reason. */
function firstLine(text: string): string {
    return text.trim().split("\n")[0] ?? "";
}

/**
 * The SBOM that one local image holds. The read runs no pull and no network.
 *
 * Each failure keeps its own reason: a runtime that is not ready, an image that is not on the host, an image
 * from a build before the SBOM, and any other error of the runtime, with its first line.
 */
async function readImageSbom(runtime: Result<ContainerRuntime, ContainerRuntimeError>, key: PartKey, image: string): Promise<PartResult> {
    if (runtime.isErr()) return err({ key, label: image, reason: runtime.error.message.replace(/\s+/g, " ").trim() });
    const rt = runtime.value;
    // `capture` rejects only when the runtime binary cannot spawn. The readiness probe above found it, thus a
    // rejection is a fault of the moment, and its text is the reason.
    const inspect = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]).catch((cause: unknown) => ({
        code: -1,
        stdout: "",
        stderr: String(cause),
    }));
    if (inspect.code !== 0) {
        // Docker says "No such image" and Podman says "image not known" for an image that the host does not hold.
        const absent = /no such image|no such object|image not known/i.test(inspect.stderr);
        const reason = absent
            ? "the image is not on this host — run `inflexa sandbox pull`"
            : `${rt.label} could not inspect the image: ${firstLine(inspect.stderr)}`;
        return err({ key, label: image, reason });
    }
    // The rejection `cause` is `unknown` for the same reason as the inspect above, and its text is the reason.
    const read = await capture(rt, ["run", "--rm", "--pull=never", "--network=none", "--entrypoint", "cat", image, IMAGE_SBOM_PATH]).catch(
        (cause: unknown) => ({
            code: -1,
            stdout: "",
            stderr: String(cause),
        }),
    );
    if (read.code !== 0) {
        // `cat` names the missing file itself, thus that text marks an image from a build before the SBOM. Any
        // other failure is an error of the runtime.
        const absent = /^cat: .*no such file/im.test(read.stderr);
        const reason = absent
            ? `the image holds no ${IMAGE_SBOM_PATH} (a build before the SBOM) — run \`inflexa sandbox pull\``
            : `${rt.label} could not read ${IMAGE_SBOM_PATH} from the image: ${firstLine(read.stderr)}`;
        return err({ key, label: image, reason });
    }
    const document = JSON.parseWith(read.stdout, sbomSchema);
    if (document === null) return err({ key, label: image, reason: `${IMAGE_SBOM_PATH} is not a CycloneDX document` });
    return ok({ key, label: image, source: `${image} (local image ${inspect.stdout.trim()})`, document });
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

/** True when a value is a JSON object. The predicate is sound: it holds after the runtime tests in its body. */
function isCdxObject(value: unknown): value is CdxObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The component tree of one part, with each reference prefixed by the key of the part. A nested `components`
 * entry that is not an object is not a component, thus the copy leaves it out.
 */
function prefixComponents(components: readonly CdxObject[], prefix: PartKey): CdxObject[] {
    return components.map((entry) => {
        const component: CdxObject = { ...entry };
        if (typeof component["bom-ref"] === "string") component["bom-ref"] = `${prefix}:${component["bom-ref"]}`;
        if (Array.isArray(component.components)) component.components = prefixComponents(component.components.filter(isCdxObject), prefix);
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
function mergeSboms(parts: readonly SbomPart[], missing: readonly MissingPart[]): CdxObject {
    const rootRef = "inflexa-installation";
    const components: CdxObject[] = [];
    const dependencies: Array<{ ref: string; dependsOn: string[] }> = [];
    const partRefs: string[] = [];

    for (const part of parts) {
        const subject: CdxObject = { ...part.document.metadata.component };
        const subjectRef = `${part.key}:${typeof subject["bom-ref"] === "string" ? subject["bom-ref"] : part.key}`;
        subject["bom-ref"] = subjectRef;
        const link = bomLink(part.document);
        const references: CdxObject[] = Array.isArray(subject.externalReferences) ? subject.externalReferences.filter(isCdxObject) : [];
        if (link !== null) references.push({ type: "bom", url: link, comment: "the SBOM of this part" });
        if (references.length > 0) subject.externalReferences = references;
        const properties: CdxObject[] = Array.isArray(subject.properties) ? subject.properties.filter(isCdxObject) : [];
        subject.properties = [...properties, { name: "inflexa:sbom-source", value: part.source }];
        subject.components = prefixComponents(part.document.components ?? [], part.key);
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

    const document: CdxObject = {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        // A v4 UUID, not the `randomUUIDv7()` of the cli identifier rule: the CycloneDX 1.6 schema accepts a
        // serial number of UUID version 1 to 5 only, thus a v7 serial fails the validation of the document.
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
    // `inflexa sandbox status` does. A selected runtime gets the same readiness probe, thus a stopped daemon reads
    // as a stopped daemon, and not as an image that the host does not hold.
    const selected = selectedRuntime();
    const runtime = await firstReadyRuntime(selected === null ? runtimeIds.map((id) => runtimes[id]) : [selected]);

    const parts: SbomPart[] = [];
    const missing: MissingPart[] = [];
    function hold(part: SbomPart): void {
        parts.push(part);
    }
    function lack(part: MissingPart): void {
        missing.push(part);
    }
    readCliSbom().match(hold, lack);
    (await readImageSbom(runtime, "sandbox-base", sandboxImage)).match(hold, lack);
    (await readImageSbom(runtime, "sandbox-provisioner", provisionerImage)).match(hold, lack);
    (await readStoreSbom(env.packageStoreDir)).match(hold, lack);

    console.log(JSON.stringify(mergeSboms(parts, missing), null, 2));
    for (const part of missing) console.error(`inflexa sbom: no SBOM for ${part.label}: ${part.reason}`);
    if (missing.length > 0) process.exitCode = 1;
}
