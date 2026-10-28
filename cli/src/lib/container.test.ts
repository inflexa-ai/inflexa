import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";

import {
    capture,
    ContainerRuntimeError,
    firstReadyRuntime,
    pullImageThroughEngine,
    resolveEngineApiSocket,
    resolveEngineSocket,
    resolveImageTotalBytes,
    runtimes,
    splitImageRef,
    type CaptureResult,
    type ContainerRuntime,
    type EnginePullProgress,
    type EngineSocketProbes,
} from "./container.ts";

describe("runtime mountArg", () => {
    test("docker uses the bare host:container form", () => {
        expect(runtimes.docker.mountArg("/host/cfg", "/ctr/cfg")).toBe("/host/cfg:/ctr/cfg");
    });

    test("podman appends :z for the shared SELinux relabel", () => {
        expect(runtimes.podman.mountArg("/host/cfg", "/ctr/cfg")).toBe("/host/cfg:/ctr/cfg:z");
    });
});

describe("firstReadyRuntime", () => {
    function readyWhen(readyIds: readonly string[], probed?: string[]) {
        return (rt: ContainerRuntime): Promise<Result<void, ContainerRuntimeError>> => {
            probed?.push(rt.id);
            return Promise.resolve(readyIds.includes(rt.id) ? ok(undefined) : err(new ContainerRuntimeError(rt.notReadyHint)));
        };
    }

    test("returns the first ready candidate without probing the rest", async () => {
        const probed: string[] = [];
        const result = await firstReadyRuntime([runtimes.docker, runtimes.podman], readyWhen(["docker", "podman"], probed));
        expect(result._unsafeUnwrap().id).toBe("docker");
        expect(probed).toEqual(["docker"]);
    });

    test("falls through to a later ready candidate when the preferred one is not", async () => {
        const result = await firstReadyRuntime([runtimes.docker, runtimes.podman], readyWhen(["podman"]));
        expect(result._unsafeUnwrap().id).toBe("podman");
    });

    test("aggregates every candidate's guidance when none is ready", async () => {
        const result = await firstReadyRuntime([runtimes.docker, runtimes.podman], readyWhen([]));
        const error = result.match(
            () => null,
            (e) => e,
        );
        expect(error?.message).toContain("one of Docker, Podman");
        expect(error?.message).toContain(runtimes.docker.notReadyHint);
        expect(error?.message).toContain(runtimes.podman.notReadyHint);
    });
});

describe("resolveEngineSocket", () => {
    // A capture stub that returns a canned result and records the args it was asked
    // to spawn — so the "never spawns a real binary" contract is checkable in-band.
    function captureReturning(result: CaptureResult, spawned?: string[][]): EngineSocketProbes["capture"] {
        return (_rt, args) => {
            spawned?.push(args);
            return Promise.resolve(result);
        };
    }

    test("docker resolves to no socket and never spawns a probe", async () => {
        const spawned: string[][] = [];
        const result = await resolveEngineSocket(runtimes.docker, {
            platform: "linux",
            capture: captureReturning({ code: 0, stdout: "irrelevant", stderr: "" }, spawned),
            exists: () => true,
        });

        expect(result._unsafeUnwrap()).toBeUndefined();
        expect(spawned).toEqual([]);
    });

    test("podman on macOS returns the running machine's compat socket path", async () => {
        const spawned: string[][] = [];
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "darwin",
            capture: captureReturning({ code: 0, stdout: "/var/folders/xy/podman-machine-default-api.sock\n", stderr: "" }, spawned),
            // A running machine's gvproxy forward is live, so the reported socket exists on disk.
            exists: () => true,
        });

        expect(result._unsafeUnwrap()).toBe("/var/folders/xy/podman-machine-default-api.sock");
        expect(spawned).toEqual([["machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"]]);
    });

    test("podman on macOS with a stopped machine fails with a `podman machine start` hint", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "darwin",
            capture: captureReturning({ code: 125, stdout: "", stderr: "VM does not exist" }),
            exists: () => true,
        });

        expect(result._unsafeUnwrapErr().message).toContain("podman machine start");
    });

    test("podman on macOS with a stopped machine still reporting its socket path fails on the on-disk gate", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "darwin",
            // `podman machine inspect` exits 0 with the persisted socket path even when the
            // machine is stopped; the gvproxy forward is torn down, so the file is absent.
            capture: captureReturning({ code: 0, stdout: "/var/folders/xy/podman-machine-default-api.sock\n", stderr: "" }),
            exists: () => false,
        });

        expect(result._unsafeUnwrapErr().message).toContain("podman machine start");
    });

    test("podman on macOS with an empty socket path fails actionably even on a zero exit", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "darwin",
            capture: captureReturning({ code: 0, stdout: "   \n", stderr: "" }),
            exists: () => true,
        });

        expect(result._unsafeUnwrapErr().message).toContain("podman machine start");
    });

    test("podman on Linux returns the REST socket path when it exists on disk", async () => {
        const spawned: string[][] = [];
        const stated: string[] = [];
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "linux",
            capture: captureReturning({ code: 0, stdout: "/run/user/1000/podman/podman.sock\n", stderr: "" }, spawned),
            exists: (p) => {
                stated.push(p);
                return true;
            },
        });

        expect(result._unsafeUnwrap()).toBe("/run/user/1000/podman/podman.sock");
        expect(spawned).toEqual([["info", "--format", "{{.Host.RemoteSocket.Path}}"]]);
        // The existence gate stats exactly the reported path.
        expect(stated).toEqual(["/run/user/1000/podman/podman.sock"]);
    });

    test("podman on Linux fails with a `podman.socket` hint when the reported socket is absent on disk", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "linux",
            capture: captureReturning({ code: 0, stdout: "/run/user/1000/podman/podman.sock\n", stderr: "" }),
            // A reachable CLI reported a path, but nothing is listening on it.
            exists: () => false,
        });

        expect(result._unsafeUnwrapErr().message).toContain("systemctl --user enable --now podman.socket");
    });

    test("podman on Linux fails when `podman info` exits non-zero", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "linux",
            capture: captureReturning({ code: 1, stdout: "", stderr: "Cannot connect to Podman" }),
            exists: () => true,
        });

        expect(result._unsafeUnwrapErr().message).toContain("systemctl --user enable --now podman.socket");
    });
});

describe("resolveEngineApiSocket", () => {
    function probes(over: {
        dockerHost?: string;
        capture?: CaptureResult;
        exists?: (path: string) => boolean;
        spawned?: string[][];
        platform?: NodeJS.Platform;
    }) {
        return {
            platform: over.platform ?? "linux",
            dockerHost: over.dockerHost,
            capture: (_rt: ContainerRuntime, args: string[]): Promise<CaptureResult> => {
                over.spawned?.push(args);
                return Promise.resolve(over.capture ?? { code: 1, stdout: "", stderr: "" });
            },
            exists: over.exists ?? (() => true),
        };
    }

    test("docker with a unix DOCKER_HOST gives that socket and spawns no probe", async () => {
        const spawned: string[][] = [];
        const socket = await resolveEngineApiSocket(runtimes.docker, probes({ dockerHost: "unix:///run/user/1000/docker.sock", spawned }));
        expect(socket).toBe("/run/user/1000/docker.sock");
        expect(spawned).toEqual([]);
    });

    test("docker with a DOCKER_HOST that is not a unix socket gives no socket, thus the pull goes through the CLI", async () => {
        const spawned: string[][] = [];
        for (const dockerHost of ["tcp://10.0.0.2:2375", "ssh://builder@10.0.0.2"]) {
            expect(await resolveEngineApiSocket(runtimes.docker, probes({ dockerHost, spawned }))).toBeUndefined();
        }
        expect(spawned).toEqual([]);
    });

    test("docker with no DOCKER_HOST gives the socket of the current context", async () => {
        const spawned: string[][] = [];
        const socket = await resolveEngineApiSocket(
            runtimes.docker,
            probes({ capture: { code: 0, stdout: "unix:///Users/ana/.docker/run/docker.sock\n", stderr: "" }, spawned, platform: "darwin" }),
        );
        expect(socket).toBe("/Users/ana/.docker/run/docker.sock");
        expect(spawned).toEqual([["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]]);
    });

    test("docker gives no socket when the context socket is absent on disk, the context is remote, or the inspect fails", async () => {
        const absent = probes({ capture: { code: 0, stdout: "unix:///var/run/docker.sock\n", stderr: "" }, exists: () => false });
        const remote = probes({ capture: { code: 0, stdout: "tcp://10.0.0.2:2376\n", stderr: "" } });
        const failed = probes({ capture: { code: 1, stdout: "", stderr: "context not found" } });
        for (const p of [absent, remote, failed]) expect(await resolveEngineApiSocket(runtimes.docker, p)).toBeUndefined();
    });

    test("podman gives the engine socket, and no socket when the engine is not ready", async () => {
        const running = probes({ capture: { code: 0, stdout: "/run/user/1000/podman/podman.sock\n", stderr: "" } });
        const stopped = probes({ capture: { code: 0, stdout: "/run/user/1000/podman/podman.sock\n", stderr: "" }, exists: () => false });
        expect(await resolveEngineApiSocket(runtimes.podman, running)).toBe("/run/user/1000/podman/podman.sock");
        expect(await resolveEngineApiSocket(runtimes.podman, stopped)).toBeUndefined();
    });
});

const DIGEST = "sha256:a1dffb9c2300099039d9e2dd3dbf6396a72b798c891fe170940d2d8106222a8c";

describe("splitImageRef", () => {
    test("a bare name pulls the latest tag", () => {
        expect(splitImageRef("postgres")).toEqual({ repo: "postgres", reference: "latest" });
    });

    test("a tag is the reference", () => {
        expect(splitImageRef("ghcr.io/inflexa/sandbox:v1.2")).toEqual({ repo: "ghcr.io/inflexa/sandbox", reference: "v1.2" });
    });

    test("a registry port is not a tag", () => {
        expect(splitImageRef("localhost:5000/sandbox")).toEqual({ repo: "localhost:5000/sandbox", reference: "latest" });
        expect(splitImageRef("localhost:5000/sandbox:dev")).toEqual({ repo: "localhost:5000/sandbox", reference: "dev" });
    });

    test("a digest is the reference", () => {
        expect(splitImageRef(`postgres@${DIGEST}`)).toEqual({ repo: "postgres", reference: DIGEST });
    });

    test("a tag with a digest gives the digest and drops the tag from the repository", () => {
        expect(splitImageRef(`eceasy/cli-proxy-api:v7.3.17@${DIGEST}`)).toEqual({ repo: "eceasy/cli-proxy-api", reference: DIGEST });
        expect(splitImageRef(`localhost:5000/pg:16@${DIGEST}`)).toEqual({ repo: "localhost:5000/pg", reference: DIGEST });
    });
});

describe("pullImageThroughEngine", () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) cleanup();
    });

    /** Serve `handler` on a unix socket, and give the path. The path stays short because a unix socket path has a small limit. */
    function fakeEngine(handler: (request: Request) => Response): string {
        const dir = mkdtempSync(join(tmpdir(), "pe-"));
        const socket = join(dir, "e.sock");
        const server = Bun.serve({ unix: socket, fetch: handler });
        cleanups.push(() => {
            void server.stop(true);
            rmSync(dir, { recursive: true, force: true });
        });
        return socket;
    }

    const events = (...lines: object[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join("");

    test("sends the repository as fromImage and the digest as tag for a pinned reference", async () => {
        const urls: URL[] = [];
        const socket = fakeEngine((request) => {
            urls.push(new URL(request.url));
            return new Response(events({ status: "done" }));
        });

        const outcome = await pullImageThroughEngine(socket, `eceasy/cli-proxy-api:v7.3.17@${DIGEST}`, () => undefined);

        expect(outcome).toEqual({ kind: "completed" });
        expect(urls).toHaveLength(1);
        expect(urls[0]?.pathname).toBe("/v1.41/images/create");
        expect(urls[0]?.searchParams.get("fromImage")).toBe("eceasy/cli-proxy-api");
        expect(urls[0]?.searchParams.get("tag")).toBe(DIGEST);
    });

    test("sends the tag of a tag reference", async () => {
        const urls: URL[] = [];
        const socket = fakeEngine((request) => {
            urls.push(new URL(request.url));
            return new Response(events({ status: "done" }));
        });

        await pullImageThroughEngine(socket, "postgres:16", () => undefined);

        expect(urls[0]?.searchParams.get("fromImage")).toBe("postgres");
        expect(urls[0]?.searchParams.get("tag")).toBe("16");
    });

    test("sums the newest figure of each layer and counts the completed layers", async () => {
        const socket = fakeEngine(
            () =>
                new Response(
                    events(
                        { id: "a", status: "Downloading", progressDetail: { current: 10, total: 100 } },
                        { id: "b", status: "Downloading", progressDetail: { current: 5, total: 50 } },
                        // A growing figure replaces the older one, and a lower one does not.
                        { id: "a", status: "Downloading", progressDetail: { current: 40, total: 100 } },
                        { id: "a", status: "Downloading", progressDetail: { current: 30, total: 100 } },
                        { id: "a", status: "Pull complete" },
                        { id: "c", status: "Already exists" },
                    ),
                ),
        );
        const reports: EnginePullProgress[] = [];

        const outcome = await pullImageThroughEngine(socket, "postgres:16", (progress) => reports.push(progress));

        expect(outcome).toEqual({ kind: "completed" });
        expect(reports.length).toBeGreaterThan(0);
        expect(reports.at(-1)).toEqual({ doneBytes: 45, layersCompleted: 2 });
    });

    test("an error event fails the pull with its message", async () => {
        const socket = fakeEngine(() => new Response(events({ id: "a", status: "Downloading" }, { error: "manifest unknown" })));

        const outcome = await pullImageThroughEngine(socket, "postgres:16", () => undefined);

        expect(outcome).toEqual({ kind: "failed", message: "manifest unknown" });
    });

    test("a response that is not OK reads as unavailable", async () => {
        const socket = fakeEngine(() => new Response("no", { status: 500 }));

        expect(await pullImageThroughEngine(socket, "postgres:16", () => undefined)).toEqual({ kind: "unavailable" });
    });

    test("a socket that does not answer reads as unavailable", async () => {
        expect(await pullImageThroughEngine(join(tmpdir(), "pe-missing.sock"), "postgres:16", () => undefined)).toEqual({ kind: "unavailable" });
    });

    test("a stream that breaks before its end fails the pull, and the function does not reject", async () => {
        // A raw socket, not Bun.serve: a ReadableStream error in Bun.serve ends the chunked body cleanly on
        // Linux, thus the client sees a complete response. A close before the terminating chunk is a break
        // that the HTTP client of each platform reports.
        const dir = mkdtempSync(join(tmpdir(), "pe-"));
        const socket = join(dir, "e.sock");
        const line = events({ id: "a", status: "Downloading", progressDetail: { current: 7 } });
        const listener = Bun.listen({
            unix: socket,
            socket: {
                data(client) {
                    client.write(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${line.length.toString(16)}\r\n${line}\r\n`);
                    setTimeout(() => client.end(), 20);
                },
            },
        });
        cleanups.push(() => {
            listener.stop(true);
            rmSync(dir, { recursive: true, force: true });
        });

        const outcome = await pullImageThroughEngine(socket, "postgres:16", () => undefined);

        expect(outcome.kind).toBe("failed");
        expect(outcome.kind === "failed" ? outcome.message : "").toContain("The pull stream of the engine broke");
    });
});

describe("resolveImageTotalBytes", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** A runtime whose binary logs its arguments and prints a one-layer-set manifest. */
    function fakeRuntime(): { rt: ContainerRuntime; calls: () => string[] } {
        const dir = mkdtempSync(join(tmpdir(), "rt-"));
        dirs.push(dir);
        const bin = join(dir, "engine");
        const log = join(dir, "calls.log");
        writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\necho '{"layers":[{"size":10},{"size":5}]}'\n`);
        chmodSync(bin, 0o755);
        return { rt: { ...runtimes.podman, bin }, calls: () => readFileSync(log, "utf8").trim().split("\n") };
    }

    test("a digest reference reads the manifest of the repository at the digest", async () => {
        const { rt, calls } = fakeRuntime();

        expect(await resolveImageTotalBytes(rt, `eceasy/cli-proxy-api:v7.3.17@${DIGEST}`)).toBe(15);
        expect(calls()).toEqual([`manifest inspect eceasy/cli-proxy-api@${DIGEST}`]);
    });

    test("a tag reference reads the manifest of the reference", async () => {
        const { rt, calls } = fakeRuntime();

        expect(await resolveImageTotalBytes(rt, "postgres:16")).toBe(15);
        expect(calls()).toEqual(["manifest inspect postgres:16"]);
    });
});

describe("capture bounds", () => {
    /** A runtime whose binary is the shell, so each test spells the child as `sh -c <script>` arguments. */
    const shell: ContainerRuntime = { ...runtimes.docker, bin: "/bin/sh" };

    /** A script that writes `count` bytes of `letter`. */
    const bytesOf = (letter: string, count: number, fd = ""): string => `head -c ${count} /dev/zero | tr '\\0' '${letter}' ${fd}`;

    test("keeps the head and the tail of a long stream with one marker that counts the dropped bytes", async () => {
        const result = await capture(shell, ["-c", `${bytesOf("a", 3000)}; ${bytesOf("m", 4000)}; ${bytesOf("z", 3000)}`], { maxBytesPerStream: 1000 });

        expect(result.code).toBe(0);
        // The budget splits in two halves: the first 500 bytes and the last 500 bytes.
        expect(result.stdout.startsWith("a".repeat(500) + "\n[... ")).toBe(true);
        expect(result.stdout.endsWith("\n" + "z".repeat(500))).toBe(true);
        expect(result.stdout.match(/\[\.\.\. \d+ bytes not captured \.\.\.\]/g)).toEqual(["[... 9000 bytes not captured ...]"]);
        expect(result.stdout).not.toContain("mm");
    });

    test("bounds each stream on its own", async () => {
        const result = await capture(shell, ["-c", `${bytesOf("o", 5000)}; ${bytesOf("e", 5000, ">&2")}`], { maxBytesPerStream: 100 });

        expect(result.stdout).toContain("[... 4900 bytes not captured ...]");
        expect(result.stderr).toContain("[... 4900 bytes not captured ...]");
        // The marker holds single letters, thus a doubled letter proves the other stream's bytes.
        expect(result.stdout).not.toContain("ee");
        expect(result.stderr).not.toContain("oo");
    });

    test("an output at or under the limit comes back whole with no marker", async () => {
        const exact = await capture(shell, ["-c", bytesOf("q", 1000)], { maxBytesPerStream: 1000 });
        const small = await capture(shell, ["-c", "printf 'hello\\n'"], { maxBytesPerStream: 1000 });

        expect(exact.stdout).toBe("q".repeat(1000));
        expect(small.stdout).toBe("hello\n");
        expect(small.stderr).toBe("");
    });

    test("with no limit the whole output returns", async () => {
        const result = await capture(shell, ["-c", bytesOf("w", 200_000)]);

        expect(result.stdout).toBe("w".repeat(200_000));
    });

    test("an abort kills the child, and an already aborted signal kills it at once", async () => {
        const controller = new AbortController();
        const started = Date.now();
        const pending = capture(shell, ["-c", "sleep 30"], { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);

        const killed = await pending;

        expect(Date.now() - started).toBeLessThan(10_000);
        expect(killed.code).not.toBe(0);

        const early = Date.now();
        const stopped = await capture(shell, ["-c", "sleep 30"], { signal: AbortSignal.abort() });
        expect(Date.now() - early).toBeLessThan(10_000);
        expect(stopped.code).not.toBe(0);
    });
});
