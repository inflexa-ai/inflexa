"""
04_build_reproducibility_record.py

Assemble a single reproducibility record for the integrated report from the
three upstream steps' decision records / session info files. Does not rerun
anything -- this only consolidates what each step already persisted.

Inputs:
  T1S1/output/{session_info.txt, decision_record.json}
  T1S2/output/{session_info.txt, decision_record.json, deseq2_summary.json}
  T2S1/output/{session_info.txt, decision_record.json,
               gene_id_mapping_summary.json, hallmark_summary.json,
               reactome_summary.json, reactome_gmt_prep_summary.json}

Output:
  output/reproducibility_record.json
  output/reproducibility_record.md
"""

import json
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

RUN_ROOT = Path("/eval-e2e-smoke-with-two-group-n6-enrich-s1-1/runs/619852b4-1723-48f1-b3fe-f19dbee5d2d9")
OUTPUT_DIR = Path("output")


def read_text(path: Path) -> str:
    return path.read_text()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def build_record() -> dict:
    t1s1_decision = read_json(RUN_ROOT / "T1S1/output/decision_record.json")
    t1s2_decision = read_json(RUN_ROOT / "T1S2/output/decision_record.json")
    t1s2_summary = read_json(RUN_ROOT / "T1S2/output/deseq2_summary.json")
    t2s1_decision = read_json(RUN_ROOT / "T2S1/output/decision_record.json")
    gene_map_summary = read_json(RUN_ROOT / "T2S1/output/gene_id_mapping_summary.json")
    hallmark_summary = read_json(RUN_ROOT / "T2S1/output/hallmark_summary.json")
    reactome_summary = read_json(RUN_ROOT / "T2S1/output/reactome_summary.json")
    reactome_gmt_prep = read_json(RUN_ROOT / "T2S1/output/reactome_gmt_prep_summary.json")

    record = {
        "run_id": "619852b4-1723-48f1-b3fe-f19dbee5d2d9",
        "steps": {
            "T1S1_qc_eda": {
                "template": f"{t1s1_decision['template']['id']}@{t1s1_decision['template']['version']}",
                "snapshot": t1s1_decision["snapshot"]["digest"],
                "environment_match": t1s1_decision["environment"]["match"],
                "pins": t1s1_decision["environment"]["pins"],
            },
            "T1S2_deseq2": {
                "template": f"{t1s2_decision['template']['id']}@{t1s2_decision['template']['version']}",
                "snapshot": t1s2_decision["snapshot"]["digest"],
                "environment_match": t1s2_decision["environment"]["match"],
                "pins": t1s2_decision["environment"]["pins"],
                "design_formula": t1s2_summary["design_formula"],
                "reference_level": t1s2_summary["reference_level"],
                "contrast": t1s2_summary["contrast"],
                "alpha": t1s2_summary["alpha"],
                "lfc_shrink_method": t1s2_summary["lfc_shrink"],
                "random_seed": "not set/reported by tpl-deseq2-two-group@1.0.0 (Wald test + apeglm shrinkage "
                "are deterministic given the count matrix; no stochastic step requiring a seed)",
            },
            "T2S1_fgsea_hallmark": {
                "template": f"{t2s1_decision['template']['id']}@{t2s1_decision['template']['version']} "
                "(rendered separately per collection; this record reflects the last (Reactome) render's slots "
                "per T2S1's own summary -- Hallmark render used identical pins, differing only in gmt_path/output_prefix)",
                "snapshot": t2s1_decision["snapshot"]["digest"],
                "environment_match": t2s1_decision["environment"]["match"],
                "pins": t2s1_decision["environment"]["pins"],
                "database": "MSigDB Hallmark human, 2026.1 (h.all.v2026.1.Hs.symbols.gmt)",
                "ranking_metric": hallmark_summary["rank_metric"],
                "min_size": hallmark_summary["min_size"],
                "max_size": hallmark_summary["max_size"],
                "random_seed": hallmark_summary["seed"],
            },
            "T2S1_fgsea_reactome": {
                "database": reactome_gmt_prep["release"],
                "source_gmt": reactome_gmt_prep["source_gmt"],
                "n_pathways_raw": reactome_gmt_prep["n_pathways_raw_gmt"],
                "n_pathways_after_human_filter": reactome_gmt_prep["n_pathways_kept"],
                "ranking_metric": reactome_summary["rank_metric"],
                "min_size": reactome_summary["min_size"],
                "max_size": reactome_summary["max_size"],
                "random_seed": reactome_summary["seed"],
            },
            "T2S1_gene_id_mapping_qc": {
                "mapping_source": gene_map_summary["mapping_source"],
                "org_hs_eg_db_version": gene_map_summary["org_hs_eg_db_version"],
                "note": gene_map_summary["note"],
            },
        },
        "session_info_raw": {
            "T1S1": read_text(RUN_ROOT / "T1S1/output/session_info.txt"),
            "T1S2": read_text(RUN_ROOT / "T1S2/output/session_info.txt"),
            "T2S1": read_text(RUN_ROOT / "T2S1/output/session_info.txt"),
        },
    }
    return record


def render_markdown(record: dict) -> str:
    lines = ["# Reproducibility record", ""]
    lines.append(f"Run ID: `{record['run_id']}`")
    lines.append("")
    lines.append("## Step-by-step environment and parameters")
    for step_name, step in record["steps"].items():
        lines.append(f"### {step_name}")
        for key, value in step.items():
            if key == "pins":
                lines.append("- Package pins (all `status: exact` match to farm environment):")
                for pin in value:
                    lines.append(f"  - {pin['name']} {pin['version']} ({pin['track']})")
            else:
                lines.append(f"- **{key}**: {value}")
        lines.append("")
    lines.append("## Raw R session info per step")
    for step, info in record["session_info_raw"].items():
        lines.append(f"### {step}")
        lines.append("```")
        lines.append(info.strip())
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    record = build_record()
    (OUTPUT_DIR / "reproducibility_record.json").write_text(json.dumps(record, indent=2))
    (OUTPUT_DIR / "reproducibility_record.md").write_text(render_markdown(record))
    logger.info("Wrote reproducibility_record.json and .md")


if __name__ == "__main__":
    main()
