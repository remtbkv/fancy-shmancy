use super::{
    is_microphone_access_denied, is_no_input_device_error, run_consumer, AudioRecorder,
    CaptureClock, CaptureProcessor, CaptureTransportState, ChunkDisposition, Cmd, VadConfig,
    VadPolicy,
};
use crate::audio_toolkit::vad::{VadFrame, VoiceActivityDetector};
use rtrb::RingBuffer;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[test]
fn unopened_recorder_does_not_need_reopen() {
    let recorder = AudioRecorder::new().expect("recorder");
    assert!(!recorder.needs_reopen());
}

#[test]
fn stream_error_requires_reopen() {
    let recorder = AudioRecorder::new().expect("recorder");
    recorder.stream_error.store(true, Ordering::Relaxed);
    assert!(recorder.needs_reopen());
}

/// Pass-through detector: every frame is speech.
struct PassThroughVad;

impl VoiceActivityDetector for PassThroughVad {
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> anyhow::Result<VadFrame<'a>> {
        Ok(VadFrame::Speech(frame))
    }
}

#[test]
fn the_vad_sees_whole_30ms_frames() {
    let frame_samples = 480;
    let vad = VadConfig {
        detector: Arc::new(Mutex::new(Box::new(PassThroughVad))),
        offline_hangover_frames: 0,
        streaming_hangover_frames: 0,
    };
    let frame_lengths = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&frame_lengths);
    let mut processor = CaptureProcessor::new(
        16_000,
        Some(vad),
        None,
        Some(Arc::new(move |frame: &[f32]| {
            observed.lock().unwrap().push(frame.len())
        })),
        Instant::now(),
    );

    let (ready_tx, _ready_rx) = mpsc::channel();
    processor.begin_recording(VadPolicy::Offline, ready_tx);
    // Two whole frames and half of a third, which the stop pads out.
    processor.process_raw_chunk(&[0.0; 1200], ChunkDisposition::Capture);
    let samples = processor.finish_recording();

    assert_eq!(samples.len(), 3 * frame_samples);
    assert_eq!(*frame_lengths.lock().unwrap(), vec![frame_samples; 3]);
}

#[test]
fn idle_chunks_are_discarded_without_reaching_the_recording() {
    let mut processor = CaptureProcessor::new(16_000, None, None, None, Instant::now());
    processor.process_raw_chunk(&[1.0; 480], ChunkDisposition::Discard);
    assert!(processor.finish_recording().is_empty());
}

#[test]
fn shutdown_is_processed_without_audio_samples() {
    let (_producer, consumer) = RingBuffer::<f32>::new(48_000);
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        run_consumer(
            CaptureProcessor::new(48_000, None, None, None, Instant::now()),
            consumer,
            cmd_rx,
            Arc::new(CaptureTransportState::default()),
            Arc::new(AtomicBool::new(false)),
        );
        let _ = done_tx.send(());
    });

    cmd_tx.send(Cmd::Shutdown).expect("send shutdown");
    assert!(done_rx.recv_timeout(Duration::from_secs(1)).is_ok());
    worker.join().expect("join consumer");
}

#[test]
fn callback_writes_mono_samples() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(8);
    let transport = CaptureTransportState::default();

    AudioRecorder::write_input_to_ring(&[0.25f32, -0.5, 1.0], 1, None, &mut producer, &transport);

    let mut output = [0.0; 3];
    consumer.pop_entire_slice(&mut output).expect("samples");
    assert_eq!(output, [0.25, -0.5, 1.0]);
}

#[test]
fn callback_downmixes_or_selects_multichannel_input() {
    let transport = CaptureTransportState::default();
    let (mut average_tx, mut average_rx) = RingBuffer::<f32>::new(4);
    AudioRecorder::write_input_to_ring(
        &[1.0f32, 3.0, -1.0, 1.0],
        2,
        None,
        &mut average_tx,
        &transport,
    );
    let mut averaged = [0.0; 2];
    average_rx
        .pop_entire_slice(&mut averaged)
        .expect("averaged samples");
    assert_eq!(averaged, [2.0, 0.0]);

    let (mut selected_tx, mut selected_rx) = RingBuffer::<f32>::new(4);
    AudioRecorder::write_input_to_ring(
        &[1.0f32, 3.0, -1.0, 1.0],
        2,
        Some(1),
        &mut selected_tx,
        &transport,
    );
    let mut selected = [0.0; 2];
    selected_rx
        .pop_entire_slice(&mut selected)
        .expect("selected samples");
    assert_eq!(selected, [3.0, 1.0]);
}

#[test]
fn callback_forwards_boundary_block_then_stays_silent_until_resumed() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(8);
    let transport = CaptureTransportState::default();

    // The block in hand when a pause is first observed was captured before
    // the stop, so it is forwarded and only then acknowledged.
    transport.pause_requested.store(true, Ordering::Release);
    AudioRecorder::write_input_to_ring(&[1.0f32, 2.0], 1, None, &mut producer, &transport);
    assert!(transport.pause_acknowledged.load(Ordering::Acquire));
    assert_eq!(consumer.slots(), 2);

    // Later blocks while paused are dropped and are not counted as overruns.
    AudioRecorder::write_input_to_ring(&[3.0f32], 1, None, &mut producer, &transport);
    assert_eq!(consumer.slots(), 2);
    assert_eq!(transport.overrun_samples.load(Ordering::Relaxed), 0);

    // Clearing the pause, as the consumer does before stop() returns, resumes capture.
    transport.pause_acknowledged.store(false, Ordering::Relaxed);
    transport.pause_requested.store(false, Ordering::Release);
    AudioRecorder::write_input_to_ring(&[4.0f32], 1, None, &mut producer, &transport);
    let mut output = [0.0; 3];
    consumer.pop_entire_slice(&mut output).expect("samples");
    assert_eq!(output, [1.0, 2.0, 4.0]);
    assert!(!transport.pause_acknowledged.load(Ordering::Acquire));
}

#[test]
fn callback_partially_fills_ring_and_counts_dropped_audio() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(2);
    let transport = CaptureTransportState::default();

    AudioRecorder::write_input_to_ring(&[1.0f32, 2.0, 3.0], 1, None, &mut producer, &transport);

    let mut captured = [0.0; 2];
    consumer
        .pop_entire_slice(&mut captured)
        .expect("partial callback audio");
    assert_eq!(captured, [1.0, 2.0]);
    assert_eq!(transport.overrun_samples.load(Ordering::Relaxed), 1);
}

#[test]
fn bounded_drain_leaves_remaining_samples_for_the_next_command_cycle() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(8);
    producer
        .push_entire_slice(&[1.0, 2.0, 3.0, 4.0, 5.0])
        .expect("samples");
    let mut drained = Vec::new();

    let count =
        super::drain_available_samples(&mut consumer, 3, |part| drained.extend_from_slice(part));

    assert_eq!(count, 3);
    assert_eq!(drained, [1.0, 2.0, 3.0]);
    assert_eq!(consumer.slots(), 2);
}

#[test]
fn ring_wraparound_preserves_both_read_slices_in_order() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(5);
    let transport = CaptureTransportState::default();
    producer
        .push_entire_slice(&[1.0, 2.0, 3.0, 4.0])
        .expect("initial samples");
    let mut discarded = [0.0; 3];
    consumer
        .pop_entire_slice(&mut discarded)
        .expect("advance ring head");

    AudioRecorder::write_input_to_ring(
        &[5.0f32, 6.0, 7.0, 8.0],
        1,
        None,
        &mut producer,
        &transport,
    );

    let chunk = consumer.read_chunk(5).expect("wrapped samples");
    let (first, second) = chunk.as_slices();
    assert!(!first.is_empty());
    assert!(!second.is_empty());
    let ordered = first
        .iter()
        .chain(second.iter())
        .copied()
        .collect::<Vec<_>>();
    assert_eq!(ordered, [4.0, 5.0, 6.0, 7.0, 8.0]);
}

#[test]
fn repeated_start_stop_cycles_resume_capture_without_leaking_samples() {
    let (mut producer, consumer) = RingBuffer::<f32>::new(16_000);
    let transport = Arc::new(CaptureTransportState::default());
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let streamed = Arc::new(Mutex::new(Vec::new()));
    let streamed_cb = Arc::clone(&streamed);
    let consumer_transport = Arc::clone(&transport);
    let worker = thread::spawn(move || {
        let processor = CaptureProcessor::new(
            16_000,
            None,
            None,
            Some(Arc::new(move |frame: &[f32]| {
                streamed_cb.lock().unwrap().extend_from_slice(frame)
            })),
            Instant::now(),
        );
        run_consumer(
            processor,
            consumer,
            cmd_rx,
            consumer_transport,
            Arc::new(AtomicBool::new(false)),
        );
    });

    let wait_for_pause_request = || {
        let deadline = Instant::now() + Duration::from_secs(1);
        while !transport.pause_requested.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "pause was not requested");
            thread::sleep(Duration::from_millis(1));
        }
    };

    let first_input = [0.25f32, -0.5, 1.0];
    let (ready_tx, ready_rx) = mpsc::channel();
    cmd_tx
        .send(Cmd::Start(VadPolicy::Disabled, Instant::now(), ready_tx))
        .expect("first start");
    AudioRecorder::write_input_to_ring(&first_input, 1, None, &mut producer, &transport);
    ready_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first capture ready");

    let (reply_tx, reply_rx) = mpsc::channel();
    cmd_tx.send(Cmd::Stop(reply_tx)).expect("first stop");
    wait_for_pause_request();
    // The first callback after Stop carries audio captured before the stop,
    // so it belongs to the recording.
    AudioRecorder::write_input_to_ring(&[99.0f32], 1, None, &mut producer, &transport);

    let first_samples = reply_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first stop reply");
    let first_expected = [0.25f32, -0.5, 1.0, 99.0];
    assert_eq!(&first_samples[..first_expected.len()], &first_expected);
    assert!(first_samples[first_expected.len()..]
        .iter()
        .all(|&sample| sample == 0.0));
    assert!(!transport.pause_requested.load(Ordering::Acquire));

    let first_streamed_len = {
        let streamed = streamed.lock().unwrap();
        assert_eq!(&streamed[..first_expected.len()], &first_expected);
        streamed.len()
    };

    // Start again immediately after stop() would have returned. The producer
    // must already be re-enabled, and no first-cycle samples may leak through.
    let second_input = [0.75f32, -0.25, 0.5];
    let (ready_tx, ready_rx) = mpsc::channel();
    cmd_tx
        .send(Cmd::Start(VadPolicy::Disabled, Instant::now(), ready_tx))
        .expect("second start");
    AudioRecorder::write_input_to_ring(&second_input, 1, None, &mut producer, &transport);
    ready_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("second capture ready");

    let (reply_tx, reply_rx) = mpsc::channel();
    cmd_tx.send(Cmd::Stop(reply_tx)).expect("second stop");
    wait_for_pause_request();
    AudioRecorder::write_input_to_ring(&[199.0f32], 1, None, &mut producer, &transport);

    let second_samples = reply_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("second stop reply");
    let second_expected = [0.75f32, -0.25, 0.5, 199.0];
    assert_eq!(&second_samples[..second_expected.len()], &second_expected);
    assert!(second_samples[second_expected.len()..]
        .iter()
        .all(|&sample| sample == 0.0));
    assert!(!first_samples
        .iter()
        .any(|sample| second_expected.contains(sample)));
    assert!(!second_samples
        .iter()
        .any(|sample| first_expected.contains(sample)));
    assert!(!transport.pause_requested.load(Ordering::Acquire));

    {
        let streamed = streamed.lock().unwrap();
        assert_eq!(streamed.len(), first_streamed_len + second_samples.len());
        assert_eq!(
            &streamed[first_streamed_len..first_streamed_len + second_expected.len()],
            &second_expected
        );
    }

    cmd_tx.send(Cmd::Shutdown).expect("shutdown");
    worker.join().expect("consumer worker");
}

#[test]
fn missing_callback_at_stop_marks_stream_for_rebuild_and_returns_samples() {
    let (_producer, consumer) = RingBuffer::<f32>::new(16_000);
    let transport = Arc::new(CaptureTransportState::default());
    let stream_error = Arc::new(AtomicBool::new(false));
    let observed_error = Arc::clone(&stream_error);
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let worker_transport = Arc::clone(&transport);
    let worker = thread::spawn(move || {
        run_consumer(
            CaptureProcessor::new(16_000, None, None, None, Instant::now()),
            consumer,
            cmd_rx,
            worker_transport,
            stream_error,
        );
    });

    let (ready_tx, _ready_rx) = mpsc::channel();
    cmd_tx
        .send(Cmd::Start(VadPolicy::Disabled, Instant::now(), ready_tx))
        .expect("start");
    let (reply_tx, reply_rx) = mpsc::channel();
    cmd_tx.send(Cmd::Stop(reply_tx)).expect("stop");

    let samples = reply_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("pause timeout still returns captured samples");
    assert!(samples.is_empty());
    worker.join().expect("consumer exits after pause timeout");
    assert!(observed_error.load(Ordering::Acquire));
}

/// Drives `run_consumer` the way a live stream does: the test thread plays the
/// cpal callback, writing `block`-sample blocks of a counting ramp (1, 2, 3 …)
/// every `pace`, while the frame callback stalls once for `stall`. Returns the
/// finished recording and how many samples the callback could not fit.
fn record_ramp_through_a_stall(
    ring_samples: usize,
    blocks: usize,
    block: usize,
    pace: Duration,
    stall: Duration,
) -> (Vec<f32>, u64) {
    let (mut producer, consumer) = RingBuffer::<f32>::new(ring_samples);
    let transport = Arc::new(CaptureTransportState::default());
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let stalled = Arc::new(AtomicBool::new(false));
    let worker_transport = Arc::clone(&transport);
    let worker = thread::spawn(move || {
        let processor = CaptureProcessor::new(
            16_000,
            None,
            None,
            Some(Arc::new(move |_frame: &[f32]| {
                // One long hiccup on the consumer thread: a slow disk write
                // to the safety copy, a busy level-event channel, a page fault.
                if !stalled.swap(true, Ordering::Relaxed) {
                    thread::sleep(stall);
                }
            })),
            Instant::now(),
        );
        run_consumer(
            processor,
            consumer,
            cmd_rx,
            worker_transport,
            Arc::new(AtomicBool::new(false)),
        );
    });

    let (ready_tx, _ready_rx) = mpsc::channel();
    cmd_tx
        .send(Cmd::Start(VadPolicy::Disabled, Instant::now(), ready_tx))
        .expect("start");
    // Let the consumer take Start before the first block lands, as it does in
    // the app where Start is sent before the stream has produced much.
    thread::sleep(Duration::from_millis(20));

    let mut next = 1.0f32;
    let mut dropped = 0u64;
    let mut write_block = |producer: &mut rtrb::Producer<f32>| {
        let data: Vec<f32> = (0..block)
            .map(|_| {
                let v = next;
                next += 1.0;
                v
            })
            .collect();
        dropped += block.saturating_sub(producer.slots()) as u64;
        AudioRecorder::write_input_to_ring(&data, 1, None, producer, &transport);
    };
    for _ in 0..blocks {
        write_block(&mut producer);
        thread::sleep(pace);
    }

    let (reply_tx, reply_rx) = mpsc::channel();
    cmd_tx.send(Cmd::Stop(reply_tx)).expect("stop");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !transport.pause_requested.load(Ordering::Acquire) {
        assert!(Instant::now() < deadline, "pause was not requested");
        thread::sleep(Duration::from_millis(1));
    }
    // The block in hand when the stop lands was captured before it.
    write_block(&mut producer);
    let samples = reply_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("stop reply");
    cmd_tx.send(Cmd::Shutdown).expect("shutdown");
    worker.join().expect("consumer worker");
    (samples, dropped)
}

/// The ramp values present in a recording, with the stop's zero padding cut.
fn ramp_values(samples: &[f32]) -> Vec<u64> {
    let end = samples.iter().rposition(|&s| s != 0.0).map_or(0, |i| i + 1);
    samples[..end].iter().map(|&s| s as u64).collect()
}

#[test]
fn a_consumer_stall_the_ring_can_hold_loses_nothing() {
    // 1.5 s stall against a 2 s ring, 3 s of 10 ms blocks at 16 kHz. The old
    // channel never dropped audio either; the ring must not start to.
    let (samples, dropped) = record_ramp_through_a_stall(
        32_000,
        300,
        160,
        Duration::from_millis(10),
        Duration::from_millis(1_500),
    );
    let values = ramp_values(&samples);
    let written = 301 * 160;
    assert_eq!(dropped, 0);
    assert_eq!(values.len(), written, "every sample written must be kept");
    assert!(
        values.iter().enumerate().all(|(i, &v)| v == i as u64 + 1),
        "samples out of order or missing"
    );
    // The stop pads only the last partial 30 ms frame.
    assert!(samples.len() - values.len() < 480);
}

#[test]
fn a_stall_longer_than_the_ring_is_counted_exactly_and_the_rest_stays_in_order() {
    // 100 ms ring, 400 ms stall: audio has to be lost, and every lost sample
    // must be one the callback counted — nothing vanishes uncounted.
    let (samples, dropped) = record_ramp_through_a_stall(
        1_600,
        60,
        160,
        Duration::from_millis(10),
        Duration::from_millis(400),
    );
    let values = ramp_values(&samples);
    let written = 61 * 160;
    assert!(dropped > 0, "the stall should have overflowed the ring");
    assert_eq!(values.len() as u64 + dropped, written as u64);
    assert!(
        values.windows(2).all(|w| w[0] < w[1]),
        "reordered or repeated"
    );
}

#[test]
fn device_clock_sees_back_to_back_blocks_as_whole() {
    let transport = CaptureTransportState::default();
    let mut clock = CaptureClock::new(48_000);
    // 512 frames at 48 kHz = 10.666 ms per block, with sub-block jitter.
    let mut t_ns: i64 = 1_000_000_000;
    for i in 0..200 {
        let jitter = if i % 2 == 0 { 300_000 } else { -300_000 };
        clock.observe(instant(t_ns + jitter), 512, &transport);
        t_ns += 10_666_667;
    }
    assert_eq!(transport.take_device_gaps(), (0, 0));
}

#[test]
fn device_clock_counts_a_skipped_block_and_its_length() {
    let transport = CaptureTransportState::default();
    let mut clock = CaptureClock::new(48_000);
    let block_ns = 10_666_667;
    let mut t_ns: i64 = 1_000_000_000;
    for i in 0..20 {
        if i == 10 {
            // The audio thread missed a cycle: the next block starts one block late.
            t_ns += block_ns;
        }
        clock.observe(instant(t_ns), 512, &transport);
        t_ns += block_ns;
    }
    let (gaps, micros) = transport.take_device_gaps();
    assert_eq!(gaps, 1);
    assert!((10_600..=10_700).contains(&micros), "gap was {micros} µs");
    // Reading clears the tally for the next recording.
    assert_eq!(transport.take_device_gaps(), (0, 0));
}

fn instant(ns: i64) -> cpal::StreamInstant {
    cpal::StreamInstant::new(ns / 1_000_000_000, (ns % 1_000_000_000) as u32)
}

#[test]
fn level_events_carry_loudness_and_the_raw_voice_verdict() {
    // The overlay's flow bar reads two values past the 16 spectrum buckets.
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let mut processor = CaptureProcessor::new(
        16_000,
        None,
        Some(Arc::new(move |levels: Vec<f32>| {
            sink.lock().unwrap().push(levels)
        })),
        None,
        Instant::now(),
    );
    let (ready_tx, _ready_rx) = mpsc::channel();
    processor.begin_recording(VadPolicy::Disabled, ready_tx);
    let tone: Vec<f32> = (0..4_800).map(|i| 0.5 * (i as f32 * 0.2).sin()).collect();
    processor.process_raw_chunk(&tone, ChunkDisposition::Capture);

    let events = events.lock().unwrap();
    assert!(!events.is_empty(), "no level events for 300 ms of tone");
    for levels in events.iter() {
        assert_eq!(levels.len(), 18);
        assert!(
            levels[16] > -20.0 && levels[16] < 0.0,
            "dBFS {}",
            levels[16]
        );
        assert_eq!(levels[17], 1.0, "no VAD attached counts as voiced");
    }
}

#[test]
fn detects_access_is_denied() {
    assert!(is_microphone_access_denied("Access is denied"));
}

#[test]
fn detects_permission_denied() {
    assert!(is_microphone_access_denied("permission denied"));
}

#[test]
fn detects_windows_error_code() {
    assert!(is_microphone_access_denied("WASAPI error: 0x80070005"));
}

#[test]
fn does_not_match_unrelated_errors() {
    assert!(!is_microphone_access_denied("device not found"));
}

#[test]
fn detects_no_input_device() {
    assert!(is_no_input_device_error("No input device found"));
}

#[test]
fn detects_coreaudio_config_error() {
    assert!(is_no_input_device_error(
        "Failed to fetch preferred config: A backend-specific error has occurred: An unknown error unknown to the coreaudio-rs API occurred"
    ));
}

#[test]
fn does_not_match_other_errors_for_no_device() {
    assert!(!is_no_input_device_error("permission denied"));
    assert!(!is_no_input_device_error("device not found"));
}
