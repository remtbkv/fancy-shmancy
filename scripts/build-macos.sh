#!/usr/bin/env bash
# Build a Fancy Shmancy DMG on macOS without installing anything permanently.
#
#   scripts/build-macos.sh          # build; borrow system Rust/Bun if present
#   scripts/build-macos.sh --local  # ignore system Rust/Bun, install into ./.toolchain
#
# Rust and Bun have no virtualenv, but both decide where they live from the
# environment: RUSTUP_HOME/CARGO_HOME for one, BUN_INSTALL for the other. Point
# all three inside the checkout and the whole toolchain is one folder you can
# delete afterwards, leaving the machine as it was. The script prints the
# command to do that when it finishes.
#
# Not small, though: a toolchain is ~1.5 GB, node_modules a few hundred MB, and
# Rust's build directory several GB. First build takes a while.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

TOOLCHAIN="$(pwd)/.toolchain"
LOCAL_ONLY=false
[ "${1:-}" = "--local" ] && LOCAL_ONLY=true

die() { printf '%s\n' "$*" >&2; exit 1; }
h1() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only; see BUILD.md for Windows and Linux"

# Xcode's command line tools are the one thing that cannot be kept local — the
# linker and system headers come from them.
xcode-select -p >/dev/null 2>&1 ||
  die "Xcode command line tools missing. Install with: xcode-select --install"

export RUSTUP_HOME="$TOOLCHAIN/rustup"
export CARGO_HOME="$TOOLCHAIN/cargo"
export BUN_INSTALL="$TOOLCHAIN/bun"
export PATH="$CARGO_HOME/bin:$BUN_INSTALL/bin:$PATH"

# An already-installed toolchain is worth borrowing: it saves the download and
# the disk. --local is for people who would rather not touch theirs at all.
if ! $LOCAL_ONLY && have cargo && have bun; then
  h1 "using the Rust and Bun already on this machine"
  unset RUSTUP_HOME CARGO_HOME BUN_INSTALL
  export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"
  TOOLCHAIN=""
else
  mkdir -p "$TOOLCHAIN"
  if ! have cargo; then
    h1 "installing Rust into $CARGO_HOME"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
      sh -s -- -y --no-modify-path --default-toolchain stable
  fi
  if ! have bun; then
    h1 "installing Bun into $BUN_INSTALL"
    curl -fsSL https://bun.sh/install | bash
  fi
fi

have cargo || die "cargo still not on PATH"
have bun || die "bun still not on PATH"

h1 "installing dependencies"
bun install

# export.conf.json carries this fork's bundle identifier and turns off the
# updater artifact, whose signing key is not in the repo and never will be.
h1 "building (this is the slow part)"
bun run tauri build --config export.conf.json

DMG="$(find src-tauri/target/release/bundle/dmg -name '*.dmg' -maxdepth 1 2>/dev/null | head -1)"
APP="$(find src-tauri/target/release/bundle/macos -name '*.app' -maxdepth 1 2>/dev/null | head -1)"

h1 "done"
[ -n "$APP" ] && printf 'app: %s\n' "$APP"
[ -n "$DMG" ] && printf 'dmg: %s\n' "$DMG"
cat <<'EOF'

Drag the app to /Applications. It is signed with a local certificate, which
means nothing on a Mac that is not this one, so a copy that arrived over the
internet is quarantined until you clear it:

  xattr -dr com.apple.quarantine "/Applications/Fancy Shmancy.app"

First launch asks for microphone and accessibility permissions and downloads a
transcription model.
EOF

[ -n "$TOOLCHAIN" ] && printf '\nTo remove the toolchain this script installed:\n  rm -rf %s\n' "$TOOLCHAIN"
exit 0
