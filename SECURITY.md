# Security Policy

_Last updated: 2026-06-17 · Maintained by Inflexa, Inc._

We take the security of Inflexa seriously. Because Inflexa is a local agent that **executes AI-generated analysis code on your data inside a Docker sandbox**, its security model is central to the product, not an afterthought. This document explains how to report a vulnerability, what we consider in scope, and how the sandbox boundary is meant to work.

## The security model in brief

Two facts shape what counts as a vulnerability:

1. **The Docker sandbox is the containment boundary.** Generated code runs inside the sandbox image as a **non-root user (uid 1000)** with **all Linux capabilities dropped** and **`no-new-privileges`** set, under **CPU and memory limits**. It gets a **read-only** mount of the analysis tree and may write **only to the current step's output directory**; the library and reference stores are mounted read-only. It is **not given the sandbox callback secret or any other host credential**. The most serious class of issue is anything that breaks this boundary. The sandbox protocol is implemented in [`harness/`](./harness) — see [`harness/CONTEXT.md`](./harness/CONTEXT.md).

   **Network egress is confined, and the sandbox keeps exactly one door.** The container joins a per-analysis Docker network created with `--internal`, which removes every route off that bridge: no internet, no LAN, no direct path to the host. Because `--internal` also removes published ports, a small **gateway** container — the same image, no bind mounts, and deliberately **no callback secret** — bridges the two directions the exec protocol needs: it forwards `/exec` inbound from a loopback-bound port, and callbacks outbound to the Inflexa process. Nothing else is reachable. Sandboxes belonging to different analyses cannot reach each other.

   Two limits are worth stating plainly. **Sibling steps of the same analysis share a network** and can reach each other's `/exec`, which is unauthenticated; this matches the isolation they already have, since every step receives a read-only mount of the whole analysis tree. And **the gateway's one destination is the Inflexa callback endpoint**, so generated code can still send bytes there — it simply cannot sign them, because the callback secret is withheld from the commands `sandbox-server` spawns. Egress confinement narrows *who* can reach that endpoint; the HMAC is what makes reaching it useless.

   The confinement is enforced by the Docker backend at container creation; the credential withholding is enforced inside the sandbox image, so **it takes effect only once the image is rebuilt and republished**.
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

- **Sandbox escape** - generated or executed code escaping the Docker sandbox to reach the host filesystem or host processes.
- **Isolation weaknesses** - the sandbox running with more access than documented: writes outside the current step's output directory, reads outside the analysis tree, capability or privilege escalation, or access to host credentials or environment.
- **Escaping network confinement** - reaching the internet, the LAN, the host, or another analysis's sandbox from inside a sandbox container. Reaching the Inflexa callback endpoint is expected (it is what the gateway forwards to) and is not itself a finding; reaching *anything else* is. Note that sibling steps of one analysis share a network by design - see the security model above.
- **Forging the exec or provenance channel** - code running inside the sandbox producing a completion callback, exit code, stdout, or provenance frame that the harness accepts as authentic. The callback secret is deliberately withheld from spawned commands and from the gateway; a way to recover it, or to sign without it, is a serious report.
- **Prompt-injection-to-execution** - content embedded in a dataset, file, metadata, or model response that induces the agent to run harmful code or attempt data exfiltration **beyond what the documented sandbox containment would prevent**. (Inducing the agent to *generate* questionable code that the sandbox still contains is interesting, but the security boundary is the sandbox; tell us when that boundary fails to hold.)
- **Provenance integrity** - tampering with, forging, or silently corrupting the SQLite lineage/audit record.
- **Unexpected data egress** - data leaving the machine in a mode where it should not (e.g. data sent to a provider while in a local-only configuration).
- **Secret and credential handling** - leakage of LLM provider API keys or other secrets via logs, error messages, the provenance store, or telemetry.
- **Supply-chain integrity** - issues affecting the integrity or authenticity of the published npm package or the Docker sandbox image, including problems with signing, SBOMs, or build provenance.
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