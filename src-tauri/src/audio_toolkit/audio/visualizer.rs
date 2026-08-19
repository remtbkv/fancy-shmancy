use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;

// `db` below is not true dBFS: it's a per-bin average divided by the FFT
// window size, which lands ~20 dB low for speech. So this window is calibrated
// against measured mic audio (dictation ~-32 dBFS, room tone ~-48 dBFS) rather
// than absolute dBFS. The old -55/-8 left speech ~1 px above the overlay's
// floor, which reads as a frozen waveform (#1694). Not lowered past -68: at
// -70 a noisy room starts making the idle waveform twitch.
/// What an all-zero window reports, so a dropout is distinguishable from quiet.
pub const DBFS_SILENT: f32 = -200.0;

const DB_MIN: f32 = -68.0;
const DB_MAX: f32 = -30.0;
const GAIN: f32 = 1.3;
const CURVE_POWER: f32 = 0.7;

pub struct AudioVisualiser {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    bucket_ranges: Vec<(usize, usize)>,
    fft_input: Vec<Complex32>,
    noise_floor: Vec<f32>,
    buffer: Vec<f32>,
    window_size: usize,
    buckets: usize,
    /// RMS of the most recent analysed window, in dBFS. The overlay's flow bar
    /// wants a single loudness in dB rather than the perceptual bucket values,
    /// because it calibrates itself against a running noise floor and the
    /// buckets are already clamped and curve-shaped.
    last_dbfs: f32,
}

impl AudioVisualiser {
    pub fn new(
        sample_rate: u32,
        window_size: usize,
        buckets: usize,
        freq_min: f32,
        freq_max: f32,
    ) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(window_size);

        // Pre-compute Hann window
        let window: Vec<f32> = (0..window_size)
            .map(|i| {
                0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / window_size as f32).cos())
            })
            .collect();

        // Pre-compute bucket frequency ranges
        let nyquist = sample_rate as f32 / 2.0;
        let freq_min = freq_min.min(nyquist);
        let freq_max = freq_max.min(nyquist);

        let mut bucket_ranges = Vec::with_capacity(buckets);

        for b in 0..buckets {
            // Use logarithmic spacing for better perceptual representation
            let log_start = (b as f32 / buckets as f32).powi(2);
            let log_end = ((b + 1) as f32 / buckets as f32).powi(2);

            let start_hz = freq_min + (freq_max - freq_min) * log_start;
            let end_hz = freq_min + (freq_max - freq_min) * log_end;

            let start_bin = ((start_hz * window_size as f32) / sample_rate as f32) as usize;
            let mut end_bin = ((end_hz * window_size as f32) / sample_rate as f32) as usize;

            // Ensure each bucket has at least one bin
            if end_bin <= start_bin {
                end_bin = start_bin + 1;
            }

            // Clamp to valid range
            let start_bin = start_bin.min(window_size / 2);
            let end_bin = end_bin.min(window_size / 2);

            bucket_ranges.push((start_bin, end_bin));
        }

        Self {
            fft,
            window,
            bucket_ranges,
            fft_input: vec![Complex32::new(0.0, 0.0); window_size],
            noise_floor: vec![-40.0; buckets], // Initialize to reasonable noise floor
            buffer: Vec::with_capacity(window_size * 2),
            window_size,
            buckets,
            last_dbfs: DBFS_SILENT,
        }
    }

    pub fn feed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        // Add new samples to buffer
        self.buffer.extend_from_slice(samples);

        // Only process if we have enough samples
        if self.buffer.len() < self.window_size {
            return None;
        }

        // Take the required window of samples
        let window_samples = &self.buffer[..self.window_size];

        // Loudness of this window, before any windowing or bucketing.
        let mean_square =
            window_samples.iter().map(|s| s * s).sum::<f32>() / self.window_size as f32;
        self.last_dbfs = 20.0 * (mean_square.sqrt() + 1e-10).log10();

        // Remove DC component
        let mean = window_samples.iter().sum::<f32>() / self.window_size as f32;

        // Apply window function and prepare FFT input
        for (i, &sample) in window_samples.iter().enumerate() {
            let windowed_sample = (sample - mean) * self.window[i];
            self.fft_input[i] = Complex32::new(windowed_sample, 0.0);
        }

        // Perform FFT
        self.fft.process(&mut self.fft_input);

        // Compute power spectrum and bucket levels
        let mut buckets = vec![0.0; self.buckets];

        for (bucket_idx, &(start_bin, end_bin)) in self.bucket_ranges.iter().enumerate() {
            if start_bin >= end_bin || end_bin > self.fft_input.len() / 2 {
                continue;
            }

            // Calculate average power in this frequency range
            let mut power_sum = 0.0;
            for bin_idx in start_bin..end_bin {
                let magnitude = self.fft_input[bin_idx].norm();
                power_sum += magnitude * magnitude;
            }

            let avg_power = power_sum / (end_bin - start_bin) as f32;

            // Convert to dB with proper scaling
            let db = if avg_power > 1e-12 {
                20.0 * (avg_power.sqrt() / self.window_size as f32).log10()
            } else {
                -80.0 // Very low floor for zero power
            };

            // Only update noise floor when signal is quiet (below current floor + 10dB)
            if db < self.noise_floor[bucket_idx] + 10.0 {
                const NOISE_ALPHA: f32 = 0.001; // Very slow adaptation
                self.noise_floor[bucket_idx] =
                    NOISE_ALPHA * db + (1.0 - NOISE_ALPHA) * self.noise_floor[bucket_idx];
            }

            // Map configurable dB range to 0-1 with gain and curve shaping
            let normalized = ((db - DB_MIN) / (DB_MAX - DB_MIN)).clamp(0.0, 1.0);
            buckets[bucket_idx] = (normalized * GAIN).powf(CURVE_POWER).clamp(0.0, 1.0);
        }

        // Apply light smoothing to reduce jitter
        for i in 1..buckets.len() - 1 {
            buckets[i] = buckets[i] * 0.7 + buckets[i - 1] * 0.15 + buckets[i + 1] * 0.15;
        }

        // Clear processed samples from buffer
        self.buffer.clear();

        Some(buckets)
    }

    /// RMS of the last analysed window in dBFS, or `DBFS_SILENT` before the
    /// first full window.
    pub fn last_dbfs(&self) -> f32 {
        self.last_dbfs
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
        // Reset noise floor to initial values
        self.noise_floor.fill(-40.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viz() -> AudioVisualiser {
        AudioVisualiser::new(16_000, 512, 16, 400.0, 4000.0)
    }

    /// The overlay's flow bar reads this instead of the buckets, so it has to be
    /// a real dBFS figure: full scale is 0 dB, and halving the amplitude costs
    /// 6 dB. The buckets are clamped to a 38 dB window and curve-shaped, which
    /// is why they can't stand in for it.
    #[test]
    fn last_dbfs_reports_window_rms_in_dbfs() {
        let mut v = viz();
        let full_scale: Vec<f32> = (0..512).map(|_| 1.0).collect();
        v.feed(&full_scale).expect("a full window produces buckets");
        assert!(
            v.last_dbfs().abs() < 0.01,
            "full-scale DC should read 0 dBFS, got {}",
            v.last_dbfs()
        );

        let half: Vec<f32> = (0..512).map(|_| 0.5).collect();
        v.feed(&half).unwrap();
        assert!(
            (v.last_dbfs() + 6.02).abs() < 0.05,
            "half amplitude should read about -6 dBFS, got {}",
            v.last_dbfs()
        );
    }

    /// A dropout has to stay distinguishable from a quiet room, or the flow
    /// bar's floor latches onto it and every later pause reads as speech.
    #[test]
    fn digital_silence_reads_far_below_any_room_tone() {
        let mut v = viz();
        v.feed(&vec![0.0f32; 512]).unwrap();
        assert!(
            v.last_dbfs() <= DBFS_SILENT,
            "silence should be at or below {DBFS_SILENT} dBFS, got {}",
            v.last_dbfs()
        );
    }
}
