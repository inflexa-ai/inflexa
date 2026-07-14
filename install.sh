#!/usr/bin/env bash
# Inflexa installer — downloads a release binary, verifies it against the
# release's SHA256SUMS, and installs it as `inflexa`.
#
#   curl -fsSL https://inflexa.ai/install.sh | bash
#
# (inflexa.ai/install.sh redirects to this file on the repo's main branch;
# the raw.githubusercontent.com URL works directly as well.)
#
#   ... | bash -s -- 0.1.0                     pin a version instead of latest
#   INFLEXA_INSTALL_DIR=/some/bin ... | bash   install dir (default ~/.local/bin)
#
# Verification story: the hash comes from the release's own SHA256SUMS — the
# file the release workflow generated and attested — so this installs exactly
# what that workflow built. For independent proof, any binary can additionally
# be checked with: gh attestation verify <file> --repo inflexa-ai/inflexa
#
# Everything lives in main(), invoked on the last line, so a truncated
# curl|bash download can never execute half a script.
set -euo pipefail

REPO="inflexa-ai/inflexa"
INSTALL_DIR="${INFLEXA_INSTALL_DIR:-$HOME/.local/bin}"

info() { printf '%s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

main() {
  version="${1:-}"

  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    MINGW* | MSYS* | CYGWIN*) die "Windows: download inflexa-windows-x64.exe from https://github.com/$REPO/releases/latest (or install inside WSL)" ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch="arm64" ;;
    x86_64 | amd64) arch="x64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  # An x86_64 shell under Rosetta reports x86_64; the native arm64 binary is
  # the right install on that hardware.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi
  if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
    die "no linux-arm64 build is published — see https://github.com/$REPO/releases for available platforms"
  fi
  asset="inflexa-$os-$arch"

  if [ -z "$version" ]; then
    # The /releases/latest redirect resolves the newest tag without touching
    # the GitHub API and its unauthenticated rate limits; pinning the tag
    # here (rather than downloading via releases/latest/download/...) keeps
    # the binary and SHA256SUMS from straddling a release published mid-run.
    tag=$(curl -fsSLI --proto '=https' -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || die "could not resolve the latest release"
    tag="${tag##*/}"
  else
    tag="v${version#v}"
  fi
  case "$tag" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *) die "could not determine a release version (got: '$tag')" ;;
  esac

  info "Installing inflexa $tag ($asset)..."
  base="https://github.com/$REPO/releases/download/$tag"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  curl -fsSL --proto '=https' -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"
  curl -fsSL --proto '=https' -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

  expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || die "$asset is not listed in the release's SHA256SUMS"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
  else
    # macOS ships shasum (perl), not GNU coreutils' sha256sum.
    actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
  fi
  [ "$actual" = "$expected" ] || die "checksum mismatch for $asset — expected $expected, got $actual. NOT installing."

  # Stage inside the target dir so the final rename is atomic: an existing
  # `inflexa` is either the old binary or the new one, never a partial write.
  mkdir -p "$INSTALL_DIR"
  staged="$INSTALL_DIR/.inflexa.install.$$"
  cp "$tmp/$asset" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$INSTALL_DIR/inflexa"

  installed=$("$INSTALL_DIR/inflexa" --version) || die "the installed binary failed to run"
  info "Installed inflexa $installed -> $INSTALL_DIR/inflexa"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      info ""
      info "Note: $INSTALL_DIR is not on your PATH. Add it with:"
      info "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc    # or ~/.bashrc"
      info "then restart your shell."
      ;;
  esac
  existing=$(command -v inflexa 2>/dev/null || true)
  if [ -n "$existing" ] && [ "$existing" != "$INSTALL_DIR/inflexa" ]; then
    info ""
    info "Note: another inflexa is already on your PATH at $existing and may shadow this install."
  fi
}

main "$@"
