#!/usr/bin/env bash
# Build the library store locally, pack per-track tarballs, and assemble them
# into the host lib-store dir (default: $XDG_DATA_HOME/inflexa/libs,
# i.e. ~/.local/share/inflexa/libs).
#
# The CI build publishes per-track, content-addressed tarballs to object
# storage; this script reproduces the same multi-stage Docker build on your own
# machine, packs the same per-track tarballs, and assembles them into a host
# directory a sandbox can mount read-only at /mnt/libs.
#
# Usage:
#   ./scripts/build-libs-local.sh                            # Build + assemble all tracks
#   ./scripts/build-libs-local.sh --python-only              # Python track only
#   ./scripts/build-libs-local.sh --r-only                   # R tracks only (CRAN + Bioc + GitHub)
#   ./scripts/build-libs-local.sh --tools-only               # System tools (conda) only
#   ./scripts/build-libs-local.sh --node-only                # Node track only
#   ./scripts/build-libs-local.sh --resume                   # Skip tracks with existing images
#   ./scripts/build-libs-local.sh --platform linux/amd64     # Force amd64 (default: native)
#   ./scripts/build-libs-local.sh --dest /path/to/libs       # Custom output dir
#
# After building, run scripts/lib-store-validate/run.sh (or the back-compat
# scripts/smoke-test-libs.sh) to validate the assembled store.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/lib-store-common.sh
source "$SCRIPT_DIR/lib-store-common.sh"

DEST="${INFLEXA_LIB_STORE:-${XDG_DATA_HOME:-$HOME/.local/share}/inflexa/libs}"
BUILD_CONTEXT="$PROJECT_ROOT/images/lib-store-builder"
DOCKERFILE="$BUILD_CONTEXT/Dockerfile"
MANIFEST="$BUILD_CONTEXT/lib-store-manifest.yaml"
PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')"
VERSION="local-$(date +%Y%m%d-%H%M%S)"

# Track image names (matching CI)
IMG_CRAN="lib-store-cran"
IMG_BIOC="lib-store-bioc"
IMG_GITHUB="lib-store-github"
IMG_PYTHON="lib-store-python"
IMG_TOOLS="lib-store-tools"
IMG_NODE="lib-store-node"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${GREEN}[INFO]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$1"; }
step()  { printf "\n${CYAN}--- %s ---${NC}\n" "$1"; }

# -- Parse args ---------------------------------------------------------------
BUILD_CRAN=true
BUILD_BIOC=true
BUILD_GITHUB=true
BUILD_PYTHON=true
BUILD_TOOLS=true
BUILD_NODE=true
RESUME=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python-only) BUILD_CRAN=false; BUILD_BIOC=false; BUILD_GITHUB=false; BUILD_TOOLS=false; BUILD_NODE=false; shift ;;
    --r-only)      BUILD_PYTHON=false; BUILD_TOOLS=false; BUILD_NODE=false; shift ;;
    --tools-only)  BUILD_CRAN=false; BUILD_BIOC=false; BUILD_GITHUB=false; BUILD_PYTHON=false; BUILD_NODE=false; shift ;;
    --node-only)   BUILD_CRAN=false; BUILD_BIOC=false; BUILD_GITHUB=false; BUILD_PYTHON=false; BUILD_TOOLS=false; shift ;;
    --resume)      RESUME=true; shift ;;
    --platform)    PLATFORM="$2"; shift 2 ;;
    --dest)        DEST="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# -- Preflight -----------------------------------------------------------------
if ! command -v docker &>/dev/null; then
  error "Docker is not installed"
  exit 1
fi
if ! docker info &>/dev/null; then
  error "Docker daemon is not running"
  exit 1
fi
if [ ! -f "$DOCKERFILE" ]; then
  error "Dockerfile not found: $DOCKERFILE"
  exit 1
fi
if ! command -v zstd &>/dev/null; then
  error "zstd is not installed (needed to pack per-track tarballs)"
  exit 1
fi

BASE_IMAGE=$(grep '^base_image:' "$MANIFEST" | awk '{print $2}' | tr -d '"')

info "Base image: $BASE_IMAGE"
info "Platform: $PLATFORM"
info "Version: $VERSION"
info "Destination: $DEST"
info "Resume mode: $RESUME"

# -- Helper: build a Dockerfile stage -----------------------------------------
build_stage() {
  local stage="$1"
  local image="$2"
  local label="$3"

  if [[ "$RESUME" == true ]] && docker image inspect "$image" > /dev/null 2>&1; then
    info "Image '$image' exists — skipping build (--resume)"
    return 0
  fi

  step "Building: $label"
  local t0
  t0=$(date +%s)

  if docker build \
    --file "$DOCKERFILE" \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --platform "$PLATFORM" \
    --progress=plain \
    --target "$stage" \
    -t "$image" \
    "$BUILD_CONTEXT"; then
    local elapsed=$(( $(date +%s) - t0 ))
    info "$label built in ${elapsed}s"
    return 0
  else
    local elapsed=$(( $(date +%s) - t0 ))
    error "$label FAILED after ${elapsed}s"
    return 1
  fi
}

# -- Helper: extract a stage directory into the staging tree -------------------
extract_stage() {
  local image="$1"
  local src_path="$2"
  local dest_dir="$3"

  mkdir -p "$dest_dir"
  local cid output rc=0
  cid=$(docker create --platform "$PLATFORM" "$image" true)
  output=$(docker cp "$cid:$src_path/." "$dest_dir/" 2>&1) || rc=$?
  docker rm "$cid" > /dev/null
  if [[ $rc -ne 0 ]]; then
    if echo "$output" | grep -q "Could not find the file"; then
      warn "Path $src_path not found in image — skipping"
      return 1
    elif echo "$output" | grep -q "invalid symlink"; then
      warn "Skipped broken symlinks (harmless)"
    else
      error "docker cp failed: $output"
      return 1
    fi
  fi
  local count
  count=$(find "$dest_dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
  info "Extracted $count entries to $dest_dir"
}

# -- Helper: extract a track's packages.txt fragment ---------------------------
extract_fragment() {
  local image="$1"
  local src_file="$2"   # path inside the image
  local dest_file="$3"  # path in the staging tree
  if docker run --rm "$image" cat "$src_file" > "$dest_file" 2>/dev/null && [ -s "$dest_file" ]; then
    info "Fragment: $(basename "$dest_file") ($(head -c 60 "$dest_file" | tr '\n' ' ')…)"
  else
    warn "No fragment $src_file in $image"
    rm -f "$dest_file"
    return 1
  fi
}

# -- Build tracks --------------------------------------------------------------
STAGING=$(mktemp -d)
DIST=$(mktemp -d)
trap 'info "Cleaning up staging dirs..."; rm -rf "$STAGING" "$DIST"' EXIT

TOTAL_START=$(date +%s)
TRACK_STATUS=()

# R track (sequential: cran -> bioconductor -> github)
if $BUILD_CRAN; then
  if build_stage cran "$IMG_CRAN" "CRAN (binary .deb)" && \
     extract_stage "$IMG_CRAN" /staging/r/cran "$STAGING/r/cran" && \
     extract_fragment "$IMG_CRAN" /staging/cran.packages.txt "$STAGING/cran.packages.txt"; then
    TRACK_STATUS+=("CRAN: OK")
  else
    TRACK_STATUS+=("CRAN: FAILED")
    BUILD_BIOC=false
    BUILD_GITHUB=false
  fi
fi

if $BUILD_BIOC; then
  if build_stage bioconductor "$IMG_BIOC" "Bioconductor (source)" && \
     extract_stage "$IMG_BIOC" /staging/r/bioconductor "$STAGING/r/bioconductor" && \
     extract_fragment "$IMG_BIOC" /staging/bioconductor.packages.txt "$STAGING/bioconductor.packages.txt"; then
    TRACK_STATUS+=("Bioconductor: OK")
  else
    TRACK_STATUS+=("Bioconductor: FAILED")
    BUILD_GITHUB=false
  fi
fi

if $BUILD_GITHUB; then
  if build_stage github "$IMG_GITHUB" "GitHub R packages" && \
     extract_stage "$IMG_GITHUB" /staging/r/github "$STAGING/r/github" && \
     extract_fragment "$IMG_GITHUB" /staging/github.packages.txt "$STAGING/github.packages.txt"; then
    TRACK_STATUS+=("GitHub R: OK")
  else
    TRACK_STATUS+=("GitHub R: FAILED")
  fi
fi

# Python track (independent)
if $BUILD_PYTHON; then
  if build_stage python "$IMG_PYTHON" "Python (uv)" && \
     extract_stage "$IMG_PYTHON" /staging/python "$STAGING/python" && \
     extract_fragment "$IMG_PYTHON" /staging/python.packages.txt "$STAGING/python.packages.txt"; then
    TRACK_STATUS+=("Python: OK")
  else
    TRACK_STATUS+=("Python: FAILED")
  fi
fi

# System tools track (independent) — conda prefix + fragment live under /mnt/libs/current
if $BUILD_TOOLS; then
  if build_stage system-tools "$IMG_TOOLS" "System tools (bioconda)" && \
     extract_stage "$IMG_TOOLS" /mnt/libs/current/conda "$STAGING/conda" && \
     extract_fragment "$IMG_TOOLS" /mnt/libs/current/conda.packages.txt "$STAGING/conda.packages.txt"; then
    TRACK_STATUS+=("System tools: OK")
  else
    TRACK_STATUS+=("System tools: FAILED (bioconda packages may not be available for this architecture)")
  fi
fi

# Node track (independent)
if $BUILD_NODE; then
  if build_stage node "$IMG_NODE" "Node packages" && \
     extract_stage "$IMG_NODE" /staging/node "$STAGING/node" && \
     extract_fragment "$IMG_NODE" /staging/node.packages.txt "$STAGING/node.packages.txt"; then
    TRACK_STATUS+=("Node: OK")
  else
    TRACK_STATUS+=("Node: FAILED")
  fi
fi

TOTAL_ELAPSED=$(( $(date +%s) - TOTAL_START ))

# -- Pack per-track tarballs ---------------------------------------------------
step "Packing per-track tarballs"
if ! "$SCRIPT_DIR/lib-store-pack.sh" "$STAGING" "$DIST"; then
  error "No tracks completed successfully. Nothing to install."
  exit 1
fi
BUILT_TRACKS="$(tr '\n' ' ' < "$DIST/tracks.txt")"
info "Built tracks:$BUILT_TRACKS"

# -- Install to host directory -------------------------------------------------
step "Installing to $DEST"

# Detect partial build (any --*-only flag).
PARTIAL_BUILD=false
if ! ($BUILD_CRAN && $BUILD_BIOC && $BUILD_GITHUB && $BUILD_PYTHON && $BUILD_TOOLS && $BUILD_NODE); then
  PARTIAL_BUILD=true
fi

if [[ "$PARTIAL_BUILD" == true ]] && [ -L "$DEST/current" ]; then
  # Merge the freshly built tracks into the existing version: extract just those
  # track tarballs over it, then rebuild packages.txt from ALL present fragments.
  CURRENT_TARGET=$(readlink "$DEST/current")
  TARGET_DIR="$DEST/$CURRENT_TARGET"
  # Refuse to merge into a CLI-pulled, immutable version. Those carry a meta.json this
  # script never writes; the CLI treats them as verified and byte-stable, and a later
  # `inflexa libs pull` short-circuits "up to date" — so an in-place merge would corrupt
  # the store silently and permanently. Only local-* builds (no meta.json) are mergeable.
  if [ -f "$TARGET_DIR/meta.json" ]; then
    error "Refusing to merge a partial build into '$CURRENT_TARGET' — it is a CLI-pulled version (has meta.json)."
    error "Run a full local build (no --*-only flags) to create a fresh local-* version instead."
    exit 1
  fi
  info "Partial build — merging tracks [$BUILT_TRACKS] into existing $CURRENT_TARGET"
  for t in $BUILT_TRACKS; do
    zstd -dq -c "$DIST/$t.tar.zst" | tar -xf - -C "$TARGET_DIR"
  done
  {
    lib_store_packages_header
    echo
    for t in $LIB_STORE_CONCAT_ORDER; do
      frag="$TARGET_DIR/$(lib_store_track_fragment "$t")"
      [ -f "$frag" ] && { cat "$frag"; echo; }
    done
  } > "$TARGET_DIR/packages.txt"
  chmod -R a+rX "$TARGET_DIR"
  info "Merged into $TARGET_DIR"
else
  # Fresh assembly into a new version directory — exactly the tracks that built
  # (dev builds may be partial).
  "$SCRIPT_DIR/lib-store-assemble.sh" "$BUILT_TRACKS" "$DIST" "$DEST/$VERSION"
  chmod -R a+rX "$DEST/$VERSION"
  ln -sfn "./$VERSION" "$DEST/current"
  info "Installed as $DEST/$VERSION"
fi

# Verify
echo "  Contents:"
for d in "$DEST"/current/*/; do
  name=$(basename "$d")
  count=$(find "$d" -maxdepth 2 -mindepth 1 | head -200 | wc -l | tr -d ' ')
  echo "    $name: $count entries"
done

# -- Cleanup track images ------------------------------------------------------
step "Cleanup"
for img in $IMG_CRAN $IMG_BIOC $IMG_GITHUB $IMG_PYTHON $IMG_TOOLS $IMG_NODE; do
  docker rmi "$img" 2>/dev/null || true
done
info "Removed track images"

# -- Offer to remove old builds ------------------------------------------------
OLD_BUILDS=()
CURRENT_TARGET=$(readlink "$DEST/current" 2>/dev/null | sed 's|^\./||')
for d in "$DEST"/local-*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  [ "$name" = "$CURRENT_TARGET" ] && continue
  OLD_BUILDS+=("$name")
done

if [ ${#OLD_BUILDS[@]} -gt 0 ]; then
  echo
  info "Found ${#OLD_BUILDS[@]} old build(s):"
  for old in "${OLD_BUILDS[@]}"; do
    size=$(du -sh "$DEST/$old" 2>/dev/null | cut -f1)
    printf "  %s  (%s)\n" "$old" "$size"
  done
  echo
  # `read` returns non-zero at EOF; under `set -e` a non-interactive stdin (CI, a pipe)
  # would otherwise abort a SUCCESSFUL build here. Gate on a TTY and default to No so the
  # prompt never deletes without an explicit interactive "yes".
  answer=n
  if [[ -t 0 ]]; then
    read -rp "Delete old builds? [y/N] " answer || answer=n
  fi
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    for old in "${OLD_BUILDS[@]}"; do
      rm -rf "${DEST:?}/$old"
      info "Removed $old"
    done
  fi
fi

# -- Summary -------------------------------------------------------------------
step "Summary"
echo
printf "  Version:     %s\n" "$VERSION"
printf "  Assembled:   %s %s\n" "$ASSEMBLE_MODE" "$ASSEMBLE_SEL"
printf "  Total time:  %dm %ds\n" "$((TOTAL_ELAPSED / 60))" "$((TOTAL_ELAPSED % 60))"
printf "  Destination: %s\n" "$DEST"
echo
for status in "${TRACK_STATUS[@]}"; do
  printf "  %s\n" "$status"
done
echo
info "Run scripts/lib-store-validate/run.sh to validate the assembled store."
