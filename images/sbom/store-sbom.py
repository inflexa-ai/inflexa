#!/usr/bin/env python3
"""Write the CycloneDX SBOM of the package store, from inside the store build.

The store root holds the pool (`store/`), the farms, and the dependency graph
(`deps.json`). Each pool directory holds one installed distribution: an R
package with its DESCRIPTION, or a Python distribution with its METADATA. The
script reads each pool directory, thus the SBOM lists every distribution that
the published artifact carries, and not only the packages that a farm links.

The origin of an R package comes from its DESCRIPTION and not from the farm
track: a CRAN dependency of a Bioconductor package installs on the
Bioconductor track. The `Remote*` fields that pak writes name the source.

The gate fails the build when a pool directory holds no readable package,
when a farm lock entry names a pool directory that the SBOM does not hold, or
when a component has no resolved license.

The document is deterministic: the serial number comes from the content, and
the document carries no timestamp. Thus the base layer of a rebuild with the
same content keeps its digest.

The script uses the standard library only, because it runs in the system
python3 of the provisioner image.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sbom_common as common  # noqa: E402

PIN_MARKER = ".inflexa-pin"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default="/mnt/libs", help="the store root")
    parser.add_argument("--farm", default="catalog", help="the farm whose lock the gate compares")
    parser.add_argument("--name", default="ghcr.io/inflexa-ai/package-store", help="the artifact repository")
    parser.add_argument("--version", required=True, help="the store version")
    parser.add_argument("--arch", required=True, help="the store arch")
    parser.add_argument("--out", required=True, help="the output path")
    return parser.parse_args()


def log(message: str) -> None:
    print(f"store-sbom: {message}", file=sys.stderr, flush=True)


def r_component(store_dir: Path) -> dict | None:
    """The component of one R pool directory, from the DESCRIPTION of its package."""
    package_dir = next((p for p in sorted(store_dir.iterdir()) if p.is_dir() and (p / "DESCRIPTION").is_file()), None)
    if package_dir is None:
        return None
    fields = {key: values[0] for key, values in common.parse_metadata(package_dir / "DESCRIPTION").items()}
    name = fields.get("package")
    version = fields.get("version")
    if not name or not version:
        return None
    remote = (fields.get("remotetype") or "").lower()
    repository = fields.get("repository") or ""
    properties = [{"name": "inflexa:store-dir", "value": store_dir.name}]
    if remote == "github" and fields.get("remoteusername") and fields.get("remoterepo"):
        owner = fields["remoteusername"].lower()
        repo = fields["remoterepo"].lower()
        ref = fields.get("remotesha") or version
        purl = f"pkg:github/{owner}/{repo}@{ref}"
        origin = "github"
    elif remote in ("git", "git2r") and fields.get("remoteurl"):
        ref = fields.get("remotesha") or version
        purl = f"pkg:generic/{name}@{version}" + common.purl_qualifiers({"vcs_url": f"git+{fields['remoteurl']}@{ref}"})
        origin = "git"
    elif repository.lower().startswith("bioconductor") or fields.get("biocviews"):
        # No purl type names Bioconductor. The cran type with the repository
        # URL of the release names the package and its repository.
        repo_url = fields.get("remoterepos") or "https://bioconductor.org"
        purl = f"pkg:cran/{name}@{version}" + common.purl_qualifiers({"repository_url": repo_url})
        origin = "bioconductor"
    else:
        purl = f"pkg:cran/{name}@{version}"
        origin = "cran"
    properties.append({"name": "inflexa:origin", "value": origin})
    component = {
        "bom-ref": store_dir.name,
        "type": "library",
        "name": name,
        "version": version,
        "purl": purl,
        "licenses": common.r_licenses(fields.get("license"), package_dir),
        "properties": properties,
    }
    if fields.get("author") or fields.get("maintainer"):
        component["author"] = " ".join((fields.get("maintainer") or fields.get("author") or "").split())[:500]
    return component


def python_component(store_dir: Path) -> dict | None:
    """The component of one Python pool directory, from the METADATA of its distribution."""
    metadata = next(iter(sorted(store_dir.glob("*.dist-info/METADATA"))), None)
    if metadata is None:
        return None
    fields = common.parse_metadata(metadata)
    name = (fields.get("name") or [""])[0]
    version = (fields.get("version") or [""])[0]
    if not name or not version:
        return None
    normalized = "-".join(name.lower().replace("_", "-").replace(".", "-").split("-"))
    return {
        "bom-ref": store_dir.name,
        "type": "library",
        "name": name,
        "version": version,
        "purl": f"pkg:pypi/{normalized}@{version}",
        "licenses": common.python_licenses(metadata),
        "properties": [
            {"name": "inflexa:store-dir", "value": store_dir.name},
            {"name": "inflexa:origin", "value": "pypi"},
        ],
    }


def main() -> int:
    args = parse_args()
    root = Path(args.root)
    pool = root / "store"
    failures: list[str] = []

    components = []
    by_dir: dict[str, dict] = {}
    for store_dir in sorted(p for p in pool.iterdir() if p.is_dir() and not p.name.startswith(".")):
        if (store_dir / PIN_MARKER).is_file():
            component = python_component(store_dir)
        else:
            component = r_component(store_dir)
        if component is None:
            failures.append(f"the pool directory {store_dir.name} holds no readable package")
            continue
        if not common.licenses_resolved(component.get("licenses")):
            failures.append(f"no resolved license: {component['purl']} ({store_dir.name})")
        components.append(component)
        by_dir[store_dir.name] = component

    lock_path = root / "farms" / args.farm / "inflexa.lock"
    if lock_path.is_file():
        lock = json.loads(lock_path.read_text())
        for entry in lock.get("packages", []):
            if entry.get("store_dir") not in by_dir:
                failures.append(f"the farm lock entry {entry.get('name')} {entry.get('version')} names {entry.get('store_dir')}, and the SBOM does not hold it")
    else:
        failures.append(f"the farm lock {lock_path} is absent")

    if failures:
        for failure in failures:
            log(f"FAIL {failure}")
        log(f"{len(failures)} gate failures; the SBOM is not written")
        return 1

    dependencies = []
    graph_path = root / "deps.json"
    if graph_path.is_file():
        nodes = json.loads(graph_path.read_text()).get("nodes", {})
        for ref in sorted(by_dir):
            edges = sorted(edge for edge in (nodes.get(ref) or {}).get("edges", []) if edge in by_dir)
            dependencies.append({"ref": ref, "dependsOn": edges})

    subject_ref = f"{args.name}:{args.version}-{args.arch}"
    dependencies.append({"ref": subject_ref, "dependsOn": sorted(by_dir)})
    document = {
        "bomFormat": "CycloneDX",
        "specVersion": common.SPEC_VERSION,
        "version": 1,
        "metadata": {
            "component": {
                "bom-ref": subject_ref,
                "type": "platform",
                "name": args.name,
                "version": f"{args.version}-{args.arch}",
                "description": "The Inflexa package store: the R and Python distributions that an analysis farm links",
                "supplier": common.SUPPLIER,
                "properties": [{"name": "inflexa:arch", "value": args.arch}],
            },
            "supplier": common.SUPPLIER,
            "tools": {"components": [{"type": "application", "name": "store-sbom.py", "supplier": common.SUPPLIER}]},
        },
        "components": components,
        "dependencies": dependencies,
    }
    document["serialNumber"] = common.deterministic_serial(document)
    common.write_document(document, Path(args.out))
    log(f"wrote {args.out}: {len(components)} components, each with a resolved license")
    return 0


if __name__ == "__main__":
    sys.exit(main())
