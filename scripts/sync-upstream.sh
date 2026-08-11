#!/usr/bin/env bash
# Sync this fork with an upstream Handy release. See FORK.md for the policy
# behind the resolution hints this prints.
#
#   scripts/sync-upstream.sh plan   [TAG]   # read-only: what a merge would cost
#   scripts/sync-upstream.sh start  [TAG]   # branch + merge, stop at conflicts
#   scripts/sync-upstream.sh verify [--quick]
#
# TAG defaults to the newest upstream release tag. `verify` runs the whole
# ladder; --quick skips the release bundle (minutes) and keeps the rest.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"
: "${CARGO_TARGET_DIR:=$(pwd)/src-tauri/target}"
export CARGO_TARGET_DIR

die() { printf '%s\n' "$*" >&2; exit 1; }
h1() { printf '\n== %s\n' "$*"; }

git remote get-url upstream >/dev/null 2>&1 ||
  die "no 'upstream' remote: git remote add upstream https://github.com/cjpais/Handy.git"

latest_tag() { git tag -l 'v*' --sort=-v:refname | head -1; }

resolve_tag() {
  local tag="${1:-}"
  [ -n "$tag" ] || tag="$(latest_tag)"
  git rev-parse -q --verify "$tag^{commit}" >/dev/null || die "unknown tag: $tag"
  printf '%s' "$tag"
}

# Files both sides touched since the merge base, and which of those git cannot
# merge on its own. The per-file upstream commit list is what tells you which
# behavior each conflicted hunk is carrying.
report() {
  local tag="$1" base
  base="$(git merge-base HEAD "$tag")"

  h1 "range"
  printf 'fork tip   %s\n' "$(git log -1 --pretty='%h %ad %s' --date=short HEAD)"
  printf 'upstream   %s\n' "$(git log -1 --pretty='%h %ad %s' --date=short "$tag")"
  printf 'merge base %s\n' "$(git log -1 --pretty='%h %ad %s' --date=short "$base")"
  printf 'incoming   %s commits\n' "$(git rev-list --no-merges --count "HEAD..$tag")"

  h1 "touched by both sides"
  comm -12 \
    <(git diff --name-only "$base..HEAD" | sort) \
    <(git diff --name-only "$base..$tag" | sort) || true

  h1 "conflicts a merge would produce"
  local out
  out="$(git merge-tree --write-tree --name-only HEAD "$tag" 2>&1)" || true
  local files
  files="$(printf '%s\n' "$out" | sed -n '/^$/,$p' | grep -oE '^CONFLICT \([^)]+\): Merge conflict in .*$' | sed 's/.*Merge conflict in //' || true)"
  if [ -z "$files" ]; then
    printf 'none — this merge is mechanical\n'
    return
  fi
  printf '%s\n' "$files" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '\n%s\n' "$f"
    git log --oneline --no-merges "$base..$tag" -- "$f" | sed 's/^/    /'
  done
}

case "${1:-}" in
plan)
  tag="$(resolve_tag "${2:-}")"
  git fetch --quiet upstream --tags
  tag="$(resolve_tag "${2:-}")"
  report "$tag"
  h1 "next"
  printf 'scripts/sync-upstream.sh start %s\n' "$tag"
  ;;

start)
  git diff --quiet && git diff --cached --quiet || die "working tree is dirty; commit first"
  git fetch --quiet upstream --tags
  tag="$(resolve_tag "${2:-}")"
  branch="sync/upstream-$tag"
  git rev-parse -q --verify "$branch" >/dev/null && die "$branch already exists"
  report "$tag"
  git switch -c "$branch"
  if git merge "$tag"; then
    h1 "merged clean"
  else
    h1 "conflicts to resolve by hand"
    git diff --name-only --diff-filter=U | sed 's/^/    /'
    cat <<'HINTS'

policy (FORK.md):
    src-tauri/Cargo.lock          take upstream's, let cargo reconcile
    src-tauri/Cargo.toml          watch for a dep BOTH sides added (duplicate key)
    src/bindings.ts               generated; keep the union consistent, a dev run rewrites it
    src-tauri/tauri.conf.json     keep this fork's productName + signing, take upstream's version
    everything else               keep the fork's behavior, graft upstream's new calls into it

after resolving: scripts/sync-upstream.sh verify
HINTS
  fi
  ;;

verify)
  quick=0
  [ "${2:-}" = "--quick" ] && quick=1

  h1 "cargo fmt"
  (cd src-tauri && cargo fmt -- --check)

  h1 "cargo test"
  (cd src-tauri && cargo test -j6 --message-format short 2>&1 | grep -E '^test result|^error|panicked')

  h1 "tsc"
  npx tsc --noEmit

  h1 "vite build"
  npx vite build >/dev/null

  # Fails on strings this fork added in English only; what matters is that no
  # NEW key regressed, so this is reported and not gating.
  h1 "translations (report only)"
  bun scripts/check-translations.ts 2>&1 | tail -3 || true

  if [ "$quick" = 0 ]; then
    h1 "release bundle"
    bun run tauri build --bundles app 2>&1 | grep -E 'Bundling|Finished [0-9]|^error' || true
  fi

  h1 "done"
  printf 'install by hand when you are between dictations:\n'
  printf '  osascript -e '\''quit app "Fancy Shmancy"'\''\n'
  printf '  ditto "src-tauri/target/release/bundle/macos/Fancy Shmancy.app" "/Applications/Fancy Shmancy.app"\n'
  printf '  open -a "/Applications/Fancy Shmancy.app"\n'
  ;;

*)
  sed -n '2,12p' "$0"
  exit 1
  ;;
esac
