#!/bin/sh
# Installs Strato as a standalone binary: no Bun or Node needed.
#
#   curl -fsSL https://raw.githubusercontent.com/hugoblanc/strato/main/install.sh | sh
#
# Environment:
#   STRATO_INSTALL_DIR   where the binary goes (default: ~/.local/bin)
#   STRATO_VERSION       a release tag to install (default: the latest release), e.g. v0.2.0
#   STRATO_SKILL_ARGS    arguments for `strato install-skill` (default: none, the global skill);
#                        e.g. "--project $HOME/dev/acme". Set STRATO_NO_SKILL=1 to skip that step.
#   STRATO_DOWNLOAD_BASE where the binaries and SHA256SUMS are read from instead of GitHub (a mirror, or a test)
#
# Steps: detect the platform, download the binary and SHA256SUMS from the GitHub release, check the SHA-256,
# install atomically (the previous binary is kept as strato.previous), then `strato install-skill`.
# Windows: download strato-windows-x64.exe from the releases page by hand (see README).
set -eu

REPO="hugoblanc/strato"
INSTALL_DIR="${STRATO_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${STRATO_VERSION:-latest}"

say() { printf '%s\n' "strato: $*"; }
die() { printf '%s\n' "strato: $*" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) die "on Windows, download strato-windows-x64.exe from https://github.com/$REPO/releases/latest" ;;
  *) die "no binary for $os: install from a clone with Bun instead (see README)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "no binary for the $arch processor: install from a clone with Bun instead (see README)" ;;
esac
# a shell running under Rosetta reports x86_64 on Apple Silicon: take the native binary
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset="strato-$os-$arch"

if [ -n "${STRATO_DOWNLOAD_BASE:-}" ]; then
  base="$STRATO_DOWNLOAD_BASE"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "curl or wget is needed"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "sha256sum or shasum is needed to check the download"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($VERSION)"
fetch "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

expected=$(awk -v f="$asset" '{ n = $2; sub(/^\*/, "", n); if (n == f) print tolower($1) }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "$asset is not listed in SHA256SUMS"
actual=$(sha256 "$tmp/$asset")
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset: expected $expected, got $actual"
chmod 755 "$tmp/$asset"
"$tmp/$asset" version >/dev/null 2>&1 || die "the downloaded binary does not start on this machine"

mkdir -p "$INSTALL_DIR"
dest="$INSTALL_DIR/strato"
# same folder, then rename: the path always holds a whole binary
cp "$tmp/$asset" "$dest.new.$$"
chmod 755 "$dest.new.$$"
if [ -f "$dest" ]; then
  rm -f "$dest.previous"
  ln "$dest" "$dest.previous" 2>/dev/null || cp -p "$dest" "$dest.previous"
fi
mv -f "$dest.new.$$" "$dest"
say "installed $("$dest" version)"
say "binary: $dest"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say "$INSTALL_DIR is not in your PATH. Add it, for example:"
    say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc   (or ~/.bashrc)"
    ;;
esac

if [ "${STRATO_NO_SKILL:-}" != 1 ]; then
  # shellcheck disable=SC2086
  "$dest" install-skill ${STRATO_SKILL_ARGS:-} || say "the skill was not written: run \`$dest install-skill\` (add --force to replace a hand-written one)"
fi
