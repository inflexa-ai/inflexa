import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { z } from "zod";

import { parseJsonAs } from "../../../lib/parse-json.js";

import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import { createDownloadRefTool, dispositionName, type DownloadRefOpts, type DownloadRefOutput, type ResolvedAddress } from "../download-ref.js";

type Route = (req: IncomingMessage, res: ServerResponse) => void;

const routes = new Map<string, Route>();
const hits = new Map<string, number>();
const ranges: string[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
    server = createServer((req, res) => {
        const key = `${String(req.headers["x-host"])}${req.url ?? ""}`;
        hits.set(key, (hits.get(key) ?? 0) + 1);
        if (typeof req.headers.range === "string") ranges.push(req.headers.range);
        const route = routes.get(key);
        if (typeof route !== "function") {
            res.writeHead(404).end();
            return;
        }
        route(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the server listens on no port");
    port = address.port;
});

afterAll(() => {
    server.close();
});

const PUBLIC: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

/** The network of a test: each host resolves to a public address unless the map names it, and each hop reaches the local server. */
function optsWith(addresses: Record<string, ResolvedAddress[]> = {}): DownloadRefOpts {
    return {
        resolveHost: (hostname) => Promise.resolve(addresses[hostname] ?? PUBLIC),
        request: (url, options) =>
            new Promise((resolve, reject) => {
                const local = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
                const req = httpRequest(local, { headers: { ...options.headers, "x-host": url.hostname }, signal: options.signal });
                req.on("response", (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }));
                req.on("error", reject);
                req.end();
            }),
    };
}

function serve(key: string, body: Buffer | string, headers: Record<string, string> = {}): void {
    routes.set(key, (_req, res) => {
        res.writeHead(200, { "content-length": String(Buffer.byteLength(body)), ...headers }).end(body);
    });
}

function redirect(key: string, location: string): void {
    routes.set(key, (_req, res) => {
        res.writeHead(302, { location }).end();
    });
}

let store = "";
beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), "download-ref-"));
    routes.clear();
    hits.clear();
    ranges.length = 0;
});
afterEach(async () => {
    await rm(store, { recursive: true, force: true });
});

async function download(urls: string[], extract?: boolean, opts = optsWith()): Promise<DownloadRefOutput> {
    const tool = createDownloadRefTool({ storePath: store }, opts);
    return (await tool.execute({ urls, extract }, makeToolContext().ctx))._unsafeUnwrap();
}

function tarOf(files: Record<string, string>): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, text] of Object.entries(files)) {
        const header = Buffer.alloc(512);
        header.write(name, 0, "utf8");
        header.write(Buffer.byteLength(text).toString(8).padStart(11, "0"), 124, "ascii");
        header.write("0", 156, "ascii");
        const data = Buffer.from(text);
        blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

describe("the store path", () => {
    test("a plain file URL gives /mnt/refs/<host>/<path>, and the source record names it", async () => {
        serve("ftp.ensembl.org/pub/release-116/fasta/x.fa.gz", "ACGT");
        const out = await download(["https://ftp.ensembl.org/pub/release-116/fasta/x.fa.gz"]);
        expect(out.files).toEqual([
            {
                url: "https://ftp.ensembl.org/pub/release-116/fasta/x.fa.gz",
                status: "downloaded",
                path: "/mnt/refs/ftp.ensembl.org/pub/release-116/fasta/x.fa.gz",
            },
        ]);
        expect(await readFile(join(store, "ftp.ensembl.org/pub/release-116/fasta/x.fa.gz"), "utf8")).toBe("ACGT");
        expect(await readdir(join(store, "ftp.ensembl.org/pub/release-116/fasta"))).toEqual(["x.fa.gz"]);
        const record = parseJsonAs((await readFile(join(store, ".inflexa/sources.jsonl"), "utf8")).trim(), z.object({ path: z.string(), url: z.string() }));
        expect(record).toEqual({ path: "ftp.ensembl.org/pub/release-116/fasta/x.fa.gz", url: "https://ftp.ensembl.org/pub/release-116/fasta/x.fa.gz" });
    });

    test("the query string is dropped, and a Content-Disposition name replaces the last segment", async () => {
        serve("zenodo.org/records/1/files/ref.tar?download=1", "tar bytes", { "content-disposition": 'attachment; filename="ref.tar"' });
        const out = await download(["https://zenodo.org/records/1/files/ref.tar?download=1"]);
        expect(out.files[0]?.path).toBe("/mnt/refs/zenodo.org/records/1/files/ref.tar");
    });

    test("a header name that is not one segment is ignored", () => {
        expect(dispositionName('attachment; filename="../../x"')).toBeUndefined();
        expect(dispositionName("attachment; filename*=UTF-8''gene%20sets.gmt")).toBe("gene sets.gmt");
        expect(dispositionName("attachment; filename=plain.tsv")).toBe("plain.tsv");
    });

    test("an empty segment, or a segment that decodes to a separator, refuses the call", async () => {
        const tool = createDownloadRefTool({ storePath: store }, optsWith());
        for (const url of ["https://a.org/x//y.txt", "https://a.org/x/a%2Fb.txt", "https://a.org/dir/"]) {
            const refusal = (await tool.execute({ urls: [url] }, makeToolContext().ctx))._unsafeUnwrapErr();
            expect(refusal.error).toContain(url);
        }
    });
});

describe("the host check", () => {
    test("two hosts in one call fail before any download, and the error names the hosts", async () => {
        serve("ftp.ebi.ac.uk/a.txt", "a");
        const tool = createDownloadRefTool({ storePath: store }, optsWith());
        const refusal = (
            await tool.execute({ urls: ["https://ftp.ebi.ac.uk/a.txt", "https://ftp.ensembl.org/b.txt"] }, makeToolContext().ctx)
        )._unsafeUnwrapErr();
        expect(refusal.error).toContain("ftp.ebi.ac.uk and ftp.ensembl.org");
        expect(hits.size).toBe(0);
        expect(await readdir(store)).toEqual([]);
    });

    test("a URL that is not HTTPS refuses the call", async () => {
        const tool = createDownloadRefTool({ storePath: store }, optsWith());
        const refusal = (await tool.execute({ urls: ["http://ftp.ebi.ac.uk/a.txt"] }, makeToolContext().ctx))._unsafeUnwrapErr();
        expect(refusal.error).toContain("does not use HTTPS");
    });

    test("a host with a private address fails, and no file is written", async () => {
        serve("intranet.example/a.txt", "secret");
        const out = await download(["https://intranet.example/a.txt"], false, optsWith({ "intranet.example": [{ address: "10.0.0.5", family: 4 }] }));
        expect(out.files[0]?.status).toBe("failed");
        expect(out.files[0]?.error).toContain("internal address");
        expect(hits.size).toBe(0);
    });

    test("an address with no route fails over to the next address of the host", async () => {
        serve("raw.githubusercontent.com/a.bed", "chr1\t1\t2\n");
        const unreachable = "2606:50c0:8003::154";
        const reachable = optsWith({ "raw.githubusercontent.com": [{ address: unreachable, family: 6 }, ...PUBLIC] });
        const tried: string[] = [];
        const opts: DownloadRefOpts = {
            resolveHost: reachable.resolveHost,
            request: (url, options) => {
                tried.push(options.address.address);
                if (options.address.address === unreachable) return Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
                return reachable.request(url, options);
            },
        };
        const out = await download(["https://raw.githubusercontent.com/a.bed"], false, opts);
        expect(out.files[0]).toMatchObject({ status: "downloaded", path: "/mnt/refs/raw.githubusercontent.com/a.bed" });
        expect(tried).toEqual([unreachable, "93.184.216.34"]);
    });
});

describe("a URL that the server does not have", () => {
    test("gives the files of its folder, thus the next call can name the right file", async () => {
        routes.set("ftp.ensembl.org/pub/release-116/fasta/homo_sapiens/dna/", (_req, res) => {
            res.writeHead(200, { "content-type": "text/html" }).end(
                '<a href="?C=N;O=D">Name</a> <a href="/pub/release-116/fasta/">Parent Directory</a> <a href="Homo_sapiens.GRCh38.dna.primary_assembly.fa.gz">x</a> <a href="CHECKSUMS">y</a> <a href="https://elsewhere.org/a">z</a>',
            );
        });
        const out = await download(["https://ftp.ensembl.org/pub/release-116/fasta/homo_sapiens/dna/Homo_sapiens.GRCh38.dna.toplevel.fa.gz"]);
        expect(out.files[0]?.status).toBe("failed");
        expect(out.files[0]?.error).toBe(
            "the server answered HTTP 404. The folder https://ftp.ensembl.org/pub/release-116/fasta/homo_sapiens/dna/ holds: Homo_sapiens.GRCh38.dna.primary_assembly.fa.gz, CHECKSUMS",
        );
    });

    test("keeps the plain reason when the folder does not answer", async () => {
        const out = await download(["https://ftp.ebi.ac.uk/gone/a.txt"]);
        expect(out.files[0]?.error).toBe("the server answered HTTP 404");
    });
});

describe("the redirects", () => {
    test("a redirect to a private address fails that file, and no file is written for it", async () => {
        redirect("mirror.org/a.txt", "https://intranet.example/a.txt");
        serve("intranet.example/a.txt", "secret");
        const out = await download(["https://mirror.org/a.txt"], false, optsWith({ "intranet.example": [{ address: "192.168.1.4", family: 4 }] }));
        expect(out.files[0]).toMatchObject({ url: "https://mirror.org/a.txt", status: "failed" });
        expect(hits.get("intranet.example/a.txt")).toBeUndefined();
        expect(await readdir(join(store, "mirror.org"))).toEqual([]);
    });

    test("a redirect that is not HTTPS fails", async () => {
        redirect("mirror.org/a.txt", "http://cdn.mirror.org/a.txt");
        const out = await download(["https://mirror.org/a.txt"]);
        expect(out.files[0]?.error).toContain("does not use HTTPS");
    });

    test("the tool follows a redirect to a CDN and stores the file at the path of the asked URL", async () => {
        redirect("mirror.org/a.txt", "https://cdn.example/blob/123");
        serve("cdn.example/blob/123", "data");
        const out = await download(["https://mirror.org/a.txt"]);
        expect(out.files[0]?.path).toBe("/mnt/refs/mirror.org/a.txt");
    });

    test("5 redirects pass, and a sixth fails", async () => {
        for (let hop = 0; hop < 6; hop++) redirect(`mirror.org/${hop}`, `https://mirror.org/${hop + 1}`);
        serve("mirror.org/6", "data");
        expect((await download(["https://mirror.org/0"])).files[0]?.error).toContain("more than 5 times");
        expect((await download(["https://mirror.org/1"])).files[0]?.status).toBe("downloaded");
    });
});

describe("the resume", () => {
    test("a .part file continues with a range request", async () => {
        const body = "0123456789abcdef";
        routes.set("ftp.ebi.ac.uk/big.txt", (req, res) => {
            const start = Number((req.headers.range ?? "bytes=0-").slice("bytes=".length, -1));
            const rest = body.slice(start);
            const headers: Record<string, string> = { "content-length": String(rest.length) };
            if (start > 0) headers["content-range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
            res.writeHead(start > 0 ? 206 : 200, headers).end(rest);
        });
        await mkdir(join(store, "ftp.ebi.ac.uk"), { recursive: true });
        await writeFile(join(store, "ftp.ebi.ac.uk/big.txt.part"), body.slice(0, 6));
        const out = await download(["https://ftp.ebi.ac.uk/big.txt"]);
        expect(out.files[0]?.status).toBe("downloaded");
        expect(ranges).toEqual(["bytes=6-"]);
        expect(await readFile(join(store, "ftp.ebi.ac.uk/big.txt"), "utf8")).toBe(body);
        expect(await readdir(join(store, "ftp.ebi.ac.uk"))).toEqual(["big.txt"]);
    });

    test("a server that ignores the range sends the whole file again", async () => {
        serve("ftp.ebi.ac.uk/big.txt", "whole");
        await mkdir(join(store, "ftp.ebi.ac.uk"), { recursive: true });
        await writeFile(join(store, "ftp.ebi.ac.uk/big.txt.part"), "stale");
        await download(["https://ftp.ebi.ac.uk/big.txt"]);
        expect(await readFile(join(store, "ftp.ebi.ac.uk/big.txt"), "utf8")).toBe("whole");
    });

    test("a transfer that breaks leaves no file at the target, and the result names the URL", async () => {
        routes.set("ftp.ebi.ac.uk/big.txt", (_req, res) => {
            res.writeHead(200, { "content-length": "1000" });
            res.write("partial");
            setImmediate(() => res.socket?.destroy());
        });
        const out = await download(["https://ftp.ebi.ac.uk/big.txt"]);
        expect(out.files[0]).toMatchObject({ url: "https://ftp.ebi.ac.uk/big.txt", status: "failed" });
        expect(await readdir(join(store, "ftp.ebi.ac.uk"))).toEqual(["big.txt.part"]);
    });
});

describe("the extraction", () => {
    test("a tarball becomes a directory beside it, and the archive is gone", async () => {
        serve("unite.ut.ee/sh/unite.tgz", gzipSync(tarOf({ "unite/its.fasta": ">a\nACGT\n", README: "unite" })));
        const out = await download(["https://unite.ut.ee/sh/unite.tgz"], true);
        expect(out.files[0]).toMatchObject({ status: "downloaded", path: "/mnt/refs/unite.ut.ee/sh/unite", extracted: true });
        expect((await readdir(join(store, "unite.ut.ee/sh"))).sort()).toEqual(["unite"]);
        expect(await readFile(join(store, "unite.ut.ee/sh/unite/unite/its.fasta"), "utf8")).toBe(">a\nACGT\n");
        expect(await readFile(join(store, ".inflexa/sources.jsonl"), "utf8")).toContain('"path":"unite.ut.ee/sh/unite"');
    });

    test("an entry that escapes fails the extraction, and nothing is written outside the directory of the archive", async () => {
        serve("evil.org/x/bad.tar", tarOf({ "../../etc/x": "owned" }));
        const out = await download(["https://evil.org/x/bad.tar"], true);
        expect(out.files[0]?.status).toBe("failed");
        expect(out.files[0]?.error).toContain("../../etc/x");
        expect(await readdir(store)).toEqual(["evil.org"]);
        expect(await readdir(join(store, "evil.org/x"))).toEqual([]);
    });

    test("an extraction asked for after a kept download extracts the archive on disk, with no transfer", async () => {
        serve("unite.ut.ee/sh/unite.tgz", gzipSync(tarOf({ "unite/its.fasta": ">a\nACGT\n" })));
        await download(["https://unite.ut.ee/sh/unite.tgz"]);
        const out = await download(["https://unite.ut.ee/sh/unite.tgz"], true);
        expect(out.files[0]).toMatchObject({ status: "reused", path: "/mnt/refs/unite.ut.ee/sh/unite", extracted: true });
        expect(hits.get("unite.ut.ee/sh/unite.tgz")).toBe(1);
        expect(await readdir(join(store, "unite.ut.ee/sh"))).toEqual(["unite"]);
        const again = await download(["https://unite.ut.ee/sh/unite.tgz"], true);
        expect(again.files[0]).toMatchObject({ status: "reused", path: "/mnt/refs/unite.ut.ee/sh/unite" });
    });

    test("a gzip file of one file stays compressed", async () => {
        serve("ftp.ebi.ac.uk/t.tsv.gz", gzipSync("a\tb\n"));
        const out = await download(["https://ftp.ebi.ac.uk/t.tsv.gz"], true);
        expect(out.files[0]).toMatchObject({ status: "downloaded", path: "/mnt/refs/ftp.ebi.ac.uk/t.tsv.gz", extracted: false });
    });
});

describe("the source record", () => {
    test("a second call for the same URL gives the existing path with no transfer", async () => {
        serve("ftp.ebi.ac.uk/a.txt", "a");
        await download(["https://ftp.ebi.ac.uk/a.txt"]);
        const again = await download(["https://ftp.ebi.ac.uk/a.txt"]);
        expect(again.files[0]).toEqual({ url: "https://ftp.ebi.ac.uk/a.txt", status: "reused", path: "/mnt/refs/ftp.ebi.ac.uk/a.txt" });
        expect(hits.get("ftp.ebi.ac.uk/a.txt")).toBe(1);
    });

    test("a recorded file that is gone downloads again", async () => {
        serve("ftp.ebi.ac.uk/a.txt", "a");
        await download(["https://ftp.ebi.ac.uk/a.txt"]);
        await rm(join(store, "ftp.ebi.ac.uk/a.txt"));
        expect((await download(["https://ftp.ebi.ac.uk/a.txt"])).files[0]?.status).toBe("downloaded");
        expect(hits.get("ftp.ebi.ac.uk/a.txt")).toBe(2);
    });
});

describe("the approval hook", () => {
    const approvalCtx = { invocationId: "call", session: makeSession() };

    test("a host on the list, or a subdomain of one, asks nothing", async () => {
        const tool = createDownloadRefTool({ storePath: store });
        expect(await tool.approval?.({ urls: ["https://ftp.ncbi.nlm.nih.gov/a.txt"] }, approvalCtx)).toBeUndefined();
        expect(await tool.approval?.({ urls: ["https://ncbi.nlm.nih.gov/a.txt"] }, approvalCtx)).toBeUndefined();
        expect(await tool.approval?.({ urls: ["https://notncbi.nlm.nih.gov.evil.org/a.txt"] }, approvalCtx)).toBeDefined();
    });

    test("another host asks with a user-scoped grant for the host, and the ask names each URL", async () => {
        const tool = createDownloadRefTool({ storePath: store });
        const ask = await tool.approval?.({ urls: ["https://zenodo.org/records/1/a.txt", "https://zenodo.org/records/1/b.txt"] }, approvalCtx);
        expect(ask).toMatchObject({ grantKey: "download-ref:zenodo.org", grantScope: "user" });
        expect(ask?.title).toContain("zenodo.org");
        expect(ask?.command).toBe("https://zenodo.org/records/1/a.txt\nhttps://zenodo.org/records/1/b.txt");
    });

    test("an added host of the embedder asks nothing", async () => {
        const tool = createDownloadRefTool({ storePath: store, autoApproveHosts: ["zenodo.org"] });
        expect(await tool.approval?.({ urls: ["https://zenodo.org/records/1/a.txt"] }, approvalCtx)).toBeUndefined();
    });

    test("a call that the check refuses asks nothing", async () => {
        const tool = createDownloadRefTool({ storePath: store });
        expect(await tool.approval?.({ urls: ["https://zenodo.org/a.txt", "https://figshare.com/b.txt"] }, approvalCtx)).toBeUndefined();
    });
});
