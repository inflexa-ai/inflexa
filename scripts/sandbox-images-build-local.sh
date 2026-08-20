#!/usr/bin/env bash
# Build the two sandbox images locally: sandbox-base (the one runtime image)
# and sandbox-provisioner (the network-enabled builder). This reproduces the
# image half of CI (.github/workflows/sandbox-images-build.yml) on your own
# machine. The store itself builds with the provisioner container — refer to
# .github/workflows/package-store-build.yml for the sequence.
#
# Usage:
#   ./scripts/sandbox-images-build-local.sh                       # both images
#   ./scripts/sandbox-images-build-local.sh --base-only           # sandbox-base only
#   ./scripts/sandbox-images-build-local.sh --platform linux/amd64
#
# After a build, validate the runtime image directly (it bakes no package):
#   scripts/package-store-validate/run.sh --image sandbox-base:local

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

MANIFEST="$PROJECT_ROOT/images/package-store/manifest.yaml"
PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')"
BUILD_PROVISIONER=true

TAG_BASE="sandbox-base:local"
TAG_PROVISIONER="sandbox-provisioner:local"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC} %s\n" "$1"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$1"; }
step()  { printf "\n${CYAN}--- %s ---${NC}\n" "$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-only) BUILD_PROVISIONER=false; shift ;;
    --platform)  PLATFORM="$2"; shift 2 ;;
    *) error "Unknown arg: $1"; exit 1 ;;
  esac
done

ARCH="${PLATFORM##*/}"
BASE_IMAGE=$(grep '^base_image:' "$MANIFEST" | awk '{print $2}' | tr -d '"')
info "platform: $PLATFORM"
info "base image (from the manifest): $BASE_IMAGE"

step "Build sandbox-base"
docker buildx build --load \
  -f "$PROJECT_ROOT/images/sandbox-base/Dockerfile" \
  --platform "$PLATFORM" \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "TARGETARCH=$ARCH" \
  -t "$TAG_BASE" \
  "$PROJECT_ROOT"
info "built $TAG_BASE"

if [ "$BUILD_PROVISIONER" = true ]; then
  step "Build sandbox-provisioner"
  docker buildx build --load \
    -f "$PROJECT_ROOT/images/sandbox-provisioner/Dockerfile" \
    --platform "$PLATFORM" \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    -t "$TAG_PROVISIONER" \
    "$PROJECT_ROOT"
  info "built $TAG_PROVISIONER"
fi

step "Done"
info "images: $TAG_BASE$([ "$BUILD_PROVISIONER" = true ] && echo ", $TAG_PROVISIONER")"
