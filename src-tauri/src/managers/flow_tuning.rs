//! Teaching the flow bar what this particular voice sounds like against this
//! particular room.
//!
//! The bar reads a level as how far above the room floor a window sits, over a
//! span. That span is learned live within a second or two, but the value it
//! *starts* from is a guess — and Wispr's guess of 20 dB is wrong for anyone
//! whose rooms are noisier than theirs. Measured over 915 of Rem's recordings
//! the gap between his quiet frames and his speech has a median of 12.4 dB, and
//! a fixed 20 filled the bar in 13.7% of them.
//!
//! So the starting span is derived from the recordings on this machine rather
//! than shipped as a constant. It costs about 2ms a recording, and the result is
//! cached per file, so a re-tune only reads what is new.

use anyhow::Result;
use log::{debug, info};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Frame length for the level measurement, matching the visualiser's window at
/// 16 kHz so the numbers describe what the bar actually sees.
const FRAME: usize = 512;
/// Under this many frames a recording says nothing about a room.
const MIN_FRAMES: usize = 60;
/// Bounds on the derived span, from the corpus: 90% of recordings have more
/// contrast than the lower bound and all of them less than the upper.
const SPAN_MIN_DB: f64 = 8.0;
const SPAN_MAX_DB: f64 = 24.0;
/// Re-tune once this much new audio has accumulated. Below this the median
/// barely moves — two weeks of Rem's audio drifted 0.8 dB — so re-deriving more
/// often would just be spending I/O to arrive at the same number.
pub const RETUNE_EVERY_HOURS: f64 = 2.0;

#[derive(Default, Serialize, Deserialize)]
struct Cache {
    /// file name -> its contrast in dB, so a re-tune only reads new recordings.
    contrasts: HashMap<String, f64>,
    /// Hours of audio the last tune was derived from.
    tuned_at_hours: f64,
}

fn cache_path(dir: &Path) -> PathBuf {
    dir.join("flow-tuning.json")
}

fn load(dir: &Path) -> Cache {
    std::fs::read_to_string(cache_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The gap between this recording's quiet frames and its speech, in dB, or
/// `None` when it is too short to say.
fn contrast_db(path: &Path) -> Option<f64> {
    let mut reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != 16_000 {
        return None;
    }
    let samples: Vec<f32> = reader
        .samples::<i16>()
        .filter_map(|s| s.ok())
        .map(|s| f32::from(s) / 32768.0)
        .collect();
    let frames = samples.len() / FRAME;
    if frames < MIN_FRAMES {
        return None;
    }
    let mut dbs: Vec<f64> = Vec::with_capacity(frames);
    for f in 0..frames {
        let chunk = &samples[f * FRAME..(f + 1) * FRAME];
        let mean_square = chunk
            .iter()
            .map(|s| f64::from(*s) * f64::from(*s))
            .sum::<f64>()
            / FRAME as f64;
        let db = 20.0 * (mean_square.sqrt() + 1e-10).log10();
        if db > -90.0 {
            dbs.push(db);
        }
    }
    if dbs.len() < MIN_FRAMES {
        return None;
    }
    dbs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(percentile(&dbs, 0.90) - percentile(&dbs, 0.10))
}

/// Nearest-rank percentile of an already-sorted slice.
fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[idx]
}

/// Hours of audio in the folder, from file sizes: 16 kHz mono 16-bit is 32000
/// bytes a second, so this costs a stat per file rather than a read.
pub fn hours_of_audio(dir: &Path) -> f64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0.0;
    };
    entries
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len().saturating_sub(44) as f64 / 32_000.0)
        .sum::<f64>()
        / 3600.0
}

/// True when enough new audio has arrived to be worth re-deriving the span.
pub fn is_due(dir: &Path) -> bool {
    let cache = load(dir);
    if cache.contrasts.is_empty() {
        return true;
    }
    hours_of_audio(dir) - cache.tuned_at_hours >= RETUNE_EVERY_HOURS
}

/// Re-derive the starting span from the recordings in `dir`, reading only what
/// is not already cached. Returns the span in dB, or `None` when there is not
/// enough audio to beat the shipped default.
pub fn retune(dir: &Path) -> Result<Option<f64>> {
    let mut cache = load(dir);
    let mut present = Vec::new();
    let mut added = 0usize;

    for entry in std::fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if !name.ends_with(".wav") || name.ends_with(".partial.wav") {
            continue;
        }
        present.push(name.clone());
        if !cache.contrasts.contains_key(&name) {
            if let Some(c) = contrast_db(&path) {
                cache.contrasts.insert(name, c);
                added += 1;
            }
        }
    }
    // Forget recordings the storage cap has since deleted.
    cache.contrasts.retain(|name, _| present.contains(name));

    let mut values: Vec<f64> = cache.contrasts.values().copied().collect();
    if values.len() < 20 {
        debug!(
            "flow tuning: only {} usable recordings, keeping the shipped span",
            values.len()
        );
        return Ok(None);
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = percentile(&values, 0.50);
    // Err narrow. A span that starts too wide makes the bar flat, which is what
    // anyone notices; too narrow makes it briefly eager and the live span
    // corrects it the moment they speak.
    let span = (median - 2.0).clamp(SPAN_MIN_DB, SPAN_MAX_DB);

    cache.tuned_at_hours = hours_of_audio(dir);
    if let Ok(json) = serde_json::to_string_pretty(&cache) {
        let _ = std::fs::write(cache_path(dir), json);
    }
    info!(
        "flow tuning: {} recordings ({} newly read), median contrast {:.1} dB -> starting span {:.0} dB",
        values.len(),
        added,
        median,
        span
    );
    Ok(Some(span))
}
