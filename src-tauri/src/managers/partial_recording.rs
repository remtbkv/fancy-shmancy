//! A recording that survives the app dying mid-sentence.
//!
//! Every other path that keeps audio — stop, cancel — needs the process to
//! still be alive to write the file. A crash, a `kill`, or a rebuild that
//! replaces the bundle underneath a live recording takes the whole take with
//! it, and the take is the only copy of what was said.
//!
//! So frames are written to a `.partial.wav` as they arrive, with the RIFF
//! sizes rewritten roughly twice a second. Whatever the process was killed
//! mid-way through, the file on disk is a playable WAV of everything up to the
//! last rewrite. On the next launch those orphans are adopted into history.

use anyhow::{Context, Result};
use log::{debug, error, info};
use std::fs::{self, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Files carry this suffix while they are still being written to.
const PARTIAL_SUFFIX: &str = ".partial.wav";
/// Header sizes are rewritten after this much audio, bounding how much a hard
/// kill can cost to half a second.
const REWRITE_EVERY_SAMPLES: usize = 8_000; // 0.5s at 16 kHz
/// Below this a recovered file is a stray tap rather than a take.
const MIN_KEEP_SAMPLES: usize = 12_000; // 0.75s at 16 kHz

const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const BITS: u16 = 16;
const HEADER_BYTES: u32 = 44;

struct Writer {
    file: BufWriter<File>,
    path: PathBuf,
    samples: usize,
    since_rewrite: usize,
}

impl Writer {
    fn create(path: PathBuf) -> Result<Self> {
        let file = File::create(&path).with_context(|| format!("create {path:?}"))?;
        let mut w = Writer {
            file: BufWriter::new(file),
            path,
            samples: 0,
            since_rewrite: 0,
        };
        w.write_header()?;
        w.file.flush()?;
        Ok(w)
    }

    /// A 44-byte canonical PCM header. Sizes are for whatever has been written
    /// so far, so the file is valid at every point it gets rewritten.
    fn write_header(&mut self) -> Result<()> {
        let data_bytes = (self.samples * 2) as u32;
        let byte_rate = SAMPLE_RATE * u32::from(CHANNELS) * u32::from(BITS) / 8;
        let block_align = CHANNELS * BITS / 8;

        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(b"RIFF")?;
        self.file
            .write_all(&(HEADER_BYTES - 8 + data_bytes).to_le_bytes())?;
        self.file.write_all(b"WAVEfmt ")?;
        self.file.write_all(&16u32.to_le_bytes())?;
        self.file.write_all(&1u16.to_le_bytes())?; // PCM
        self.file.write_all(&CHANNELS.to_le_bytes())?;
        self.file.write_all(&SAMPLE_RATE.to_le_bytes())?;
        self.file.write_all(&byte_rate.to_le_bytes())?;
        self.file.write_all(&block_align.to_le_bytes())?;
        self.file.write_all(&BITS.to_le_bytes())?;
        self.file.write_all(b"data")?;
        self.file.write_all(&data_bytes.to_le_bytes())?;
        Ok(())
    }

    fn feed(&mut self, frame: &[f32]) -> Result<()> {
        self.file.seek(SeekFrom::Start(
            u64::from(HEADER_BYTES) + (self.samples as u64) * 2,
        ))?;
        for sample in frame {
            let value = (sample * f32::from(i16::MAX)) as i16;
            self.file.write_all(&value.to_le_bytes())?;
        }
        self.samples += frame.len();
        self.since_rewrite += frame.len();

        if self.since_rewrite >= REWRITE_EVERY_SAMPLES {
            self.since_rewrite = 0;
            self.file.flush()?;
            self.write_header()?;
            self.file.flush()?;
        }
        Ok(())
    }
}

/// Where recordings live. Kept here so the recorder can open its safety copy
/// without depending on the history manager being constructed first.
pub fn recordings_dir(app: &tauri::AppHandle) -> PathBuf {
    crate::portable::app_data_dir(app)
        .map(|d| d.join("recordings"))
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// The in-flight recording's safety copy. One per app.
pub struct PartialRecording {
    dir: PathBuf,
    writer: Mutex<Option<Writer>>,
}

impl PartialRecording {
    pub fn new(dir: PathBuf) -> Self {
        PartialRecording {
            dir,
            writer: Mutex::new(None),
        }
    }

    /// Open a fresh safety copy. Any previous one is dropped: a recording that
    /// starts while another is still open means the earlier one already ended
    /// by a path that should have closed it.
    pub fn begin(&self, timestamp: i64) {
        let path = self.dir.join(format!("handy-{timestamp}{PARTIAL_SUFFIX}"));
        match Writer::create(path.clone()) {
            Ok(w) => {
                debug!("Safety copy open at {path:?}");
                *self.writer.lock().unwrap() = Some(w);
            }
            Err(e) => error!("Could not open a safety copy for this recording: {e:#}"),
        }
    }

    pub fn feed(&self, frame: &[f32]) {
        let mut guard = self.writer.lock().unwrap();
        if let Some(w) = guard.as_mut() {
            if let Err(e) = w.feed(frame) {
                error!("Safety copy stopped accepting audio: {e:#}");
                *guard = None;
            }
        }
    }

    /// The recording ended through a path that already kept (or deliberately
    /// dropped) the audio, so the safety copy has done its job.
    pub fn discard(&self) {
        let Some(w) = self.writer.lock().unwrap().take() else {
            return;
        };
        let path = w.path.clone();
        drop(w);
        if let Err(e) = fs::remove_file(&path) {
            debug!("Could not remove the safety copy {path:?}: {e}");
        }
    }

    /// Adopt safety copies left behind by a process that never got to finish.
    /// Returns the final file names, already renamed out of `.partial`.
    pub fn recover_orphans(dir: &Path) -> Vec<String> {
        let mut recovered = Vec::new();
        let Ok(entries) = fs::read_dir(dir) else {
            return recovered;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.ends_with(PARTIAL_SUFFIX) {
                continue;
            }
            let samples = fs::metadata(&path)
                .map(|m| m.len().saturating_sub(u64::from(HEADER_BYTES)) / 2)
                .unwrap_or(0) as usize;
            if samples < MIN_KEEP_SAMPLES {
                debug!("Dropping a {samples}-sample safety copy: too short to be a take");
                let _ = fs::remove_file(&path);
                continue;
            }
            let final_name = name.replace(PARTIAL_SUFFIX, ".wav");
            let final_path = dir.join(&final_name);
            match fs::rename(&path, &final_path) {
                Ok(()) => {
                    info!("Recovered a recording the app never got to finish: {final_name}");
                    recovered.push(final_name);
                }
                Err(e) => error!("Could not recover {path:?}: {e}"),
            }
        }
        recovered
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn read_u32(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    /// The whole point: a file abandoned mid-recording still has to be a WAV
    /// whose header describes the audio actually on disk, or every player and
    /// the transcriber itself will refuse it.
    #[test]
    fn an_abandoned_file_is_still_a_valid_wav() {
        let dir = std::env::temp_dir().join(format!("handy-partial-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let partial = PartialRecording::new(dir.clone());
        partial.begin(42);

        // Two rewrites' worth of audio, then walk away without closing.
        let frame = vec![0.5f32; 4_000];
        for _ in 0..5 {
            partial.feed(&frame);
        }
        std::mem::forget(partial);

        let path = dir.join("handy-42.partial.wav");
        let mut bytes = Vec::new();
        File::open(&path).unwrap().read_to_end(&mut bytes).unwrap();

        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        let data_len = read_u32(&bytes, 40) as usize;
        assert!(data_len > 0, "header claims no audio");
        assert_eq!(
            read_u32(&bytes, 4) as usize,
            HEADER_BYTES as usize - 8 + data_len,
            "RIFF size must agree with the data chunk"
        );
        assert!(
            bytes.len() >= HEADER_BYTES as usize + data_len,
            "header claims more audio than the file holds"
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// A stray tap is not a take, and adopting those would bury the recordings
    /// worth recovering.
    #[test]
    fn recovery_keeps_real_takes_and_drops_taps() {
        let dir = std::env::temp_dir().join(format!("handy-recover-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let long = PartialRecording::new(dir.clone());
        long.begin(1);
        long.feed(&vec![0.1f32; MIN_KEEP_SAMPLES + 1_000]);
        std::mem::forget(long);

        let short = PartialRecording::new(dir.clone());
        short.begin(2);
        short.feed(&vec![0.1f32; 1_000]);
        std::mem::forget(short);

        let recovered = PartialRecording::recover_orphans(&dir);
        assert_eq!(recovered, vec!["handy-1.wav".to_string()]);
        assert!(!dir.join("handy-2.partial.wav").exists());

        fs::remove_dir_all(&dir).ok();
    }
}
