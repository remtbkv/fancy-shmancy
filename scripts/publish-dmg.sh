#!/usr/bin/env bash
# Put the DMG the runner just built on the release page, replacing the one
# that was there. Called by .github/workflows/dmg.yml; needs GH_TOKEN.
#
# The asset is renamed to a fixed, space-free filename so the download link can
# be handed to someone once and keep working:
#
#   https://github.com/remtbkv/fancy-shmancy/releases/latest/download/Fancy-Shmancy-aarch64.dmg

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

TAG=latest
ASSET=Fancy-Shmancy-aarch64.dmg

built="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' | head -1)"
[ -n "$built" ] || { echo "no dmg was built" >&2; exit 1; }
cp "$built" "$ASSET"

sha="$(git rev-parse --short HEAD)"
subject="$(git log -1 --format=%s)"

notes="$(
  cat <<EOF
Built from \`$sha\` — $subject

Offline push-to-talk dictation for Apple Silicon Macs. Hold Right Option, talk,
release; the words land wherever the cursor is. Nothing leaves the machine.

**Install:** open the DMG, drag the app to Applications. macOS refuses to launch
it the first time because it is not notarized by Apple. Either clear the flag
macOS puts on downloaded files:

\`\`\`bash
xattr -dr com.apple.quarantine "/Applications/Fancy Shmancy.app"
\`\`\`

or open it, let the refusal appear, then System Settings → Privacy & Security →
scroll down → **Open Anyway**.

First run downloads a transcription model and asks for microphone and
accessibility permissions.

Built on [Handy](https://github.com/cjpais/Handy) by CJ Pais, MIT.
EOF
)"

# The release exists after the first run; creating it again would fail.
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release edit "$TAG" --notes "$notes" --latest
  gh release upload "$TAG" "$ASSET" --clobber
else
  gh release create "$TAG" "$ASSET" --title "Latest build" --notes "$notes" --latest
fi

echo "published $ASSET from $sha"
