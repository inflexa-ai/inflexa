#!/bin/zsh
# usage: arms.zsh <label> <concurrency> [run flags...]   Runs the three arms on all domain cases, one report each.
set -a; . ./.env.local; set +a
label=$1; conc=$2; shift 2
ALL=(${(f)"$(grep -o 'id: "domain-[^"]*"' cases/domain.ts | cut -d'"' -f2)"})
args=(); for c in $ALL; do args+=(--case $c); done
for arm in A stance one; do
  flag=(); [[ $arm != A ]] && flag=(--sandbox-arm $arm)
  bun run evals run $args $flag "$@" --exec docker --trials 2 --concurrency $conc \
    --out ../tmp/claude/specialists/runs/p1-$label-$arm.json 2>&1 | tee ../tmp/claude/specialists/runs/p1-$label-$arm.log
done
