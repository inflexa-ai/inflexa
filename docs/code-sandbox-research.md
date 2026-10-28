# Research: a small execution runtime for codemode and for short data scripts

> This document is research for a GitHub issue and for an OpenSpec change. It
> gives the facts and a recommendation. It is not a design.
>
> Sources: `earendil-works/pi` at `bdb1517` (`@earendil-works/pi-codemode`
> 1.4.0, `quickjs-wasi` 3.6.2, QuickJS-NG 0.17.0), Pyodide 314.0.7,
> `pydantic/monty` 1.3.0, the vendor documents, release notes, price pages, and
> advisories in the list at the end, and inflexa `main` at `3195eb9`. A path
> that starts with `codemode/` is in `earendil-works/pi` at `bdb1517`.
> Researched 2026-10-24. A claim with the mark UNCONFIRMED has no primary source.

## 1. The questions and the answers

1. **Which runtimes exist now?** Section 3 gives the candidates of each class:
   in-process JS, Python in WASM, OS process sandboxes, microVMs and user-space
   kernels, and hosted services.
2. **What are the facts for each candidate?** Section 3. Section 3.6 gives the
   escapes.
3. **Which candidate fits?** `pi-codemode` fits codemode. For data scripts, no
   small runtime gives pandas and pyarrow at GB scale behind an isolation
   boundary. Section 4 gives the split.
4. **What must the harness add?** A deterministic run with a DBOS step for
   each nested tool call, and provenance from the host. No new backend is
   necessary. Section 5.

## 2. The jobs that start a container today

| Job | Script and libraries | Inputs | Output | Deadline, size |
| --- | --- | --- | --- | --- |
| `derive_table` | The agent writes Python, at most 64 KiB, run with `python3 -c` (`derive-table.ts:128`, `:167`). It loads each input into pandas (`:122-123`) | At most 20 pinned artifacts, each with its hash, in `DERIVE_INPUTS` (`:131`, `:170`) | One CSV in the `derived/` directory of the session, the one write mount (`:247`, `:320-321`) | 300 s, 2 CPU, 8 GB (`:119`, `:125`) |
| extract-values | A fixed script with pandas, pyarrow, and `hashlib` (`extract-values-script.ts:58-64`, `:103`) | CSV, TSV, JSON, or parquet files over the 16 MiB host cap, or files that the host parse refused (`production-resolver.ts:59`, `:502-503`) | JSON rows on stdout (`:185`) | 300 s, 2 CPU, 8 GB, read-only (`extract-values.ts:45`, `:52`, `:157`) |
| data profile | An LLM agent loop with `execute_command` (`data-profile.ts:759-804`). The header readout uses pyarrow, h5py, and pypdf (`input-scan/decoder/container_readout.py:54`, `:73`, `:93`) | The full tree `data/inputs/` (`data-profile.ts:116`) | A record in Postgres. The scratch tree is deleted (`data-profile.ts:209-211`) | 20 min (`:100`). The size comes from the file sizes (`estimate-data-profile-resources.ts`) |

The cost of the current path:

- Each job makes a container, polls `/health` each 250 ms for at most 30 s,
  runs one exec, and removes the container (`docker-client.ts:60`, `:73`,
  `:208-222`, `derive-table-exec.ts:63-93`).
- The exec polls one time after the submit, then each 1.5 s (`exec.ts:31-33`,
  `:240-241`). Thus a script that outlasts the first poll returns its result
  1.5 s after the submit, at the earliest.
- On K8s, a pod on a warm node starts "in seconds", and the wait can last
  5 min (`k8s-client.ts:64-72`).
- `derive_table` does not use the provenance frame of sandbox-server. The host
  records the declared inputs, their hashes, the script hash, and the output
  hash (`derive-table.ts:380-388`, `:504-510`). Only `execute_command` reads
  the frame (`execute-command.ts:197-215`).
- The CLI is a Bun single-file executable (`cli/scripts/build.ts:1-2`). The
  managed deployment runs the harness on Node.js 24 (`harness/package.json:27-29`).
  Thus a candidate must run on Bun and on Node.

**The data profile is not a short script.** It is an agent with a shell and
the packages of the farm. **Extract-values exists for the files that the host
cannot parse in-process.** Thus a runtime that reads through the host parser
cannot replace it.

## 3. The candidates

### 3.1 In-process JS

| Candidate | Isolation and escapes | Start | Limits and access | Hosts, license, maturity |
| --- | --- | --- | --- | --- |
| `pi-codemode` 1.4.0 | QuickJS-NG in its own WASM instance, a worker thread for each run. The only imports are a WASI shim and one host-call entry. No files, network, timers, or modules [1] | About 20 ms for each run, vendor [1] | `memoryLimitBytes` (no default below the 4 GiB of wasm32), `timeoutMs` (default 300 s), 16 Mi characters of output [1] | Node and Bun. MIT. Versions 1.2.0 to 1.4.0 came out in October 2026 [2]. Young |
| isolated-vm 7.0.1 | V8 isolate in a native addon. Critical escape GHSA-864f-rcv7-6rh4, 2026-08-07 [3] | Not published | `memoryLimit` "is more of a guideline" [3] | ISC, "maintenance mode" [3]. Bun: UNCONFIRMED |
| workerd, Dynamic Workers, `@cloudflare/codemode` | V8 isolates. "`workerd` is not a hardened sandbox" [4]. The Check Point escape of section 3.6 | "a few milliseconds", vendor [5] | `globalOutbound: null` blocks egress [6] | workerd self-hosts. Dynamic Workers: Cloudflare only, open beta, $0.002 for each Worker each day [7] |
| Deno 2.9.8 permissions | CVE-2026-49406 (`--allow-read` bypass) and CVE-2026-49411 (`--deny-net` bypass) [8] | One process | A symbolic link in a permitted path reads outside it [9] | MIT |
| secure-exec 0.2.22, Vercel `run` 2.1 | V8 isolates in a sidecar, and QuickJS-NG [10][11] | 13.7 ms warm and 5.1 ms, Rivet [10] | Files and network off by default | Apache-2.0, 2026 |

The Node.js permission model "does not protect against malicious code"
([12]). `node:vm` and vm2 are no boundary either ([12][13]).
quickjs-emscripten 0.32.0 bundles QuickJS-NG 0.12.1, with CVE-2026-37630 ([14]).

### 3.2 Python in WASM and restricted interpreters

| Candidate | Isolation and escapes | Start | pandas, numpy, pyarrow | Limits and access |
| --- | --- | --- | --- | --- |
| Pyodide 314.0.7 | None: "Python code running in pyodide can run arbitrary javascript" [15]. Escapes CVE-2025-68668 (n8n) and CVE-2026-24002 (Grist) [16] | 1.4 s cold, 0.35 s from a memory snapshot, a maintainer [17] | numpy 2.4.6, pandas 3.0.2, pyarrow 22.0.0 [18] | A 4 GiB heap at most, and no memory64 plan [19]. `mountNodeFS` has no read-only mode. No option denies the network [19] |
| CPython on WASI | wasmtime gives a read-only directory only through its embed API. CVE-2026-47261 bypasses that permission [20] | 16 ms precompiled, the Monty team [21] | No official wheels [22]. `wasi_python` 0.1.0 (2026-10-23) has pandas, not pyarrow [23] | No sockets by default |
| Monty 1.3.0 | "language-level sandbox, not an OS-level one", a worker subprocess for each session [24] | 0.8 ms from a pool, vendor [21] | None: "There is no `sys.path` and no site-packages" [25] | `MountDir` with `mode='read-only'`, `max_memory`. `dump()` saves a paused run at a host call [24]. MIT, 1.0.0 on 2026-09-25 |

The smolagents executor had the escape CVE-2025-5120 ([26]). RustPython and
MicroPython have no pandas.

### 3.3 OS process sandboxes

- **Anthropic `sandbox-runtime` 0.0.81** (Apache-2.0, "Beta Research
  Preview") uses bubblewrap and seccomp on Linux, and Seatbelt on macOS. A
  proxy with a domain allowlist controls egress. It has no memory or CPU limit
  ([27]). CVE-2025-66479 left the network open for an empty allowlist ([28]).
  Codex uses the same tools from 2026-03-12 ([29]).
- **In an EKS pod, a namespace sandbox fails.** The default seccomp profile of
  containerd lets `unshare` and `mount` run only with `CAP_SYS_ADMIN` ([30]).
  Bottlerocket sets `user.max_user_namespaces=0` ([31]).
- **Landlock** runs with no capability, and its syscalls are in the default
  allowlist ([30]). TCP rules start in Linux 6.7 ([59]). UDP rules come in
  Linux 7.2 (UNCONFIRMED). The AL2023 nodes for Kubernetes 1.33 to 1.37 run
  Linux 6.12 or 6.18 ([32]). Landlock is Linux only.
- **Memory.** On cgroup v2 an OOM kills each process of the container ([33]).
  Thus a script in the harness container can stop the harness.
- **Platform.** On macOS the package store holds Linux builds. Thus a host
  Python on a Mac cannot use the store.

### 3.4 MicroVMs and user-space kernels

| Candidate | Isolation and escapes | Start | Hosts |
| --- | --- | --- | --- |
| Firecracker 1.17.0 | KVM. CVE-2026-5747 (virtio-pci, opt-in) [34] | At most 125 ms to `init`, vendor CI [35] | Linux KVM. EKS: metal, or nested virtualization on C8i, M8i, and R8i from 2026-02-16 [36] |
| libkrun 1.19.7, microsandbox 0.7.10 | KVM or HVF. The guest network is the network of the VMM [37]. microsandbox had host-write advisories in 2026 [38] | Under 100 ms on an M1, vendor [38] | macOS arm64 and Linux KVM. microsandbox is "still beta" |
| Apple `container` 1.6.1 | One VM for each container | "sub-second", vendor [39] | macOS 26 on Apple Silicon. No `--network none` [39] |
| gVisor 20261019.0 | User-space kernel. CVE-2026-95702 runs code in the Sentry, which seccomp still confines [40] | "negligible" on EKS, with 10 to 30 % more I/O time, an AWS employee [41] | Linux. EKS: a containerd shim and a RuntimeClass, which the harness already sets (`k8s-client.ts:364-368`) |
| Kata 4.3.1 | A VM for each pod. Critical 2026 CVEs in virtiofsd and in annotations [42] | About 5 s on EKS with the pod schedule, an AWS employee [41] | EKS: metal or nested virtualization |
| Hyperlight 0.18.0, hyperlight-js 0.4.0 | A micro VM with no guest OS. hyperlight-js runs QuickJS in it [43] | "milliseconds", vendor [43] | KVM, MSHV, WHP, and HVF on macOS arm64 [43]. hyperlight-js is young |

`kubernetes-sigs/agent-sandbox` 1.0.8 gives warm pools of gVisor or Kata pods on
each cluster ([44]). Each project in this table has the Apache-2.0 license.

### 3.5 Hosted services

- **AWS AgentCore Code Interpreter** runs a microVM for each session, with
  pandas, numpy, and pyarrow ([45]). The VPC mode mounts EFS or S3 Files
  read-only ([46]). Unit 42 sent data out through DNS in the Sandbox mode
  ([47]). The price is $0.0895 for each vCPU-hour and $0.00945 for each
  GB-hour ([48]).
- **E2B** uses Firecracker, with about 80 ms from a snapshot, a vendor claim
  ([49]). Its Apache-2.0 infra self-hosts on Linux KVM only ([50]).
- **Anthropic programmatic tool calling** lets the model write code that calls
  tools in a container of Anthropic ([51]). The tool results do not go into the
  context. The feature is not ZDR-eligible, and `allowed_callers` is not "a
  security boundary" ([51]). It works with Claude models only.
- **Modal, Vercel, Cloudflare Sandbox, OpenAI, Google, Deno Sandbox, and
  Fly.io Sprites** are hosted services. This research found no self-host path
  for them (UNCONFIRMED). Daytona went closed source on 2026-06-11 ([53]).
- **An independent benchmark** gives burst start medians from 442 ms (Blaxel)
  to 1439 ms (E2B) ([52]).

### 3.6 The escapes that matter

- **Check Point, "When Agentic Glue Melts" (2026-08-07).** The JavaScript of a
  model can reach memory bugs in the C++ glue of workerd (URLPattern, zlib,
  HTMLRewriter) ([54]). The authors got host code on a self-hosted workerd
  with the V8 sandbox off. No CVE exists, and workerd
  v1.20260619.1 has the fixes. Their lesson: "The engine is not the whole
  boundary."
- **runc**: CVE-2024-21626, and CVE-2025-31133, CVE-2025-52565, and
  CVE-2025-52881 of 2025-11-06 ([55]). These apply to the current container
  path.
- **QuickJS-NG**: each advisory of 2026 affects a version below 0.16.0, for
  example the critical GHSA-m53g-qx47-3h38 ([56]). Some are heap overflows on
  32-bit builds, the class of wasm32. `quickjs-wasi` 3.6.2 has 0.17.0 ([57]).

The glue of `pi-codemode` is small. It is the WASI shim and one bridge function
that takes primitives and JSON (`codemode/src/runtime/vm.ts:103-145`,
`:254-296`). A corrupt QuickJS heap stays in the WASM memory. Thus the tools
are the attack surface, and each tool must refuse an input that is not correct,
the same as for a direct call.

## 4. The fit

### 4.1 Codemode

**The recommendation: `pi-codemode`.** The reasons:

- The only capability is the tools that the host gives. No file or network
  rule is necessary.
- It runs on Node and on Bun, inside the harness process. Thus the laptop and
  EKS get no new backend.
- `start()` gives a deterministic run: a virtual clock from `startedAt`,
  random values from `seed`, UTC, and results in the order that the host
  numbers (`codemode/src/runtime/vm.ts:23-36`). Section 5 uses this for DBOS
  replay.

Monty is the alternative for Python, with `dump()` at each host call. It runs
a subprocess for each session, and it has no packages. Programmatic tool
calling ties the harness to one provider, and the tool results go to
Anthropic. isolated-vm and workerd had critical escapes in 2026 (sections 3.1 and 3.6).

### 4.2 Short data scripts

No small runtime has all of these properties: pandas and pyarrow, GB inputs,
read-only files, and an isolation boundary.

- Pyodide: Python reaches the host, and the heap stops at 4 GiB.
- CPython on WASI has no pyarrow. Monty has no packages.
- A namespace sandbox fails in a default EKS pod, and a Mac has no Linux
  package store.
- A microVM has all of the properties, but each host gets a new backend. On
  EKS each node must run with nested virtualization.

**The recommendation: a split by size.**

1. **A small table**, with each input at or under the 16 MiB host cap. Run the
   derivation as JavaScript in the same QuickJS runtime. A host function reads
   each declared input with the parsers of the host fast path
   (`production-resolver.ts:7`, `hyparquet` at `harness/package.json:84`). A second host function writes the CSV into
   `derived/`. The model then writes JavaScript, not pandas, thus the tool text
   changes (`derive-table.ts:241`).
2. **A large table, extract-values, and the data profile.** Keep the
   sandbox-base container. To cut the wait, keep one container warm for a
   report session, and poll faster in the first seconds.

### 4.3 One runtime for both uses

QuickJS serves codemode and the small derivations. Only a microVM with a tool
bridge serves both uses at full scale, at the cost of a new backend.

## 5. What the harness needs

### Durability

Today each exec is one DBOS step with the id `${workflowId}:${stepId}`, and
sandbox-server ignores a second submit of the same id (`exec.ts:76-88`).

- **Codemode as one step.** A DBOS step inside a step runs inline, the same as
  an exec inside a tool call (`client.ts:61-65`). Thus a crash runs the script
  and each nested call again.
- **Codemode in the workflow body.** Read `startedAt` and `seed` from a
  checkpoint, and call `sandbox.start()`. Make each nested call a DBOS step.
  On recovery the steps give their cached results, and the deterministic VM
  makes the same calls again.
  - Start each step in the order of `call.id`, with no `await` before it.
    `@dbos-inc/vercel-ai` gives the same rule for parallel tool calls ([58]).
  - Deliver the results in an order that a replay can make again: the call
    order, or an order that a step records.
  - Compare the fingerprint of `onStarted` at recovery.
- **A data script in QuickJS** stays one step, the same as an exec today. Use
  the checkpointed clock for the deadline (`derive-table-exec.ts:78-79`).

### Provenance and policy

- `pi-codemode` calls the `execute` of a tool directly, and that call skips
  the hooks of the host ([1]). Thus the codemode tool must apply the tool mask
  (`loop/tool-mask.ts:14`) and `ctx.ask` (`define-tool.ts:168`) to each
  nested call. It must also record each call from `result.calls`.
- For a small derivation the host reads each input, thus it knows each read.
  It emits `run-derivation` the same as today (`derive-table.ts:380-388`). No
  frame of sandbox-server is necessary.
- The container path keeps its frame.

### Backends

- QuickJS changes nothing in the Docker, podman, or K8s backends.
- The CLI build must embed the worker entry and the wasm file, because the
  CLI is a Bun single-file binary ([1]).
- Set `memoryLimitBytes` for each run, and cap the worker count with
  `acquireWorker()` ([1]). The workers share the memory of the harness pod.
- A later microVM or AgentCore realization goes behind the `SandboxClient`
  interface (`client.ts:27`).

## 6. Recommendation

1. **Codemode: `pi-codemode` in the workflow body, with a DBOS step for each
   nested call.** A single step runs each nested call again after a crash,
   and some nested tools write state.
2. **Small derivations: JavaScript in the same runtime.** The read-only rule,
   the egress rule, and the provenance record stay in the host.
3. **Large data, extract-values, and the data profile: the container, warm
   for each session.** Section 4.2 gives the reasons.
4. **Do not use these as a boundary: Pyodide in the harness process,
   isolated-vm, workerd, vm2, or Deno permissions.** Section 3 gives the
   reasons.
5. **A stronger boundary later: hyperlight-js.** It runs QuickJS in a micro VM
   on macOS arm64 and on Linux KVM. On EKS the node must have KVM.

## 7. Open questions

- Does the agent write a derivation in JavaScript as well as in pandas? A
  bench run must show the answer.
- Which result order does a replay of parallel nested calls use?
- Which workflow owns a warm container of a report session? A report turn is
  not a workflow (`derive-table.ts:32-33`).
- How does a nested call get a result that the tool output store cut?
- Which memory limit and worker count fit the harness pod on EKS?

## Sources

- [1] <https://github.com/earendil-works/pi/tree/bdb151774ed6bef2b5676bbff4669f20a0c233fe/packages/codemode>
- [2] <https://github.com/earendil-works/pi/blob/bdb151774ed6bef2b5676bbff4669f20a0c233fe/packages/codemode/CHANGELOG.md>
- [3] <https://github.com/laverdet/isolated-vm>
- [4] <https://github.com/cloudflare/workerd>
- [5] <https://blog.cloudflare.com/dynamic-workers/>
- [6] <https://developers.cloudflare.com/agents/api-reference/codemode/>
- [7] <https://developers.cloudflare.com/dynamic-workers/pricing/>
- [8] <https://github.com/denoland/deno/security/advisories>
- [9] <https://docs.deno.com/runtime/reference/permissions/>
- [10] <https://rivet.dev/secure-exec/docs/benchmarks/>
- [11] <https://github.com/vercel-labs/run>
- [12] <https://nodejs.org/docs/latest-v24.x/api/permissions.html>
- [13] <https://github.com/patriksimek/vm2/security/advisories>
- [14] <https://nvd.nist.gov/vuln/detail/CVE-2026-37630>
- [15] <https://github.com/pydantic/mcp-run-python>
- [16] <https://nvd.nist.gov/vuln/detail/CVE-2026-24002>
- [17] <https://blog.python.org/2026/09/language-summit-2026-memory-snapshots/>
- [18] <https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide-lock.json>
- [19] <https://github.com/pyodide/pyodide/issues/6073>
- [20] <https://github.com/bytecodealliance/wasmtime/security/advisories>
- [21] <https://github.com/pydantic/monty/blob/main/docs/alternatives.md>
- [22] <https://snarky.ca/state-of-wasi-support-for-cpython-march-2026/>
- [23] <https://github.com/ClayGendron/wasi_python>
- [24] <https://github.com/pydantic/monty/blob/main/docs/security.md>
- [25] <https://github.com/pydantic/monty/blob/main/docs/limitations/index.md>
- [26] <https://nvd.nist.gov/vuln/detail/CVE-2025-5120>
- [27] <https://github.com/anthropics/sandbox-runtime>
- [28] <https://github.com/anthropics/sandbox-runtime/security/advisories/GHSA-9gqj-5w7c-vx47>
- [29] <https://github.com/openai/codex/pull/13996>
- [30] <https://github.com/containerd/containerd/blob/main/contrib/seccomp/seccomp_default.go>
- [31] <https://github.com/bottlerocket-os/bottlerocket/issues/3200>
- [32] <https://github.com/awslabs/amazon-eks-ami/releases/tag/v20261019>
- [33] <https://kubernetes.io/blog/2026/10/06/kubernetes-cgroups-v2-shift/>
- [34] <https://github.com/firecracker-microvm/firecracker/security/advisories/GHSA-776c-mpj7-jm3r>
- [35] <https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md>
- [36] <https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual/>
- [37] <https://github.com/libkrun/libkrun/blob/main/docs/security-model.md>
- [38] <https://github.com/superradcompany/microsandbox>
- [39] <https://github.com/apple/container>
- [40] <https://nvd.nist.gov/vuln/detail/CVE-2026-95702>
- [41] <https://builder.aws.com/content/3ADDWTtyI2gevtzY9d2vzULAxzS/secure-agent-sandboxes-on-eks>
- [42] <https://github.com/kata-containers/kata-containers/security/advisories>
- [43] <https://github.com/hyperlight-dev/hyperlight>
- [44] <https://github.com/kubernetes-sigs/agent-sandbox>
- [45] <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-preinstalled-libraries.html>
- [46] <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-filesystem-configurations.html>
- [47] <https://unit42.paloaltonetworks.com/bypass-of-aws-sandbox-network-isolation-mode/>
- [48] <https://aws.amazon.com/bedrock/agentcore/pricing/>
- [49] <https://e2b.dev/docs/template/how-it-works>
- [50] <https://github.com/e2b-dev/infra>
- [51] <https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>
- [52] <https://www.computesdk.com/benchmarks/sandboxes/burst-tti>
- [53] <https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source>
- [54] <https://research.checkpoint.com/2026/when-agentic-glue-melts/>
- [55] <https://nvd.nist.gov/vuln/detail/CVE-2025-31133>
- [56] <https://github.com/quickjs-ng/quickjs/security/advisories>
- [57] <https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi@3.6.2>
- [58] <https://github.com/dbos-inc/dbos-vercel-ai>
- [59] <https://man7.org/linux/man-pages/man7/landlock.7.html>
