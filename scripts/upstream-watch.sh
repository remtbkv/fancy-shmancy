#!/usr/bin/env bash
# Weekly check for a new upstream Handy release, and what merging it would cost.
# Writes a dated report either way; notifies only when a release this fork
# hasn't merged appears, and only once per tag.
#
# Wired up by ~/Library/LaunchAgents/com.handy.upstream-watch.plist.

set -euo pipefail

REPO="${HANDY_REPO:-$HOME/projects/handy}"
OUT="$HOME/handy-review/upstream"
STATE="$OUT/.last-notified"

cd "$REPO"
mkdir -p "$OUT"

git fetch --quiet upstream --tags || {
  printf 'upstream fetch failed\n' >&2
  exit 1
}

latest="$(git tag -l 'v*' --sort=-v:refname | head -1)"
stamp="$(date '+%Y-%m-%d')"
report="$OUT/$stamp-$latest.md"

if git merge-base --is-ancestor "$latest" HEAD 2>/dev/null; then
  merged=yes
else
  merged=no
fi

unreleased="$(git rev-list --no-merges --count "HEAD..upstream/main" 2>/dev/null || echo 0)"

{
  printf '# upstream watch — %s\n\n' "$stamp"
  printf -- '- newest upstream release: %s (%s)\n' "$latest" \
    "$(git log -1 --pretty='%ad' --date=short "$latest")"
  printf -- '- merged into this fork: %s\n' "$merged"
  printf -- '- commits on upstream/main past this fork: %s\n\n' "$unreleased"
  if [ "$merged" = no ]; then
    printf '## cost of merging %s\n\n```\n' "$latest"
    bash scripts/sync-upstream.sh plan "$latest" 2>&1
    printf '```\n'
  elif [ "$unreleased" != 0 ]; then
    printf '## cost of merging upstream/main (unreleased)\n\n```\n'
    bash scripts/sync-upstream.sh plan upstream/main 2>&1
    printf '```\n'
  fi
} > "$report"

printf 'wrote %s\n' "$report"

# One notification per unmerged release, so a quiet week stays quiet.
if [ "$merged" = no ] && [ "$(cat "$STATE" 2>/dev/null || true)" != "$latest" ]; then
  conflicts="$(grep -cE '^src|^\.github|^package' "$report" 2>/dev/null || echo '?')"
  printf '%s' "$latest" > "$STATE"
  /usr/bin/osascript -e "display notification \"Merge cost is in $report\" with title \"Handy $latest is out\" sound name \"Boop\"" || true
  printf 'notified for %s (%s lines of file inventory)\n' "$latest" "$conflicts"
fi
