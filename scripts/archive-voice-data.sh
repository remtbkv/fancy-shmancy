#!/usr/bin/env bash
# Copy every recording and its transcript out of the app's data directory into
# ~/handy-voice-dataset, which nothing but Rem deletes.
#
# The app prunes its own recordings on a retention timer and removes the WAVs
# with unlink — they never reach the Trash. This archive is append-only: it
# never deletes, never overwrites, and rsync --ignore-existing means a file
# already archived is left exactly as it was.
#
# Wired up by ~/Library/LaunchAgents/com.handy.voice-archive.plist.

set -euo pipefail

SRC="$HOME/Library/Application Support/com.pais.handy"
DST="$HOME/handy-voice-dataset"

mkdir -p "$DST/recordings"

# Audio: hardlinks, not copies. Same inode, so the archive costs no extra disk,
# and a file the app later unlinks stays alive here because this link still holds
# it. --ignore-existing means an archived file is never touched again.
find "$SRC/recordings" -name '*.wav' -type f -print0 |
  while IFS= read -r -d '' f; do
    [ -e "$DST/recordings/$(basename "$f")" ] || ln "$f" "$DST/recordings/"
  done

# Transcripts: a fresh snapshot of the database, plus an append-only JSONL of
# (audio file, text) pairs — the shape a fine-tune actually needs. Rows the app
# has already pruned stay in the JSONL because previous lines are never rewritten.
if [ -f "$SRC/history.db" ]; then
  cp "$SRC/history.db" "$DST/history-latest.db"
  /usr/bin/python3 - "$DST" <<'PY'
import json, pathlib, sqlite3, sys

dst = pathlib.Path(sys.argv[1])
pairs = dst / "pairs.jsonl"

seen = set()
if pairs.exists():
    for line in pairs.read_text().splitlines():
        try:
            seen.add(json.loads(line)["file_name"])
        except Exception:
            pass

db = sqlite3.connect(dst / "history-latest.db")
rows = db.execute(
    "SELECT file_name, timestamp, transcription_text FROM transcription_history"
    " WHERE transcription_text IS NOT NULL AND transcription_text != ''"
).fetchall()

added = 0
with pairs.open("a") as fh:
    for file_name, timestamp, text in rows:
        if file_name in seen:
            continue
        audio = dst / "recordings" / file_name
        fh.write(json.dumps({
            "file_name": file_name,
            "timestamp": timestamp,
            "audio_present": audio.exists(),
            "text": text,
        }, ensure_ascii=False) + "\n")
        added += 1

total = sum(1 for _ in pairs.open())
print(f"pairs.jsonl: +{added} (total {total})")
PY
fi

printf 'archived %s recordings (%s)\n' \
  "$(ls -1 "$DST/recordings" | wc -l | tr -d ' ')" \
  "$(du -sh "$DST" | cut -f1)"
