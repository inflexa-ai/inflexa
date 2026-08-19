# Multi-Ecosystem Package Manifests: Is `lib-store-manifest.yaml` Warranted, or Should Inflexa Adopt a Standard?

## TL;DR
- **Keep the custom manifest, but harden it.** No existing standard can express all of Inflexa's hard requirements in one document — R-from-arbitrary-git-commit + PyPI + bioconda CLI tools + npm + per-arch splits + structured rationale + capability advertisement. A *cross-ecosystem intent layer* is a genuine, unfilled gap; the two-layer manifest→lockfile pattern is universal *within* single ecosystems but has no cross-ecosystem standard. The ad-hoc file is therefore warranted as an **intent/orchestration layer**, but its use of YAML comments for rationale and its lack of a schema are real, fixable defects.
- **Pixi is the strongest partial adoption** and the biggest gap the team failed to evaluate: it unifies conda-forge + bioconda + PyPI in one `pixi.toml` with first-class `platforms`/`target.<arch>` splits and a cross-platform `pixi.lock`. But it **cannot** install an R package from an arbitrary GitHub tag or a `git.bioconductor.org` commit without a conda recipe — exactly the R-from-git capability only pak/renv/remotes have (pixi's own docs: "We don't support git+ urls as dependencies for pip packages," and conda/source git deps require an in-repo recipe).
- **Recommended path:** (1) add a JSON Schema + `yaml-language-server` modeline and convert `# comments` into structured `reason:` fields now; (2) treat the manifest as the intent layer over the existing R lock + `uv` lock; (3) emit a **CycloneDX SBOM as an output artifact** using **purl** identifiers (`pkg:cran`, `pkg:pypi`, `pkg:conda`, `pkg:bioconductor`, `pkg:github`, `pkg:npm` all exist). Do **not** adopt Nix wholesale, and do not collapse R into conda/pixi.

## Key Findings

1. **No single standard covers all four ecosystems plus the non-dependency concerns.** The candidates cluster into (a) conda-centric multi-language managers (Pixi, conda/mamba), (b) purpose-built universal store/build systems (Nix, Spack, Guix, EasyBuild), (c) language-native two-layer standards (pyproject+pylock, renv/pak, package.json), (d) container/devenv orchestration (devcontainer Features, buildpacks, Wave), (e) workflow-manager software specs (CWL `SoftwareRequirement`, Nextflow/Snakemake conda directives, BioContainers), and (f) SBOM/identity standards (purl, CycloneDX, SPDX). Only Nix/Guix and, partially, Pixi/conda are genuinely "one document, multiple ecosystems," and none of them cleanly carries the capability-advertisement + rationale + arch-split + package→binary-map concerns.

2. **Pixi (the team's #1 unevaluated gap) is genuinely strong but R-limited.** `pixi.toml` expresses conda (conda-forge + bioconda) and PyPI dependencies in one manifest, resolving conda first (via `rattler`/`resolvo`) then PyPI (via embedded `uv`), producing a single cross-platform `pixi.lock`. It has first-class `platforms` and `[target.linux-aarch64.dependencies]` splits — directly modeling the amd64/arm64 problem. R packages *are* installable as conda packages (`r-*` from conda-forge, `bioconductor-*` from bioconda). **But**: pixi's git dependencies are for building recipe-bearing conda/pixi source packages, not arbitrary R packages; there is "currently no way" to install an R package from GitHub@tag directly in pixi without authoring a recipe — the community answer is to shell out to `pak::pkg_install()` inside the pixi environment. Pixi is BSD-3-licensed and very actively developed: its latest release is **v0.76.1 (August 10, 2026)** (v0.71.1 was June 25, 2026; v0.67.0 shipped April 8, 2026), and it ships `pixi-pack` for relocatable deployment.

3. **Nix/Guix can technically express everything but at prohibitive cost, and still can't advertise capabilities.** Per the rOpenSci {rix} README, "we offer the guarantee that most CRAN and Bioconductor packages are supported and installable through Nix (less than 5% of packages aren't currently supported)," plus PyPI (via uv2nix/poetry2nix), npm, and bioinformatics tools. The `rstats-on-nix` fork gives dated CRAN/Bioconductor snapshots with a Cachix binary cache. But: nixpkgs R packages lag CRAN — as maintainer Bruno Rodrigues notes, "while CRAN and Bioconductor get updates daily, the R packages set on Nix gets updated only around new releases of R" (the fork adds daily dated-branch snapshots only "since the 14th of December 2024"). Heavy scientific packages often compile from source unless cached, and the /nix/store is fundamentally non-relocatable (absolute `/nix/store/...` paths). Adopting Nix means rewriting the entire build in a new language, and Nix expressions still don't natively encode "advertise these to the agent but not those."

4. **The two-layer manifest→lockfile pattern is universal within ecosystems but has no cross-ecosystem standard.** package.json→package-lock.json, pyproject.toml→uv.lock/pylock.toml, environment.yml→conda-lock, spack.yaml→spack.lock, pixi.toml→pixi.lock, flake.nix→flake.lock, DESCRIPTION/renv→renv.lock. Inflexa already implements this per-ecosystem (gen-r-lock.R → pak/renv-style lock; uv resolves Python). What does **not** exist as a standard is a single *abstract intent layer spanning four ecosystems* — this is precisely what `lib-store-manifest.yaml` is, and there is no off-the-shelf tool for it.

5. **PEP 751 `pylock.toml` is now real but is a lockfile (output), not an intent manifest.** Accepted 2025; pip 26.1 (April 2026) added experimental `pip install -r pylock.toml`; uv exports it via `uv export -o pylock.toml`; PDM and pipenv support it. It standardizes the *resolved* layer, not the *intent* layer, and is Python-only. It does not replace the manifest.

6. **purl is a viable canonical cross-ecosystem identifier; CycloneDX/SPDX are output SBOM formats, not input manifests.** purl was approved as **ECMA-427, 1st edition, by the Ecma International General Assembly on 2025-12-10**, and defines `pkg:pypi`, `pkg:cran`, `pkg:bioconductor`, `pkg:conda`, `pkg:github`, `pkg:npm`, and `pkg:generic` — covering every one of Inflexa's sources. CycloneDX (v1.7, published October 21, 2025, "the final version in the 1.x series," ratified as ECMA-424 2nd edition on 2025-12-10) can represent "intended vs resolved" via lifecycle phases (`design`/`build`/`post-build`) and pedigree, but it is designed as a build *output*, not a hand-authored input.

## Details

### A. Landscape survey

**Pixi (`pixi.toml`/`pixi.lock`).** Built by prefix.dev on the `rattler` conda library, pixi unifies conda and PyPI in one manifest. Conda deps go in `[dependencies]`, PyPI in `[pypi-dependencies]`; it resolves conda first then maps to PyPI via `parselmouth` and resolves the remainder with embedded `uv`. Platform handling is first-class: `platforms = ["linux-64","linux-aarch64","osx-arm64"]` and per-platform overrides via `[target.linux-64.dependencies]` and even virtual-package-qualified platforms (`{platform="linux-64", cuda="12.0", glibc="2.28"}`). `features`/`environments` give multiple named environments from one file. R is supported through conda packages (`pixi add r-base`, `bioconductor-*` from bioconda after `pixi workspace channel add bioconda`). Relocatability is handled out-of-band by `pixi-pack` (re-installs from lockfile into an arbitrary target dir, cross-platform, avoiding conda-pack's prefix-length/one-shot pitfalls). **Hard limit:** pixi cannot pull an arbitrary R package from GitHub@tag or git.bioconductor.org@commit without a conda/rattler recipe — its `--git` source deps require an in-repo `pixi.toml [package.build]` or `recipe.yaml`, and its docs state plainly "We don't support git+ urls as dependencies for pip packages." This is the single most important finding for Inflexa, because their manifest has `r.github` and `r.git` (commit-pinned) tracks that pixi structurally cannot represent.

**Nix / flakes / devenv / flox.** nixpkgs covers the vast majority of CRAN and Bioconductor via `rPackages`/`rWrapper` (rOpenSci's `rix` states less than 5% unsupported), plus Python (uv2nix/poetry2nix/pyproject.nix), npm, and bioinformatics tools. Binary caches (cache.nixos.org via Hydra; rstats-on-nix Cachix) cover popular packages; bleeding-edge or forked package sets compile from source. Declaring "install these and nothing more" is natural in Nix (explicit closure). **Costs:** nixpkgs R lags CRAN (per-R-release cadence); the /nix/store is not relocatable to /opt; and it's a wholesale rewrite in the Nix language. Not warranted here.

**conda/mamba/micromamba `environment.yml` + conda-lock.** Can express conda-forge + bioconda + a `pip:` subsection. `r-*` and `bioconductor-*` packages exist. **But** `environment.yml` has no field for a git URL/commit — you can only name pre-built channel packages by version/build string. An R package from an arbitrary `git.bioconductor.org` commit cannot be expressed without authoring and building a new conda recipe. conda-lock produces the resolved layer.

**Spack `spack.yaml` / EasyBuild / Guix.** The team already dismissed these for the *store*. As *manifest formats*: spack.yaml is HPC-source-build oriented and weak on PyPI/npm/arbitrary-git-R; EasyBuild easyconfigs are per-package build recipes, not a cross-ecosystem manifest; Guix manifests/`guix.scm` are Scheme (like Nix, wholesale adoption). None fits the intent-layer + advertisement role better than the custom file. (Notably, Spack *does* model Bioconductor R packages via git repos with per-release branch commits — evidence the git-commit approach Inflexa uses is a recognized pattern, but Spack as a whole is not the right manifest format here.)

**Language-native two-layer standards.**
- **Python:** `pyproject.toml` (PEP 621) + **PEP 751 `pylock.toml`** (accepted 2025; pip 26.1 install support April 2026; uv/PDM/pipenv export). Full PEP 508 markers/extras. This is the right *resolved* layer for the Python track; `uv.lock` is the richer cross-platform equivalent Inflexa already uses.
- **R:** `renv.lock` / `DESCRIPTION`+`Remotes:` / **pak/pkgdepends** references. This is the *only* stack that can express the full R source matrix: `cran::`, `bioc::`, `github::user/repo@tag`, `github::user/repo@commit`, `gitlab::`, `bitbucket::`, and **`git::https://git.bioconductor.org/packages/limma`** (arbitrary git URL + commit, explicitly supported since pkgdepends added git-protocol-v1). renv.lock stores `RemoteSha` for exact-commit restore, and its `Source` field spans Repository/Bioconductor/GitHub/GitLab/Bitbucket/Local. Inflexa's `gen-r-lock.R` already sits here.
- **Node:** `package.json`+`package-lock.json` — trivially covers the single `node: [echarts]` entry.

**Container/devenv-oriented.**
- **Dev Container Features** (`devcontainer.json` `features`): reusable OCI-published install units, version-pinnable, with `.devcontainer-lock.json`. Good for *tools*, but each Feature is a shell installer; not a declarative multi-ecosystem package list, and not a capability catalog.
- **Cloud Native Buildpacks / repro-env / mise / asdf / devbox / hermit:** runtime-version managers, not multi-ecosystem package-set declarations at the granularity Inflexa needs.
- **Dockerfile/Docker Bake:** the de facto standard, but imperative, not a declarative advertised package set.

**Scientific workflow ecosystems.**
- **CWL `SoftwareRequirement`/`SoftwarePackage`** is the closest *conceptual* match to Inflexa's file: it declares `packages:` with `package`, `version[]`, and `specs[]` (IRIs to Debian/bioconda/bio.tools/RRID/DOIs), letting resolvers (conda, Environment Modules, Galaxy) map names to installs. It even accommodates *rationale-by-reference* (DOIs/RRIDs as specs). But it's per-tool workflow metadata, has no arch-split or capability-advertisement concept, and no resolver targets CRAN/GitHub-R.
- **Seqera Wave / Nextflow / Snakemake / BioContainers / Bioconda `meta.yaml`:** Wave builds containers on-demand from conda specs (and CRAN/R packages, per-arch amd64/arm64) and emits conda lockfiles — highly relevant as a *build* mechanism, but the input is a conda spec, inheriting conda's inability to pin arbitrary R git commits.
- **Posit P3M snapshots / rocker-versioned2:** the R-world reproducibility approach (date-based CRAN snapshots), complementary to renv but not multi-ecosystem.

**SBOM/identity standards.**
- **purl (ECMA-427, 1st ed., approved 2025-12-10):** canonical types exist for every Inflexa source: `pkg:pypi`, `pkg:cran`, `pkg:bioconductor`, `pkg:conda`, `pkg:github`, `pkg:npm`, `pkg:generic`. Viable as the *canonical naming scheme* inside the manifest and in emitted SBOMs.
- **CycloneDX 1.7 (Oct 21, 2025; ECMA-424 2nd ed.) / SPDX 3.x:** SBOM output formats. CycloneDX distinguishes lifecycle phases (`design` = intended vs `build`/`post-build` = resolved) and has pedigree/provenance, so it *can* model intent vs resolution — but it's an output/attestation artifact, not a hand-edited input manifest. Emit it from CI; don't author it by hand.

### B. Capability comparison

| Requirement | Custom YAML | Pixi | Nix/flakes | conda env.yml | renv/pak (R) + pyproject/uv (Py) + env.yml (conda) + package.json (npm) | CWL SoftwareReq | CycloneDX (output) |
|---|---|---|---|---|---|---|---|
| R pkg from Bioconductor @ release-branch git commit | ✅ (`r.git`) | ❌ (needs recipe) | ⚠️ (override, manual) | ❌ | ✅ (`git::git.bioconductor.org/...`) | ❌ | n/a (records resolved) |
| R pkg from GitHub @ tag (`stuart-lab/signac@1.16.0`) | ✅ (`r.github`) | ❌ (needs recipe) | ⚠️ (fetchFromGitHub, manual) | ❌ | ✅ (`github::owner/repo@tag`) | ❌ | records only |
| Per-architecture package sets (amd64-only) | ✅ | ✅ (`target.<arch>`) | ✅ (system) | ⚠️ (selectors) | ✅ (per-file) | ❌ | records only |
| PEP 508 markers/extras (Python) | ✅ (bare strings) | ✅ (`pypi-dependencies`) | ⚠️ | ✅ (`pip:`) | ✅ | ❌ | records only |
| conda/bioconda CLI tools + version pins | ✅ | ✅ | ✅ | ✅ | ✅ (env.yml) | ⚠️ (via specs) | records only |
| npm packages | ✅ | ⚠️ (conda nodejs) | ✅ | ❌ | ✅ (package.json) | ❌ | records only |
| package→binary-name mapping | ✅ (`binaries:`) | ❌ | ⚠️ (wrapper) | ❌ | ❌ | ❌ | ❌ |
| Structured rationale per entry | ⚠️ (comments today) | ❌ | ❌ | ❌ | ❌ | ⚠️ (specs IRIs) | ⚠️ (properties) |
| "Installed but not advertised" distinction | ✅ (by design) | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ (scope) |
| Single document, all four ecosystems | ✅ | ❌ (no R-git, no npm) | ✅ | ❌ | ❌ (four files) | ❌ | ✅ (but output) |

The table's verdict: **only the custom YAML and (in principle) Nix put all four ecosystems in one document, and only the custom YAML carries the binary-map, advertisement, and rationale concerns.** Nix loses on R-git-commit ergonomics, relocatability, and advertisement. Every "standard" that handles the R-from-git requirement (pak/renv) is R-only.

### C. Is the ad-hoc implementation warranted?

**Yes, as an intent/orchestration layer — with caveats.** The established engineering guidance is: adopt a standard when one exists that fits, because standards bring tooling, validation, and interoperability for free; build bespoke only when the standards genuinely don't express your domain. Here, the domain has three properties that no standard captures together:

1. **Cross-ecosystem intent in one file.** The manifest→lockfile two-layer pattern is standardized *within* each ecosystem but there is no cross-ecosystem intent standard. Inflexa's file is a legitimate instance of a recognized *gap*, not a reinvention of an existing wheel.
2. **Capability advertisement.** The `packages.txt`-for-agents role means the list encodes *what to tell the agent exists*, deliberately diverging from the install closure (e.g. biomaRt "installed but not advertised"). No package manager models advertisement vs installation — this is application semantics, not packaging semantics.
3. **The R-from-arbitrary-git-commit requirement** rules out the two closest "one-document" options (Pixi, conda), because only the R-native stack (pak/renv) can express `github::…@tag` and `git::git.bioconductor.org/…@commit`.

Real-world precedent supports a thin custom intent layer over standard lockfiles: this is exactly how renv (DESCRIPTION intent → renv.lock), pixi (pixi.toml → pixi.lock), and npm (package.json → package-lock.json) already work; Inflexa is doing the same one level up, orchestrating four such pairs. The danger is not the existence of the custom file — it is the *implementation choices* inside it.

**Known problems with YAML here, and their fixes:**
- **Comment loss on programmatic round-trip.** Standard YAML libraries drop comments on load/dump. Because rationale lives in `# comments` and is described as "a primary value of the file," any tool that rewrites the file (e.g. an auto-updater) will destroy it. **Fix:** move rationale into structured `reason:`/`rationale:` fields (as `r.git` already does with mandatory `reason`), and/or use comment-preserving `ruamel.yaml` for any programmatic edits.
- **No schema by default.** **Fix:** author a **JSON Schema** and reference it with a `# yaml-language-server: $schema=...` modeline for in-editor validation (Red Hat yaml-language-server) + a CI check (`check-jsonschema`/`check-yamlschema`/`cue vet`).
- **YAML footguns** (the "Norway problem": `no`→false; version strings coerced to floats — note the manifest already quotes `r_version: "4.6.0"`, which is correct). **Fix:** the schema plus quoting conventions; a `.yamllint`/CI gate.
- **Alternatives considered:** TOML (better typing, but weaker for deeply nested structures and comments still non-round-trip), **CUE** (schema *is* the language, `cue vet` validates YAML/JSON, strong for this), **Dhall/Jsonnet/Starlark** (programmable but heavier learning curve). Recommendation: stay in YAML + JSON Schema (lowest migration cost, preserves the file), and only consider CUE if validation needs outgrow JSON Schema.

### D. Concrete recommendations (ranked, with cost)

**Option 1 — Harden the custom manifest (RECOMMENDED, do now; low cost).**
- Add a JSON Schema + `yaml-language-server` modeline; wire `check-jsonschema` (or `cue vet`) into CI.
- Convert inline rationale `# comments` into structured `reason:` fields per entry (extend the `r.git` pattern to all tracks); this preserves the file's primary value against programmatic round-trips and makes rationale queryable.
- Keep the manifest explicitly as the **intent layer** over the existing R lock (gen-r-lock.R) and `uv` lock. **Buys:** validation, editability, rationale durability, keeps advertisement + arch-split + binary-map. **Costs:** schema authoring, one-time comment→field migration. **Breaks:** nothing structural.

**Option 2 — Adopt Pixi for the conda + PyPI tracks; keep R and npm as-is (medium cost, high upside).**
- Move `system_tools` (bioconda) and `python.pip` into a `pixi.toml` with `[target.linux-64.dependencies]`/`[target.linux-aarch64.dependencies]` for the arch splits, gaining a single resolved `pixi.lock` across arches and eliminating the separate micromamba+uv orchestration for those two tracks.
- **Keep R on pak/renv** (pixi can't do R-from-git) and npm trivially separate. **Buys:** unified conda+PyPI resolution, first-class arch splits, `pixi-pack` relocatability, mature tooling (v0.76.1, Aug 2026). **Costs:** learning pixi; R and npm stay separate so it's not "one file." **Breaks:** the "single source of truth" property unless the custom manifest remains the top-level intent layer that generates the pixi.toml.

**Option 3 — Collapse everything into conda-forge/bioconda via one pixi.toml/environment.yml (NOT recommended).**
- Technically `r-*`/`bioconductor-*` exist on conda. **Breaks:** the R-from-GitHub-tag and R-from-git.bioconductor.org-commit requirements (no conda recipe), the package→binary map, rationale, and advertisement. Rejected.

**Option 4 — Adopt Nix/flakes wholesale (NOT recommended).** Covers the ecosystems but: /nix/store non-relocatable to /opt, R lags CRAN, heavy source compiles, no advertisement concept, full rewrite. Rejected for this use case.

**Option 5 — Split per-ecosystem into native standard formats + thin orchestration file (viable long-term).**
- renv.lock/DESCRIPTION (R) + pyproject.toml/uv.lock (Py) + environment.yml/conda-lock (conda) + package.json (npm), with a thin custom top-level file carrying only cross-cutting concerns (base image digest, runtime versions, `warm:`, `binaries:`, advertisement flags, arch routing). **Buys:** each track uses its native, well-tooled standard; the custom file shrinks to genuinely-bespoke concerns. **Costs:** four files + orchestration; loses the single-document convenience. This is the principled end-state if the single file grows unwieldy.

**Option 6 — Emit CycloneDX/SPDX SBOM as an output; adopt purl as canonical IDs (do in parallel with any of the above).**
- Regardless of input format, generate a **CycloneDX** SBOM at image-build time (record resolved components), and consider using **purl** (`pkg:cran/…`, `pkg:pypi/…`, `pkg:conda/…`, `pkg:bioconductor/…`, `pkg:github/…`, `pkg:npm/…`) as the canonical identifier both in the SBOM and, optionally, as the naming scheme inside the manifest. **Buys:** supply-chain provenance, OCI attestation, cross-ecosystem identity. **Costs:** SBOM tooling in CI. **Note:** SBOM is an *output*, not a substitute for the intent manifest.

**Benchmarks that would change the recommendation:**
- If pixi ships native "R package from git/GitHub without a recipe" (watch prefix-dev/pixi issues), Option 2 could expand to absorb R, moving toward a true single `pixi.toml`.
- If the custom file's rationale/validation needs outgrow JSON Schema, migrate the schema to CUE.
- If the number of arch-split or advertisement special-cases keeps growing, move to Option 5.

## Recommendations
1. **Now (days):** Write a JSON Schema for `lib-store-manifest.yaml`, add the `# yaml-language-server: $schema=` modeline, and add a CI validation gate. Convert inline rationale comments to structured `reason:` fields across all tracks. Keep the file as the declared intent layer.
2. **Next (weeks):** Prototype migrating the `system_tools` (bioconda) + `python.pip` tracks to a generated `pixi.toml` with `target.<arch>` splits; benchmark resolve time and image size vs the current micromamba+uv path. Keep R on pak/renv and npm separate.
3. **Parallel:** Emit a CycloneDX SBOM at build time with purl identifiers; publish it as an OCI attestation.
4. **Do not:** collapse R into conda/pixi, or adopt Nix wholesale.
5. **Revisit** when pixi gains recipe-free R-git support, or if the file's special-cases proliferate (then split per-ecosystem per Option 5).

## Caveats
- Tool states move fast: PEP 751 install support in pip is *experimental* as of 26.1 (April 2026); pixi is pre-1.0 (latest v0.76.1, Aug 10, 2026) though the file format is kept backward-compatible. Verify current versions before committing.
- The "R from arbitrary git commit" limitation of pixi/conda is the load-bearing fact behind rejecting full consolidation; if Inflexa's R-git/github entries were dropped or all upstreamed to bioconda, the calculus would shift toward Pixi consolidation.
- conda/pixi prefixes are not freely relocatable; `conda-pack`/`pixi-pack` work with caveats (prefix length must not exceed the original, and one-shot relocation for conda-pack after `conda-unpack`; wheels-only PyPI for pixi-pack). Validate the /opt/conda relocation path against these.
- This analysis extends, and does not re-litigate, the team's PRIOR-ART.md conclusions on Guix/Spack/uv/pak/P3M; it fills the named Nix and Pixi gaps.
