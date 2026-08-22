# Fancy Shmancy

Hold a key, talk, and the words land wherever your cursor is. Everything runs on your own machine — audio never leaves it.

This is a fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais, an open-source offline speech-to-text app. Handy does the heavy lifting — local Whisper/Parakeet-family transcription, voice activity detection, global shortcuts, cross-platform packaging — and this fork reshapes it around heavy daily dictation on macOS.

## What's different from Handy

- **Push-to-talk first.** Hold Right Option to record, release to paste. Double-tap locks the mic on until you tap again.
- **A recording bar that answers speech, not the room.** The level meter rides a learned noise floor and a dynamic range derived from your own recording history, so it moves when you speak — quietly or in a loud café — and stays flat when you don't. It re-tunes itself as your history grows.
- **No lost takes.** Audio is spooled to disk while you talk. A crash, force-quit, or update mid-sentence leaves a playable recording that shows up in History on the next launch, and Escape cancels the paste but keeps the audio.
- **Terminals get typed into, not pasted.** A configurable per-app list (terminals and Claude by default) receives keystrokes instead of a paste, and very long pastes route through the clipboard so the target app doesn't choke.
- **Music pauses only when the mic would hear it.** Playing through speakers pauses for the recording; headphones keep playing.
- **Recordings are capped by size, not age.** One number in gigabytes (default 5 GB, roughly 43 hours of audio), oldest dropped first, with the current usage shown next to it. The recordings folder is yours to choose.
- **A short model list up front.** Onboarding offers a few strong English models instead of the full zoo; the complete catalog is still in Settings.

Windows and Linux builds inherit upstream's support but this fork is only exercised on macOS.

## Install

There are no signed releases yet, so it's a build from source:

1. Install [Rust](https://rustup.rs/) and [Bun](https://bun.sh/).
2. `bun install`
3. `bun run tauri build --bundles app`
4. The app lands in `src-tauri/target/release/bundle/macos/`. Drag it to Applications.

The first launch downloads a transcription model (the app has its own downloader — nothing else to install) and asks for microphone and accessibility permissions. If you received a pre-built copy instead, macOS will block the unsigned app the first time: right-click it, choose Open, and confirm. Every launch after that is normal.

Platform-specific build details are in [BUILD.md](BUILD.md); for Linux quirks and troubleshooting, upstream's [README](https://github.com/cjpais/Handy#readme) applies.

## Credits and license

MIT, same as upstream — see [LICENSE](LICENSE). Handy is copyright CJ Pais; the Handy name, logo, and brand assets are upstream's and are not used here, per their branding terms.

Built on [transcribe.cpp](https://github.com/cjpais/transcribe.cpp) and ggml by Georgi Gerganov and contributors, [Silero VAD](https://github.com/snakers4/silero-vad), and [Tauri](https://tauri.app). Transcription models are downloaded on first run from Hugging Face and carry their own licenses (the recommended ones are Apache-2.0 and CC-BY-4.0).
