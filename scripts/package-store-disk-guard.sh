#!/usr/bin/env bash
# The disk guard of the self-hosted builders.
#
# Docker's data root sits on a persistent volume that survives every run, and
# no process outside the workflows reclaims it. The workflows remove their own
# objects at the end of a run, but three things escape that: a canceled run
# keeps its store volume, because the cleanup meets a container that still
# holds the volume; a retired image tag stays forever, because `docker image
# prune` without `-a` removes dangling images only; and the BuildKit cache
# grows with every image build, because nothing prunes it. On 2026-09-05 the
# amd64 box held 155 GB of such content on a 196 GB volume, and the store
# build died on ENOSPC in the R github stage, hours in.
#
# The guard runs before a build. It removes what no run owns, prunes the build
# cache to a cap, then measures the FILESYSTEM of the data root: overlay
# leftovers count on disk and in no row of `docker system df`. A box below the
# headroom fails the job here, in seconds, with the numbers.
#
# Usage: package-store-disk-guard.sh [<volume to keep>]
#   NEED_GB     the free space the job needs, in GB (default 60)
#   KEEP_CACHE  the build cache to keep; the least recently used entries go
#               first (default 25GB)
set -euo pipefail

keep_volume="${1:-}"
need_gb="${NEED_GB:-60}"
keep_cache="${KEEP_CACHE:-25GB}"

root="$(docker info --format '{{.DockerRootDir}}')"
free_gb() { df -BG --output=avail "$root" | tail -n 1 | tr -dc '0-9'; }

before="$(free_gb)"

docker container prune -f >/dev/null

# The `name` filter matches a substring, thus every run's store volume answers.
for volume in $(docker volume ls -q --filter 'name=package-store-'); do
  if [ "$volume" = "$keep_volume" ]; then continue; fi
  # A container of a canceled run can still hold the volume; the volume
  # cannot go before that container does.
  docker ps -aq --filter "volume=$volume" | xargs -r docker rm -f >/dev/null
  if docker volume rm "$volume" >/dev/null; then
    echo "disk guard: removed the stale volume $volume"
  fi
done

# Every image that nothing uses. A run pulls or builds its own images, thus a
# cached tag saves nothing that the build cache below does not save better.
docker image prune -a -f >/dev/null
docker builder prune -f --keep-storage "$keep_cache" >/dev/null

after="$(free_gb)"
echo "disk guard: ${root} had ${before} GB free, has ${after} GB free after the reclaim, and the job needs ${need_gb} GB"
if [ "$after" -lt "$need_gb" ]; then
  echo "::error::the builder has ${after} GB free on ${root}, and the job needs ${need_gb} GB; inspect with: docker system df; du -sh ${root}/*"
  exit 1
fi
