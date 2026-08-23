#!/usr/bin/env python3
"""Build the fixtures the headless UI harness feeds to its Tauri IPC stub.

Reads the installed app's own settings and history so the screenshots show the
real thing rather than lorem: the row text is what it is because Rem dictated
it. Both sources are opened read-only and the history database is copied first,
so the live app is never touched.

Writes scripts/ui-shots/fixtures.json.
"""

import json
import os
import pathlib
import shutil
import sqlite3
import tempfile
import time

APP_DATA = pathlib.Path.home() / "Library/Application Support/com.pais.handy"
OUT = pathlib.Path(__file__).parent / "fixtures.json"

# Anything that could carry a credential. None are set today, but a fixture
# committed to the repo must not become the place one leaks from.
SECRET_KEYS = {"post_process_api_key", "post_process_base_url"}


def load_settings() -> dict:
    with open(APP_DATA / "settings_store.json") as fh:
        settings = json.load(fh)["settings"]
    for key in SECRET_KEYS:
        if key in settings:
            settings[key] = ""
    settings["onboarding_completed"] = True
    return settings


def load_history(limit: int = 60) -> list:
    """Most recent entries, copied out of the live database first."""
    source = APP_DATA / "history.db"
    if not source.exists():
        return []
    with tempfile.TemporaryDirectory() as tmp:
        copy = pathlib.Path(tmp) / "history.db"
        shutil.copy2(source, copy)
        conn = sqlite3.connect(copy)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT id, file_name, timestamp, saved, title, transcription_text,
                      post_processed_text, post_process_prompt,
                      post_process_requested, cancelled
               FROM transcription_history ORDER BY id DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        conn.close()
    return [
        {
            "id": r["id"],
            "file_name": r["file_name"],
            "timestamp": r["timestamp"],
            "saved": bool(r["saved"]),
            "title": r["title"],
            "transcription_text": r["transcription_text"],
            "post_processed_text": r["post_processed_text"],
            "post_process_prompt": r["post_process_prompt"],
            "post_process_requested": bool(r["post_process_requested"]),
            "cancelled": bool(r["cancelled"]),
        }
        for r in rows
    ]


def with_edge_cases(entries: list) -> list:
    """Two rows the real history may not currently hold, so the screenshots
    prove what an empty transcript renders as rather than assuming it."""
    now = int(time.time())
    top = max((e["id"] for e in entries), default=0)
    return [
        {
            "id": top + 2,
            "file_name": "fixture-cancelled.wav",
            "timestamp": now - 60,
            "saved": False,
            "title": "",
            "transcription_text": "",
            "post_processed_text": None,
            "post_process_prompt": None,
            "post_process_requested": False,
            "cancelled": True,
        },
        {
            "id": top + 1,
            "file_name": "fixture-empty.wav",
            "timestamp": now - 120,
            "saved": False,
            "title": "",
            "transcription_text": "",
            "post_processed_text": None,
            "post_process_prompt": None,
            "post_process_requested": False,
            "cancelled": False,
        },
        *entries,
    ]


def load_models() -> list:
    """The catalog, rendered the way the backend renders it, with two of the
    three recommended models already held — which is Rem's actual state and the
    one that exercises both curation rules at once: an alternate quant of the
    top pick must not be re-offered underneath itself, and a held model must
    drop out of the download list, leaving exactly the third."""
    catalog = json.load(
        open(
            pathlib.Path(__file__).parents[2]
            / "src-tauri/src/catalog/catalog.json"
        )
    )
    models = []
    for entry in catalog["models"]:
        files = entry.get("files") or []
        default = next(
            (f for f in files if f.get("quant") == entry.get("default_quant")),
            files[0] if files else None,
        )
        if not default:
            continue
        caps = entry.get("caps") or {}
        languages = caps.get("languages") or []
        models.append(
            {
                "id": f"{entry['id']}/{default['filename']}",
                "name": entry["name"],
                "description": entry.get("description", ""),
                "filename": default["filename"],
                "source": {
                    "HuggingFace": {
                        "repo_id": entry["id"],
                        "revision": entry.get("revision", "main"),
                    }
                },
                "size_mb": default.get("size_bytes", 0) // (1024 * 1024),
                "is_downloaded": False,
                "is_downloading": False,
                "partial_size": 0,
                "is_directory": False,
                "engine_type": entry.get("engine_type", "TranscribeRs"),
                "accuracy_score": entry.get("accuracy_score", 0),
                "speed_score": entry.get("speed_score", 0),
                "supports_translation": bool(caps.get("supports_translation")),
                "is_recommended": bool(entry.get("recommended")),
                "supported_languages": languages,
                "supports_language_selection": len(languages) > 1,
                "is_custom": False,
                "supports_streaming": bool(caps.get("supports_streaming")),
                "supports_language_detection": bool(caps.get("supports_language_detect")),
            }
        )

    recommended = [m for m in models if m["is_recommended"]]

    # The alternate-quant twin of the top pick: same repo, different file,
    # already on disk. This is the pair that used to show up twice.
    if recommended:
        top = recommended[0]
        held = dict(top)
        held["id"] = top["id"].replace(".gguf", "-Q8_0.gguf")
        held["filename"] = top["filename"].replace(".gguf", "-Q8_0.gguf")
        held["name"] = f"{top['name']} (Q8_0)"
        held["is_downloaded"] = True
        held["is_recommended"] = False
        held["size_mb"] = int(top["size_mb"] * 1.4)
        models.insert(0, held)

    # The second pick, held at its own default quant.
    if len(recommended) > 1:
        recommended[1]["is_downloaded"] = True

    return models


def main() -> None:
    models = load_models()
    entries = with_edge_cases(load_history())
    fixtures = {
        "settings": load_settings(),
        "history": entries,
        "models": models,
        "currentModel": next(
            (m["id"] for m in models if m["is_downloaded"]), models[0]["id"]
        ),
        "storage": {
            "bytes_used": 3_140_000_000,
            "bytes_per_hour": 62_000_000,
            "hours_recorded": 50.6,
            "entry_count": 1417,
        },
        "version": "0.9.5",
    }
    OUT.write_text(json.dumps(fixtures, indent=1) + "\n")
    print(f"wrote {OUT} ({os.path.getsize(OUT) // 1024} KB, "
          f"{len(entries)} entries, {len(models)} models)")


if __name__ == "__main__":
    main()
