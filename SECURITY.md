# Security Policy

_Last updated: 2026-10-05 · Maintained by Inflexa, Inc._

We take the security of Inflexa seriously. Because Inflexa is a local agent that **executes AI-generated analysis code on your data inside a containerized sandbox**, its security model is central to the product, not an afterthought. This document explains how to report a vulnerability, what we consider in scope, and how the sandbox boundary is meant to work.

## The security model in brief

Two facts shape what counts as a vulnerability:

1. **The containerized sandbox is the containment boundary for command execution.** Generated code runs inside the sandbox image as a **non-root user (uid 1000)** with **all Linux capabilities dropped** and **`no-new-privileges`** set, under **CPU and memory limits**. It gets a **read-only** mount of the analysis tree and may write **only to the current step's output directory**; the package store, the per-analysis package farm nested inside it, and the reference store are all mounted read-only. It is **not given any host credential**. A file-tool write (`write_file`, `edit_file`) is host-side, not a sandbox exec. The write-prefix check, with the symlink checks, confines it to the working directory of the agent. For a sandbox agent that is the step output directory. For the conversation agent that is the analysis root, and each write records provenance. The host-side read path and the artifact-hash path do a realpath check. They refuse a symbolic link that has a target outside the analysis tree. The most serious class of issue is anything that breaks this boundary. The sandbox protocol is implemented in [`harness/`](./harness) — see [`harness/CONTEXT.md`](./harness/CONTEXT.md).

   **Network egress is blocked, and the sandbox initiates nothing.** The host polls the sandbox for the result of each command, thus the sandbox needs no egress. On Docker, the exec port is published on `127.0.0.1` only, thus the host can reach it but the LAN cannot. A root entrypoint holds `CAP_NET_ADMIN` and installs `iptables -P OUTPUT DROP`, with exceptions for loopback and for established return traffic. Then it drops to the uid-1000 workload, which can neither open a new outbound connection nor flush the rules. The poll of the host uses the established connection, thus the poll works while egress is blocked. `sandbox-server` refuses to run as root when the firewall flag is set, thus a failed privilege drop stops the start. There is no gateway sidecar and no `--internal` network. On Kubernetes, a NetworkPolicy of the deployment blocks the egress of each sandbox and admits only the Inflexa process to the exec port.

   The exec endpoints (`POST /exec`, `GET /exec/{execId}`) carry no credential. Reachability is their only protection. On Docker, a process on the host, or a container on the same Docker network, can open a connection to the exec port and run a command in the sandbox. That command has the same confinement as a command of the agent: the read-only analysis tree, writes to the step output directory only, and no egress. A sandbox cannot reach the exec port of a different sandbox, because its egress firewall blocks each connection that it starts. `sandbox-server` and the commands that it runs share uid 1000. Thus the result and the provenance frame of an exec are reports of the sandbox, not attested values.

   The confinement is enforced by the Docker backend at container creation and by the root entrypoint inside the sandbox image. The firewall lives in the image, thus **it takes effect only once the image is rebuilt and republished**.

   **The provisioner image is the deliberate privilege asymmetry, and it never sees your data.** Analysis packages are not baked into the sandbox image; they are installed into a host package store by a second image, `sandbox-provisioner`, which the CLI runs for `inflexa store add` and which the store-build workflow runs for the published catalog. It is the inverse of the sandbox on every axis: it runs as **root**, it holds the compilers, and it mounts the package store **read-write** because it writes packages into it. What bounds it is the input it is given, not the identity it runs under — its only bind mount is the package store root, so no analysis tree, no dataset, and no host credential is reachable from it. Its network is an **allowlist, never open**: an offline run gets `--network none`, and an online run gets `CAP_NET_ADMIN` plus a live-DNS `nftables` wall whose last rule is REJECT, admitting only the pinned package hosts for the tracks that run (an acquisition reaches the Python index and the pak repositories; only a catalog build reaches the GitHub hosts). A way to make the provisioner read analysis data, egress off its allowlist, or write content the sandbox later loads under a hash it did not produce is a serious report.
2. **What leaves your machine depends on the model provider you configure.** With local models, Inflexa runs end-to-end offline. With bring-your-own-key (BYOK) to a cloud provider, the data you send to that provider leaves your machine *by design and by your configuration*.

## Supported versions

| Version | Supported |
|---|---|
| Latest minor release | Security fixes |
| Older minor releases | Please upgrade |

While Inflexa is pre-1.0, security fixes ship in the latest release; we may not backport to earlier versions. We will state a clearer support window once 1.0 is released.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or Discussions.** Public disclosure before a fix is available puts users at risk.

Instead, use either of:

- **GitHub private vulnerability reporting** - on the repository, go to the **Security** tab, then **Report a vulnerability**. This is the preferred channel.
- **Email** - **security@inflexa.ai**. If you wish to encrypt your report, request our PGP key first.

Please include, as far as you can:

- the Inflexa version (`inflexa --version`) and how you installed it;
- your OS and CPU architecture, and your Docker version;
- a clear description of the issue and its security impact;
- step-by-step reproduction instructions and, if possible, a minimal proof of concept;
- any logs or output (with secrets and private data removed).

## What to expect

- **Acknowledgement** within **3 business days**.
- An initial **assessment and severity triage** shortly after, and we'll keep you updated as we investigate.
- We aim to develop and release a fix on a timeline proportional to severity, and we'll coordinate disclosure timing with you.
- With your consent, we will **credit you** in the advisory and release notes.

We practice **coordinated disclosure**: we ask that you give us a reasonable opportunity to fix an issue before disclosing it publicly, and we commit to acting promptly in return.

## In scope - issues we especially want to hear about

Given the architecture, the highest-value reports concern:

- **Sandbox escape** - generated or executed code escaping the containerized sandbox to reach the host filesystem or host processes.
- **Isolation weaknesses** - the sandbox running with more access than documented: writes outside the current step's output directory, reads outside the analysis tree, capability or privilege escalation, or access to host credentials or environment.
- **Escaping network confinement** - a sandbox must reach *nothing* outbound. Any new outbound connection from a sandbox (internet, LAN, host, or any other container) is a finding. See the security model above.
- **Reaching another sandbox's exec channel** - code that runs in one sandbox and reaches the exec port of a different sandbox, or changes a result or a provenance frame that the harness reads from a different sandbox. The exec port carries no credential, thus this is a break of the network confinement and a serious report.
- **Prompt-injection-to-execution** - content embedded in a dataset, file, metadata, or model response that induces the agent to run harmful code or attempt data exfiltration **beyond what the documented sandbox containment would prevent**. (Inducing the agent to *generate* questionable code that the sandbox still contains is interesting, but the security boundary is the sandbox; tell us when that boundary fails to hold.)
- **Provenance integrity** - tampering with, forging, or silently corrupting the SQLite lineage/audit record.
- **Unexpected data egress** - data leaving the machine in a mode where it should not (e.g. data sent to a provider while in a local-only configuration).
- **Secret and credential handling** - leakage of LLM provider API keys or other secrets via logs, error messages, the provenance store, or telemetry.
- **Package-store integrity** - the sandbox loads its R and Python packages from the host package store, so the store is part of the execution boundary: content served under a hash that does not match its bytes, a farm symlink resolving outside the pool, an acquisition that advertises a package whose load check failed, or a way to plant content one analysis loads on behalf of another.
- **Provisioner privilege** - the provisioner runs as root with the store mounted read-write and an egress allowlist (see the security model above). Reaching analysis data or host credentials from it, or egress to a host outside the allowlist, is a finding.
- **Supply-chain integrity** - issues affecting the integrity or authenticity of the published npm package, the containerized sandbox images, or the published package-store OCI artifact, including problems with signing, SBOMs, or build provenance.
- **Dependency vulnerabilities** with a realistic, demonstrated exploit path through Inflexa.

## Out of scope

The following are generally **not** considered vulnerabilities:

- The documented fact that **BYOK to a cloud LLM provider** sends data to the provider **you configured**. Use local models for fully offline operation.
- A user **deliberately instructing the agent** to perform destructive operations on their own data or files within the mounted working directory. Inflexa does what you ask, on your own machine, with your own data.
- Issues that require an **already-compromised host**, or physical/root access to the user's machine.
- Vulnerabilities solely within **third-party LLM providers**, Docker itself, or the host operating system.
- Missing hardening or best-practice suggestions with **no demonstrated impact**, raw automated-scanner output without a working exploit path, and findings that rely on social engineering of maintainers or users.

If you're unsure whether something is in scope, report it privately anyway - we'd rather hear it.

## Safe harbor

We support good-faith security research. We will not pursue or support legal action against researchers who, in good faith:

- test only against their **own** installations and data;
- avoid privacy violations, data destruction, and degradation of others' use of the software;
- do not access, modify, or exfiltrate data that isn't theirs;
- and give us a reasonable opportunity to resolve the issue before public disclosure.

## Disclosure

Confirmed vulnerabilities are published as **GitHub Security Advisories** once a fix is available, with credit to reporters who want it. Thank you for helping keep Inflexa and its users safe.