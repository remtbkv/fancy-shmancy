# Fancy Shmancy
(claude slop + some of my interjections)

Hold a key, talk, and the words land wherever your cursor is. Everything runs on your own machine — audio never leaves it.

This is a fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais, an open-source offline speech-to-text app. Handy does the heavy lifting — local Whisper/Parakeet-family transcription, voice activity detection, global shortcuts, cross-platform packaging — and this fork reshapes it around heavy daily dictation on macOS.

## What's different from Handy

- **Push-to-talk first.** Hold Right Option to record (this is my default but use anything, I just can't use the left Fn button), release to paste. Double-tap locks the mic on until you tap again.
- **Better? recording bar.** The level meter rides a learned noise floor and a dynamic range derived from your own recording history, so it moves when you speak — quietly or in a loud café — and stays flat when you don't. It re-tunes itself as your history grows. Although I don't think it really changed much however claude might as well do this if it's "better".
- **No lost recordings.** Audio is spooled to disk while you talk. A crash, force-quit, or update mid-sentence leaves a playable recording that shows up in History on the next launch, and Escape cancels the paste but keeps the audio (for those accidents).
- **Terminals get typed into, not pasted.** A configurable per-app list (terminals and Claude by default) pastes incrementally so you don't get a [Pasted text #1 +144 lines] block, rather seeing the full text.
- **Music pauses only when the mic would hear it.** Playing through speakers pauses for the recording; headphones keep playing.
- **Recordings capped by size.** One number in gigabytes (default 5 GB, roughly 43 hours of audio), oldest dropped first, with the current usage shown next to it. The recordings folder is yours to choose.

Windows and Linux builds inherit upstream's support but this fork is only exercised on macOS.

## Install

Download the `.dmg` from [Releases](https://github.com/remtbkv/fancy-shmancy/releases), open it, and drag the app to Applications.

It isn't notarized by Apple, so macOS refuses to launch it the first time. Clear the flag macOS puts on downloaded files:

```bash
xattr -dr com.apple.quarantine "/Applications/Fancy Shmancy.app"
```

Or, without a terminal: open it, let the refusal appear, then go to System Settings → Privacy & Security, scroll to the bottom, and click Open Anyway. Every launch after that is normal.

To build it yourself instead, run `scripts/build-macos.sh`. It looks for Rust and Bun and, if they're missing, installs them inside the checkout rather than your home directory — `rm -rf .toolchain` when you're done and the machine is as it was. Pass `--local` to ignore a system toolchain you'd rather leave alone.

The first launch downloads a transcription model (the app has its own downloader — nothing else to install) and asks for microphone and accessibility permissions.

Platform-specific build details are in [BUILD.md](BUILD.md); for Linux quirks and troubleshooting, upstream's [README](https://github.com/cjpais/Handy#readme) applies.

## Credits and license

MIT, same as upstream — see [LICENSE](LICENSE). Handy is copyright CJ Pais; the Handy name, logo, and brand assets are upstream's and are not used here, per their branding terms.

Built on [transcribe.cpp](https://github.com/cjpais/transcribe.cpp) and ggml by Georgi Gerganov and contributors, [Silero VAD](https://github.com/snakers4/silero-vad), and [Tauri](https://tauri.app). Transcription models are downloaded on first run from Hugging Face and carry their own licenses (the recommended ones are Apache-2.0 and CC-BY-4.0).
