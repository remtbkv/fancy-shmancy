//! Suppressing a steady noise — a laptop fan, a fridge, air conditioning — that
//! sits underneath dictation.
//!
//! The method is ordinary Wiener-style spectral suppression: estimate the noise
//! spectrum from the quietest frames, then attenuate each bin by how much of it
//! looks like noise. What is not ordinary is the band limit, and it is the whole
//! point of this module.
//!
//! Measured on two recordings made on a MacBook's built-in microphone with the
//! fans audible, suppression across the full spectrum does this:
//!
//! | band       | SNR gained | speech lost |
//! | ---------- | ---------- | ----------- |
//! | 300-600Hz  | +5.7..+7.5 | 0.3..0.9 dB |
//! | 600-1200   | +4.7..+7.7 | 1.7..2.9    |
//! | 1200-2400  | +3.3..+5.6 | 2.5..3.5    |
//! | 2400-4000  | +0.4..+2.6 | 4.9..7.3    |
//! | 4000-8000  | -4.7..-7.3 | 8.1..11.7   |
//!
//! Above 2400 Hz the voice was already below the fan, so subtraction removes
//! more speech than noise and the ratio gets worse — it cannot recover what the
//! microphone never captured. So the suppression is confined to the range where
//! it is a clean win and the rest is passed through untouched.

/// STFT window. 32ms at 16 kHz, matching the visualiser's frame so the two
/// describe the same thing.
const FRAME: usize = 512;
const HOP: usize = FRAME / 2;
/// The band where suppression earns its keep, in Hz.
const BAND_LO_HZ: f64 = 300.0;
const BAND_HI_HZ: f64 = 2400.0;
/// Fraction of the frames, quietest first, taken to be noise. A dictation is
/// mostly speech, so this stays small.
const NOISE_QUANTILE: f64 = 0.25;
/// How hard to subtract. Above 1.0 removes more than the estimate, which buys
/// SNR at the cost of speech; 1.0 is the honest setting.
const OVERSUBTRACT: f64 = 1.0;
/// Never attenuate a bin past this. A hard zero is what produces the warbling
/// "musical noise" that makes suppression audible and confuses a transcriber.
const GAIN_FLOOR: f64 = 0.1;
/// Below this many frames there is nothing to estimate from.
const MIN_FRAMES: usize = 8;

fn hann(n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos())
        .collect()
}

/// Naive DFT of one real frame, returning the half spectrum. `FRAME` is 512 and
/// a dictation is seconds long, so the O(n²) cost is a few milliseconds and not
/// worth a dependency to avoid.
fn rfft(frame: &[f64]) -> Vec<(f64, f64)> {
    let n = frame.len();
    let bins = n / 2 + 1;
    let mut out = Vec::with_capacity(bins);
    for k in 0..bins {
        let (mut re, mut im) = (0.0, 0.0);
        for (t, x) in frame.iter().enumerate() {
            let ang = -2.0 * std::f64::consts::PI * (k * t) as f64 / n as f64;
            re += x * ang.cos();
            im += x * ang.sin();
        }
        out.push((re, im));
    }
    out
}

/// Inverse of [`rfft`], reconstructing the real frame.
fn irfft(spec: &[(f64, f64)], n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n];
    for (t, o) in out.iter_mut().enumerate() {
        let mut acc = 0.0;
        for (k, (re, im)) in spec.iter().enumerate() {
            let ang = 2.0 * std::f64::consts::PI * (k * t) as f64 / n as f64;
            // Bins between DC and Nyquist stand for a conjugate pair.
            let weight = if k == 0 || (n % 2 == 0 && k == n / 2) {
                1.0
            } else {
                2.0
            };
            acc += weight * (re * ang.cos() - im * ang.sin());
        }
        *o = acc / n as f64;
    }
    out
}

/// Attenuate steady noise between 300 and 2400 Hz, leaving everything else as
/// it was. Returns the input unchanged when there is too little audio to
/// estimate a noise floor from.
pub fn suppress_steady_noise(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if samples.len() < FRAME * MIN_FRAMES {
        return samples.to_vec();
    }
    let window = hann(FRAME);
    let n_frames = (samples.len() - FRAME) / HOP + 1;
    if n_frames < MIN_FRAMES {
        return samples.to_vec();
    }

    // Analyse.
    let mut spectra: Vec<Vec<(f64, f64)>> = Vec::with_capacity(n_frames);
    let mut energies: Vec<f64> = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let frame: Vec<f64> = (0..FRAME)
            .map(|i| f64::from(samples[f * HOP + i]) * window[i])
            .collect();
        let spec = rfft(&frame);
        energies.push(spec.iter().map(|(re, im)| re * re + im * im).sum());
        spectra.push(spec);
    }

    // The quietest frames are the room.
    let mut sorted = energies.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let cutoff = sorted[((sorted.len() - 1) as f64 * NOISE_QUANTILE) as usize];
    let bins = FRAME / 2 + 1;
    let mut noise = vec![0.0f64; bins];
    let mut counted = 0usize;
    for (spec, energy) in spectra.iter().zip(&energies) {
        if *energy <= cutoff {
            counted += 1;
            for (b, (re, im)) in spec.iter().enumerate() {
                noise[b] += re * re + im * im;
            }
        }
    }
    if counted == 0 {
        return samples.to_vec();
    }
    for n in noise.iter_mut() {
        *n /= counted as f64;
    }

    // Which bins fall in the band worth touching.
    let bin_hz = f64::from(sample_rate) / FRAME as f64;
    let in_band: Vec<bool> = (0..bins)
        .map(|b| {
            let hz = b as f64 * bin_hz;
            (BAND_LO_HZ..=BAND_HI_HZ).contains(&hz)
        })
        .collect();

    // Suppress, then overlap-add back.
    let mut acc = vec![0.0f64; samples.len() + FRAME];
    let mut norm = vec![0.0f64; samples.len() + FRAME];
    for (f, spec) in spectra.iter().enumerate() {
        let cleaned: Vec<(f64, f64)> = spec
            .iter()
            .enumerate()
            .map(|(b, (re, im))| {
                if !in_band[b] {
                    return (*re, *im);
                }
                let power = re * re + im * im;
                let gain = (1.0 - OVERSUBTRACT * noise[b] / (power + 1e-20)).max(GAIN_FLOOR);
                (re * gain, im * gain)
            })
            .collect();
        let frame = irfft(&cleaned, FRAME);
        for i in 0..FRAME {
            acc[f * HOP + i] += frame[i] * window[i];
            norm[f * HOP + i] += window[i] * window[i];
        }
    }
    (0..samples.len())
        .map(|i| {
            let d = norm[i];
            let v = if d > 1e-8 {
                acc[i] / d
            } else {
                f64::from(samples[i])
            };
            v.clamp(-1.0, 1.0) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, secs: f64, amp: f64, sr: u32) -> Vec<f32> {
        let n = (secs * f64::from(sr)) as usize;
        (0..n)
            .map(|i| {
                (amp * (2.0 * std::f64::consts::PI * freq * i as f64 / f64::from(sr)).sin()) as f32
            })
            .collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|s| f64::from(*s) * f64::from(*s)).sum::<f64>() / x.len() as f64).sqrt()
    }

    /// The point of the band limit: a 6 kHz component must come out untouched,
    /// because up there suppression costs more speech than it removes noise.
    #[test]
    fn content_outside_the_band_is_left_alone() {
        let sr = 16_000;
        let input = tone(6000.0, 1.0, 0.3, sr);
        let out = suppress_steady_noise(&input, sr);
        let ratio = rms(&out) / rms(&input);
        assert!(
            ratio > 0.9,
            "6 kHz content should survive, kept {:.2} of it",
            ratio
        );
    }

    /// And inside the band, a steady tone with nothing else present reads as
    /// noise and is pulled down.
    #[test]
    fn a_steady_tone_inside_the_band_is_suppressed() {
        let sr = 16_000;
        let input = tone(1000.0, 1.0, 0.3, sr);
        let out = suppress_steady_noise(&input, sr);
        let ratio = rms(&out) / rms(&input);
        assert!(
            ratio < 0.6,
            "a steady 1 kHz tone should be attenuated, kept {:.2} of it",
            ratio
        );
    }

    /// Too little audio to estimate from must pass through rather than guess.
    #[test]
    fn a_clip_too_short_to_measure_is_returned_unchanged() {
        let input = tone(1000.0, 0.05, 0.3, 16_000);
        assert_eq!(suppress_steady_noise(&input, 16_000), input);
    }
}
