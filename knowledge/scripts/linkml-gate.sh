#!/usr/bin/env bash
# The LinkML gate of the curated tree. It generates the JSON Schema of the
# knowledge model and validates each curated file against it with the LinkML
# validator. The gate runs in CI and on a machine that has LinkML installed.
#
#   bash scripts/linkml-gate.sh [python-with-linkml]
#
# The first argument names a Python interpreter that has the `linkml` package,
# for example the interpreter of a virtual environment. Without it, the gate
# uses the `linkml-validate` and `gen-json-schema` commands on the PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" != "" ]; then
  VALIDATE=("$1" -m linkml.validator.cli)
  GEN=("$1" -m linkml.generators.jsonschemagen)
else
  VALIDATE=(linkml-validate)
  GEN=(gen-json-schema)
fi

SCHEMA=schema/inflexa-knowledge.yaml
OUT=dist/schema
mkdir -p "$OUT"
"${GEN[@]}" "$SCHEMA" > "$OUT/inflexa-knowledge.schema.json" 2>/dev/null
echo "JSON Schema: $OUT/inflexa-knowledge.schema.json"

fail=0
validate() {
  local target="$1" file="$2"
  if ! "${VALIDATE[@]}" -s "$SCHEMA" -C "$target" "$file" >/dev/null 2>"$OUT/.err"; then
    echo "FAIL $file ($target)"; sed -n 1,5p "$OUT/.err"; fail=1
  fi
}
for f in kb/rules/*.yaml; do validate Rule "$f"; done
for f in kb/methods/*.yaml; do validate Method "$f"; done
for f in kb/modalities/*.yaml; do validate Modality "$f"; done
for f in kb/templates/*/template.yaml; do validate Template "$f"; done
# A list file validates as the tree root with the list under its key.
for f in kb/sources/*.yaml; do
  python3 - "$f" > "$OUT/.wrapped.yaml" <<'EOF'
import sys, yaml
print(yaml.safe_dump({"sources": yaml.safe_load(open(sys.argv[1]))}, sort_keys=False))
EOF
  validate KnowledgeBase "$OUT/.wrapped.yaml"
done
for f in kb/vocab/*.yaml; do
  python3 - "$f" > "$OUT/.wrapped.yaml" <<'EOF'
import sys, yaml
print(yaml.safe_dump({"terms": yaml.safe_load(open(sys.argv[1]))}, sort_keys=False))
EOF
  validate KnowledgeBase "$OUT/.wrapped.yaml"
done
rm -f "$OUT/.err" "$OUT/.wrapped.yaml"
if [ "$fail" -ne 0 ]; then echo "linkml gate failed"; exit 1; fi
echo "linkml gate passed"
