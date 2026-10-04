#!/usr/bin/env python3
"""Write the CycloneDX SBOM of an image, from inside the build of that image.

The script runs as the last file write of an image build. Syft scans the root
file system of the build, and the script then completes the result:

- It gives a purl to each conda package, because Syft gives none.
- It merges the copies of one package, for example the four copies of the uv
  crates in two uv binaries and their two install paths.
- It drops a binary match that a package manager already records.
- It resolves each license that Syft leaves empty or leaves as a text hash.
  The sources are the license files in the image, the owner package, and the
  crates.io API for the Rust crates.
- It adds the components that no package manager records, from the extra
  file of the image.

Then it does the gate. The gate fails the build when a component has no
resolved license, when an extra component is not in the image, or when the
image record names a package that the SBOM does not hold.

The script uses the standard library only, because it runs in the system
python3 of the image.
"""
import argparse
import glob
import http.client
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sbom_common as common  # noqa: E402

# The paths that Syft must not scan. They are build mounts and empty mount
# points, not content of the image.
EXCLUDES = ["./proc/**", "./sys/**", "./dev/**", "./tmp/**", "./run/**", "./mnt/**", "./var/cache/inflexa-sbom/**"]

CRATES_API = "https://crates.io/api/v1/crates"
USER_AGENT = "inflexa-sbom (+https://github.com/inflexa-ai/inflexa)"

# The crates.io crawler policy permits one request each second.
CRATES_INTERVAL_S = 1.0

# The image record names a runtime. Each runtime maps to the component that
# holds it.
RUNTIME_COMPONENTS = {"python": "python3.12", "node": "nodejs", "r": "R"}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--syft", required=True, help="the path of the syft binary")
    parser.add_argument("--extra", required=True, help="the extra components of the image (JSON)")
    parser.add_argument("--name", required=True, help="the image repository, for example ghcr.io/inflexa-ai/sandbox-base")
    parser.add_argument("--version", required=True, help="the image version (the IMAGE_VERSION build arg)")
    parser.add_argument("--arch", required=True, help="the TARGETARCH build arg")
    parser.add_argument("--record", help="the image record; when given, the gate compares the SBOM against it")
    parser.add_argument("--cache", default="/var/cache/inflexa-sbom", help="the cache directory of the crates.io answers")
    parser.add_argument("--out", required=True, help="the output path")
    return parser.parse_args()


def log(message: str) -> None:
    print(f"image-sbom: {message}", file=sys.stderr, flush=True)


def run_syft(syft: str, name: str, version: str, cache: str) -> dict:
    with tempfile.NamedTemporaryFile(suffix=".cdx.json", delete=False) as handle:
        raw = handle.name
    command = [
        syft, "scan", "dir:/",
        "--override-default-catalogers", "image",
        "--select-catalogers", "+conda-meta-cataloger",
        "--select-catalogers", "-file",
        # Syft reads the license of a Go module from the Go module proxy.
        "--enrich", "golang",
        "--source-name", name,
        "--source-version", version,
        "-o", f"cyclonedx-json@{common.SPEC_VERSION}={raw}",
        "-q",
    ]
    for pattern in EXCLUDES:
        command += ["--exclude", pattern]
    # Syft writes a cache (the Go module answers of --enrich) below its home.
    # The build runs as root with the HOME of the image, thus a default cache
    # makes a root-owned ~/.cache in a layer of the image, and the sandbox
    # user can then not write there. Each path of Syft goes to the cache mount
    # instead, which no layer holds.
    home = Path(cache) / "syft-home"
    for sub in ("cache", "config"):
        (home / sub).mkdir(parents=True, exist_ok=True)
    env = dict(
        os.environ,
        SYFT_CHECK_FOR_APP_UPDATE="false",
        HOME=str(home),
        XDG_CACHE_HOME=str(home / "cache"),
        XDG_CONFIG_HOME=str(home / "config"),
        SYFT_CACHE_DIR=str(home / "cache" / "syft"),
    )
    subprocess.run(command, check=True, env=env)
    with open(raw) as f:
        document = json.load(f)
    os.unlink(raw)
    return document


def prop(component: dict, name: str) -> str | None:
    for entry in component.get("properties", []):
        if entry.get("name") == name:
            return entry.get("value")
    return None


def locations(component: dict) -> list[str]:
    return ["/" + p["value"].lstrip("/") for p in component.get("properties", []) if p.get("name", "").startswith("syft:location:") and p["name"].endswith(":path")]


def dpkg_owners() -> dict:
    """The owner package of each dpkg file."""
    owners: dict[str, str] = {}
    for listing in glob.glob("/var/lib/dpkg/info/*.list"):
        package = os.path.basename(listing)[: -len(".list")].split(":")[0]
        try:
            with open(listing, errors="replace") as f:
                paths = [line.rstrip("\n") for line in f if line.strip()]
        except OSError:
            continue
        for path in paths:
            owners.setdefault(path, package)
    return owners


def conda_records(prefix: str = "/opt/conda") -> tuple[dict, dict]:
    """The conda-meta record of each conda package, and the owner record of each conda file."""
    records: dict[tuple[str, str], dict] = {}
    owners: dict[str, dict] = {}
    for meta in glob.glob(f"{prefix}/conda-meta/*.json"):
        try:
            with open(meta) as f:
                record = json.load(f)
        except (OSError, ValueError):
            continue
        records[(record.get("name"), record.get("version"))] = record
        for path in record.get("files", []):
            owners[f"{prefix}/{path}"] = record
    return records, owners


def conda_purl(record: dict) -> str:
    channel = (record.get("channel") or "").rstrip("/")
    subdir = record.get("subdir") or ""
    if subdir and channel.endswith("/" + subdir):
        channel = channel[: -len(subdir) - 1]
    channel = channel.rsplit("/", 1)[-1]
    qualifiers = {"build": record.get("build"), "channel": channel, "subdir": subdir}
    return f"pkg:conda/{record['name']}@{record['version']}{common.purl_qualifiers(qualifiers)}"


def merge_copies(document: dict) -> None:
    """Merge the components that share one purl, and point each reference at the kept copy."""
    kept: dict[str, dict] = {}
    alias: dict[str, str] = {}
    result = []
    for component in document.get("components", []):
        purl = component.get("purl")
        if not purl or purl not in kept:
            if purl:
                kept[purl] = component
            result.append(component)
            continue
        first = kept[purl]
        alias[component["bom-ref"]] = first["bom-ref"]
        if not first.get("licenses") and component.get("licenses"):
            first["licenses"] = component["licenses"]
        index = len(locations(first))
        for path in locations(component):
            if path not in locations(first):
                first.setdefault("properties", []).append({"name": f"syft:location:{index}:path", "value": path.lstrip("/")})
                index += 1
    document["components"] = result
    rewrite_refs(document, alias, set())


def rewrite_refs(document: dict, alias: dict, dropped: set) -> None:
    """Point each dependency at its kept copy, and remove each dropped component from the graph."""
    merged: dict[str, set] = {}
    for dependency in document.get("dependencies", []):
        ref = alias.get(dependency["ref"], dependency["ref"])
        if ref in dropped:
            continue
        targets = merged.setdefault(ref, set())
        for target in dependency.get("dependsOn", []):
            target = alias.get(target, target)
            if target not in dropped and target != ref:
                targets.add(target)
    document["dependencies"] = [{"ref": ref, "dependsOn": sorted(targets)} for ref, targets in sorted(merged.items())]


def crate_license(name: str, version: str, cache: Path, state: dict) -> str | None:
    """The SPDX expression that crates.io declares for one crate version."""
    cached = cache / "crates" / f"{name}-{version}.json"
    if cached.is_file():
        try:
            return json.loads(cached.read_text()).get("license")
        except ValueError:
            pass
    wait = state.get("next", 0.0) - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    request = urllib.request.Request(f"{CRATES_API}/{name}/{version}", headers={"User-Agent": USER_AGENT})
    for attempt in range(5):
        state["next"] = time.monotonic() + CRATES_INTERVAL_S
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = json.load(response)
            break
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
        except (http.client.HTTPException, OSError, ValueError):
            # urllib wraps only the connection errors in URLError (an OSError).
            # A dropped keep-alive, a slow read, or a cut body comes from
            # http.client or from the JSON decoder unwrapped, and each one is
            # transient.
            if attempt == 4:
                raise
        time.sleep(2 ** attempt)
    license_value = (body.get("version") or {}).get("license")
    if license_value:
        # A legacy crate separates its alternatives with a slash.
        license_value = " OR ".join(part.strip() for part in license_value.split("/"))
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps({"license": license_value}))
    return license_value


def resolve_licenses(document: dict, args, dpkg_owner: dict, conda_owner: dict) -> None:
    by_purl_name = {}
    for component in document["components"]:
        if prop(component, "syft:package:type") == "deb":
            by_purl_name[component["name"]] = component
    crate_state: dict = {}
    crate_count = 0
    pending: list[dict] = []
    for component in document["components"]:
        licenses = component.get("licenses") or []
        kind = prop(component, "syft:package:type")
        paths = locations(component)
        # A bare declared name (with no SPDX id and no text) is resolved, but a Debian short name such as
        # "permissive" or "custom" means something only beside the copyright file. Thus a Debian package,
        # an R package, and a Python distribution with a bare name go through their own resolver too.
        bare = any(common.bare_name(entry) for entry in licenses)
        if common.licenses_resolved(licenses) and not (bare and kind in ("deb", "R-package", "python")):
            continue

        if kind == "deb":
            # Syft names a license text that it cannot identify by its hash, and it keeps the short
            # names of the copyright file. The copyright file of the package holds each of those texts.
            kept = []
            for entry in licenses:
                if not common.entry_resolved(entry):
                    continue
                if (entry.get("license") or {}).get("name") == "Expat":
                    entry = {"license": {"id": "MIT"}}
                kept.append(entry)
            text = common.read_text(Path(f"/usr/share/doc/{component['name']}/copyright"))
            if text and (not kept or len(kept) < len(licenses) or any(common.bare_name(entry) for entry in kept)):
                kept.append(common.text_license(f"Text of /usr/share/doc/{component['name']}/copyright", text))
            component["licenses"] = kept
            continue

        if kind == "R-package" and paths:
            description = Path(paths[0])
            fields = common.parse_metadata(description)
            derived = common.r_licenses((fields.get("license") or [""])[0], description.parent)
            if common.licenses_resolved(derived):
                component["licenses"] = derived
            continue

        if kind == "rust-crate":
            expression = crate_license(component["name"], component["version"], Path(args.cache), crate_state)
            crate_count += 1
            if crate_count % 50 == 0:
                log(f"crates.io: {crate_count} crates resolved")
            if expression:
                component["licenses"] = [{"expression": expression}]
            continue

        if kind == "python" and paths:
            found = common.python_licenses(Path(paths[0]))
            if common.licenses_resolved(found):
                component["licenses"] = found
                continue
            if common.licenses_resolved(licenses):
                continue

        pending.append(component)

    # A file that a dpkg package or a conda package owns comes under the
    # license of its owner. This pass runs last, thus each owner already
    # carries its resolved licenses and its copyright text.
    for component in pending:
        for path in locations(component):
            owner = dpkg_owner.get(path)
            if owner and owner in by_purl_name and common.licenses_resolved(by_purl_name[owner].get("licenses")):
                component["licenses"] = by_purl_name[owner]["licenses"]
                component.setdefault("properties", []).append({"name": "inflexa:license-from", "value": by_purl_name[owner].get("purl", owner)})
                break
            record = conda_owner.get(path)
            if record and record.get("license"):
                component["licenses"] = [{"license": {"name": record["license"]}}]
                component.setdefault("properties", []).append({"name": "inflexa:license-from", "value": conda_purl(record)})
                break


def expand(value, args, record: dict):
    """Fill the placeholders of an extra component: {env:NAME}, {runtime:NAME}, and {image}."""
    if isinstance(value, list):
        return [expand(item, args, record) for item in value]
    if isinstance(value, dict):
        return {key: expand(item, args, record) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    out = value.replace("{image}", args.version)
    while "{env:" in out:
        start = out.index("{env:")
        end = out.index("}", start)
        out = out[:start] + os.environ.get(out[start + 5 : end], "") + out[end + 1 :]
    while "{runtime:" in out:
        start = out.index("{runtime:")
        end = out.index("}", start)
        out = out[:start] + (record.get("runtimes") or {}).get(out[start + 9 : end], "") + out[end + 1 :]
    return out


def add_extras(document: dict, args, record: dict, failures: list) -> None:
    with open(args.extra) as f:
        extras = json.load(f)["components"]
    components = document["components"]
    for raw in extras:
        extra = expand(raw, args, record)
        path = extra.pop("path", None)
        match = extra.pop("match", None)
        if path and not glob.glob(path):
            failures.append(f"the extra component {extra['name']} names {path}, and the image holds no such path")
            continue
        if extra.get("supplier") == "inflexa":
            extra["supplier"] = common.SUPPLIER
        if match:
            hits = [c for c in components if (c.get("purl") or "").split("@")[0] == match]
            if not hits:
                failures.append(f"the extra patch {match} matches no component of the scan")
            for hit in hits:
                hit.update({key: value for key, value in extra.items() if key not in ("type",)})
                if extra.get("version"):
                    hit["purl"] = f"{match}@{extra['version']}"
            continue
        if not extra.get("version"):
            failures.append(f"the extra component {extra['name']} has no version")
            continue
        extra.setdefault("type", "application")
        extra["bom-ref"] = f"inflexa-extra:{extra['name']}@{extra['version']}"
        if path:
            extra["properties"] = [{"name": "inflexa:location", "value": path}]
        components.append(extra)


def drop_owned_binaries(document: dict, dpkg_owner: dict, conda_owner: dict) -> None:
    """Drop a binary match that a package manager records already: the owner package lists it."""
    dropped = set()
    kept = []
    for component in document["components"]:
        found_by = prop(component, "syft:package:foundBy") or ""
        if found_by in ("binary-classifier-cataloger", "elf-binary-package-cataloger"):
            paths = locations(component)
            if paths and all(p in dpkg_owner or p in conda_owner for p in paths):
                dropped.add(component["bom-ref"])
                continue
        kept.append(component)
    document["components"] = kept
    rewrite_refs(document, {}, dropped)


def check_record(document: dict, record: dict, failures: list) -> None:
    """Compare the SBOM against the image record: each recorded package must be in the SBOM."""
    held = {(c.get("name"), c.get("version")) for c in document["components"]}
    names = {}
    for c in document["components"]:
        names.setdefault(c.get("name"), []).append(c.get("version") or "")
    for entry in record.get("system_tools", []):
        if (entry["name"], entry["version"]) not in held:
            failures.append(f"the conda tool {entry['name']} {entry['version']} of the image record is not in the SBOM")
    for entry in record.get("node", []):
        if (entry["name"], entry["version"]) not in held:
            failures.append(f"the node package {entry['name']} {entry['version']} of the image record is not in the SBOM")
    for runtime, version in (record.get("runtimes") or {}).items():
        component = RUNTIME_COMPONENTS.get(runtime)
        if component is None or not any(v.startswith(version) for v in names.get(component, [])):
            failures.append(f"the runtime {runtime} {version} of the image record is not in the SBOM")


def main() -> int:
    args = parse_args()
    record = {}
    if args.record:
        with open(args.record) as f:
            record = json.load(f)

    log("scanning the image file system with syft")
    document = run_syft(args.syft, args.name, f"{args.version}-{args.arch}", args.cache)

    dpkg_owner = dpkg_owners()
    conda_by_id, conda_owner = conda_records()
    for component in document.get("components", []):
        if prop(component, "syft:package:type") == "conda" and not component.get("purl"):
            conda_record = conda_by_id.get((component.get("name"), component.get("version")))
            if conda_record:
                component["purl"] = conda_purl(conda_record)

    merge_copies(document)
    drop_owned_binaries(document, dpkg_owner, conda_owner)

    failures: list[str] = []
    add_extras(document, args, record, failures)
    resolve_licenses(document, args, dpkg_owner, conda_owner)

    for component in document["components"]:
        if component.get("type") == "operating-system":
            # The base system is a set of dpkg packages, and the SBOM lists
            # each one with its own license. The system entry names the
            # distribution only.
            continue
        if not common.licenses_resolved(component.get("licenses")):
            where = ", ".join(locations(component)[:2]) or "no location"
            failures.append(f"no resolved license: {component.get('purl') or component.get('name')} ({where})")
    if record:
        check_record(document, record, failures)

    if failures:
        for failure in failures:
            log(f"FAIL {failure}")
        log(f"{len(failures)} gate failures; the SBOM is not written")
        return 1

    metadata = document.setdefault("metadata", {})
    # The dependency graph of Syft refers to the subject by its reference, thus
    # the new subject keeps that reference.
    subject_ref = (metadata.get("component") or {}).get("bom-ref") or f"{args.name}:{args.version}-{args.arch}"
    metadata["component"] = {
        "bom-ref": subject_ref,
        "type": "container",
        "name": args.name,
        "version": f"{args.version}-{args.arch}",
        "supplier": common.SUPPLIER,
        "licenses": [{"license": {"id": "Apache-2.0"}}],
        "properties": [{"name": "inflexa:arch", "value": args.arch}],
    }
    metadata["supplier"] = common.SUPPLIER
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    common.write_document(document, Path(args.out))
    log(f"wrote {args.out}: {len(document['components'])} components, each with a resolved license")
    return 0


if __name__ == "__main__":
    sys.exit(main())
