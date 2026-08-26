//! Keeps the microphone from listening to your own music.
//!
//! When a recording starts and sound is coming out of the laptop speakers, we
//! pause whatever is playing and start it again when the recording ends. On
//! headphones nothing is touched: the microphone cannot hear them, so pausing
//! would only be a nuisance.
//!
//! Only players that can be asked what they are doing get paused — Spotify and
//! Music, over AppleScript. Everything else is left alone, and that is a
//! deliberate limit rather than an omission. The only thing macOS tells an
//! ordinary app about another app's audio is whether it holds an open output
//! stream, which stays true for seconds after playback stops (Chrome: about four
//! and a half) and indefinitely for some players (QuickTime, for as long as a
//! document is open). Playing and paused therefore look identical from outside,
//! so the one tool that reaches those apps — the play/pause media key — is a
//! blind toggle that could just as easily *start* music in the middle of a
//! recording. Any app with a readable play state can be added to [`Player`];
//! guessing cannot.

use crate::settings::get_settings;
use log::{debug, warn};
use once_cell::sync::Lazy;
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// How often to check on an AppleScript we are waiting for.
const SCRIPT_POLL: Duration = Duration::from_millis(50);
/// AppleScript talks to another app over Apple events, which can sit waiting on
/// a permission prompt. Nothing here is worth blocking the resume behind.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(5);

/// A process CoreAudio knows about, and whether it is feeding the output device
/// right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioProcess {
    pub pid: i32,
    pub bundle_id: String,
    pub outputting: bool,
}

/// A player that reports its own play state, and takes an explicit pause.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Player {
    Spotify,
    Music,
}

impl Player {
    /// A player's audio does not always come out of the process named after it:
    /// Spotify hands playback to `com.spotify.client.helper` at least some of
    /// the time, and a helper answers the same media key its parent does. So a
    /// bundle id that is a known player's id, or a child of it, is that player.
    /// `com.google.Chrome.helper` still matches nothing, which is the point —
    /// the parent is unknown, so the child stays unknown too.
    fn from_bundle_id(bundle_id: &str) -> Option<Self> {
        [Self::Spotify, Self::Music].into_iter().find(|player| {
            let known = [player.bundle_id()]
                .into_iter()
                .chain(player.legacy_bundle_ids().iter().copied());
            known.into_iter().any(|id| {
                bundle_id == id
                    || bundle_id
                        .strip_prefix(id)
                        .is_some_and(|rest| rest.starts_with('.'))
            })
        })
    }

    /// Ids the same player has shipped under.
    fn legacy_bundle_ids(self) -> &'static [&'static str] {
        match self {
            Self::Spotify => &[],
            Self::Music => &["com.apple.iTunes"],
        }
    }

    fn bundle_id(self) -> &'static str {
        match self {
            Self::Spotify => "com.spotify.client",
            Self::Music => "com.apple.Music",
        }
    }
}

/// `'bltn'` — the transport the laptop's own speakers report. AirPods and any
/// other Bluetooth or USB device report something else.
const BUILT_IN_TRANSPORT: u32 = 0x626c_746e;
/// `'hdpn'` — what the built-in output reports as its data source when something
/// is plugged into the headphone jack. Wired headphones are as private as
/// AirPods, and the transport stays "built-in" for both, so this is the only
/// thing that tells them apart.
const HEADPHONE_DATA_SOURCE: u32 = 0x6864_706e;

/// Whether sound leaving the machine is audible in the room — and so audible to
/// the microphone. A data source we couldn't read is treated as speakers: the
/// built-in transport with nothing plugged in is the common case by far.
fn in_the_room(transport: u32, data_source: Option<u32>) -> bool {
    transport == BUILT_IN_TRANSPORT
        && data_source.is_none_or(|source| source != HEADPHONE_DATA_SOURCE)
}

/// Our own sounds — the start and stop chimes, and history playback — are not
/// something to pause ourselves over.
fn is_ours(process: &AudioProcess, own_pid: i32) -> bool {
    process.pid == own_pid || process.bundle_id.starts_with("com.pais.handy")
}

/// The players worth asking about, given who is feeding the speakers. A player
/// can be making noise through more than one process; it only needs telling
/// once.
fn players_making_noise(processes: &[AudioProcess], own_pid: i32) -> Vec<Player> {
    let mut players = Vec::new();
    for process in processes
        .iter()
        .filter(|p| p.outputting && !is_ours(p, own_pid))
    {
        match Player::from_bundle_id(&process.bundle_id) {
            Some(player) if !players.contains(&player) => players.push(player),
            Some(_) => {}
            None => debug!(
                "Leaving {} alone: no way to tell whether it is really playing",
                process.bundle_id
            ),
        }
    }
    players
}

enum Job {
    Pause(AppHandle),
    Resume,
}

/// One worker thread, so a pause and the resume that follows it can never run
/// out of order or at the same time — a recording can be over before the pause
/// has finished.
static JOBS: Lazy<Sender<Job>> = Lazy::new(|| {
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::Builder::new()
        .name("media-control".into())
        .spawn(move || {
            let mut paused: Vec<Player> = Vec::new();
            for job in rx {
                match job {
                    Job::Pause(app) if paused.is_empty() => paused = pause_now(&app),
                    Job::Pause(_) => {}
                    Job::Resume => {
                        for player in paused.drain(..) {
                            resume_player(player);
                        }
                    }
                }
            }
        })
        .expect("failed to spawn the media-control thread");
    tx
});

pub fn pause_for_recording(app: &AppHandle) {
    let _ = JOBS.send(Job::Pause(app.clone()));
}

pub fn resume_after_recording() {
    let _ = JOBS.send(Job::Resume);
}

fn pause_now(app: &AppHandle) -> Vec<Player> {
    if !get_settings(app).pause_playback_while_recording {
        return Vec::new();
    }
    if !output_is_in_the_room() {
        debug!("Playback left alone: the output is not the built-in speakers");
        return Vec::new();
    }

    let players = players_making_noise(&audio_processes(), std::process::id() as i32);
    let paused: Vec<Player> = players
        .into_iter()
        .filter(|player| pause_player(*player))
        .collect();
    if !paused.is_empty() {
        debug!("Paused {paused:?} for the recording");
    }
    paused
}

/// Pauses a player only if it is actually playing, and says whether it did. A
/// player whose stream is still open after the user stopped it themselves
/// answers "no" here, which is how a recording avoids starting music that was
/// meant to be off.
fn pause_player(player: Player) -> bool {
    let script = format!(
        r#"tell application id "{}"
            if player state is playing then
                pause
                return "paused"
            end if
        end tell
        return "no""#,
        player.bundle_id()
    );
    match run_script(&script) {
        Some(output) => output.trim() == "paused",
        None => {
            warn!("Could not ask {player:?} to pause");
            false
        }
    }
}

/// The mirror image: start it again unless the user already did.
fn resume_player(player: Player) {
    let script = format!(
        r#"tell application id "{}"
            if player state is not playing then play
        end tell"#,
        player.bundle_id()
    );
    if run_script(&script).is_none() {
        warn!("Could not resume {player:?} after the recording");
    }
}

/// Runs an AppleScript, giving up rather than blocking forever on a permission
/// prompt. `None` means it failed or timed out.
fn run_script(script: &str) -> Option<String> {
    let mut child = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| warn!("Could not run osascript: {e}"))
        .ok()?;

    let deadline = Instant::now() + SCRIPT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().ok()?;
                if !status.success() {
                    debug!(
                        "AppleScript failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    );
                    return None;
                }
                return Some(String::from_utf8_lossy(&output.stdout).into_owned());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(SCRIPT_POLL),
            Ok(None) => {
                warn!("AppleScript timed out; killing it");
                let _ = child.kill();
                return None;
            }
            Err(e) => {
                warn!("Could not wait on osascript: {e}");
                return None;
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod system {
    use super::AudioProcess;
    use objc2_core_audio::{
        kAudioDevicePropertyDataSource, kAudioDevicePropertyTransportType,
        kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyProcessObjectList,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyScopeOutput, kAudioObjectSystemObject, kAudioProcessPropertyBundleID,
        kAudioProcessPropertyIsRunningOutput, kAudioProcessPropertyPID, AudioObjectGetPropertyData,
        AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress,
    };
    use objc2_core_foundation::{CFRetained, CFString};
    use std::ffi::c_void;
    use std::ptr::NonNull;

    fn address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    fn read_u32(object: AudioObjectID, selector: u32, scope: u32) -> Option<u32> {
        let mut address = address(selector, scope);
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: every pointer is to a live local, and the buffer is exactly
        // the size the property is declared to be.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                NonNull::from(&mut address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut value).cast::<c_void>(),
            )
        };
        (status == 0).then_some(value)
    }

    fn read_object_list(object: AudioObjectID, selector: u32) -> Vec<AudioObjectID> {
        let mut address = address(selector, kAudioObjectPropertyScopeGlobal);
        let mut size = 0u32;
        // SAFETY: as above; this call only writes the byte count.
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                object,
                NonNull::from(&mut address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
            )
        };
        let count = size as usize / std::mem::size_of::<AudioObjectID>();
        if status != 0 || count == 0 {
            return Vec::new();
        }

        let mut ids = vec![0 as AudioObjectID; count];
        // SAFETY: `size` still describes the buffer we just allocated for it.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                NonNull::from(&mut address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::new(ids.as_mut_ptr())
                    .expect("a Vec's pointer is never null")
                    .cast::<c_void>(),
            )
        };
        if status != 0 {
            return Vec::new();
        }
        ids.truncate(size as usize / std::mem::size_of::<AudioObjectID>());
        ids
    }

    fn read_string(object: AudioObjectID, selector: u32) -> Option<String> {
        let mut address = address(selector, kAudioObjectPropertyScopeGlobal);
        let mut value: *const CFString = std::ptr::null();
        let mut size = std::mem::size_of::<*const CFString>() as u32;
        // SAFETY: the property is documented to write one CFStringRef, which is
        // what `value` is sized and typed for.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                NonNull::from(&mut address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut value).cast::<c_void>(),
            )
        };
        if status != 0 {
            return None;
        }
        let pointer = NonNull::new(value.cast_mut())?;
        // SAFETY: CoreAudio hands back a +1 reference for this property, so
        // taking ownership here is what releases it.
        let string = unsafe { CFRetained::from_raw(pointer) };
        Some(string.to_string())
    }

    /// Reads where the sound is going right now and asks [`super::in_the_room`]
    /// what that means.
    pub fn output_is_in_the_room() -> bool {
        let Some(device) = read_u32(
            kAudioObjectSystemObject as AudioObjectID,
            kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal,
        ) else {
            return false;
        };
        let Some(transport) = read_u32(
            device,
            kAudioDevicePropertyTransportType,
            kAudioObjectPropertyScopeGlobal,
        ) else {
            return false;
        };
        super::in_the_room(
            transport,
            read_u32(
                device,
                kAudioDevicePropertyDataSource,
                kAudioObjectPropertyScopeOutput,
            ),
        )
    }

    pub fn audio_processes() -> Vec<AudioProcess> {
        read_object_list(
            kAudioObjectSystemObject as AudioObjectID,
            kAudioHardwarePropertyProcessObjectList,
        )
        .into_iter()
        .filter_map(|object| {
            Some(AudioProcess {
                pid: read_u32(
                    object,
                    kAudioProcessPropertyPID,
                    kAudioObjectPropertyScopeGlobal,
                )? as i32,
                bundle_id: read_string(object, kAudioProcessPropertyBundleID).unwrap_or_default(),
                outputting: read_u32(
                    object,
                    kAudioProcessPropertyIsRunningOutput,
                    kAudioObjectPropertyScopeGlobal,
                )
                .is_some_and(|running| running != 0),
            })
        })
        .collect()
    }

    /// Apple's own value for the built-in transport, checked against the one
    /// [`super::in_the_room`] compares with.
    #[cfg(test)]
    pub const APPLE_BUILT_IN_TRANSPORT: u32 = objc2_core_audio::kAudioDeviceTransportTypeBuiltIn;
}

/// Elsewhere there is no per-process audio to inspect, so nothing is ever
/// paused: an empty process list leaves nothing to pause.
#[cfg(not(target_os = "macos"))]
mod system {
    use super::AudioProcess;

    pub fn output_is_in_the_room() -> bool {
        false
    }

    pub fn audio_processes() -> Vec<AudioProcess> {
        Vec::new()
    }
}

use system::{audio_processes, output_is_in_the_room};

#[cfg(test)]
mod tests {
    use super::*;

    /// `'ispk'` and `'blue'` — the speaker data source, and the transport a pair
    /// of AirPods comes in on.
    const SPEAKER_DATA_SOURCE: u32 = 0x6973_706b;
    const BLUETOOTH_TRANSPORT: u32 = 0x626c_7565;

    fn process(pid: i32, bundle_id: &str, outputting: bool) -> AudioProcess {
        AudioProcess {
            pid,
            bundle_id: bundle_id.to_string(),
            outputting,
        }
    }

    #[test]
    fn only_the_laptop_speakers_count_as_the_room() {
        assert!(in_the_room(BUILT_IN_TRANSPORT, Some(SPEAKER_DATA_SOURCE)));
        assert!(in_the_room(BUILT_IN_TRANSPORT, None));
        // AirPods, and the built-in headphone jack, which keeps the built-in
        // transport and only changes its data source.
        assert!(!in_the_room(BLUETOOTH_TRANSPORT, None));
        assert!(!in_the_room(
            BUILT_IN_TRANSPORT,
            Some(HEADPHONE_DATA_SOURCE)
        ));
    }

    /// The four-character codes above are written out by hand, so they are worth
    /// checking against the ones CoreAudio ships.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_built_in_transport_code_is_apples() {
        assert_eq!(BUILT_IN_TRANSPORT, system::APPLE_BUILT_IN_TRANSPORT);
    }

    #[test]
    fn silence_means_nothing_to_pause() {
        let processes = vec![
            process(1, "com.spotify.client", false),
            process(2, "com.google.Chrome.helper", false),
        ];
        assert!(players_making_noise(&processes, 99).is_empty());
    }

    #[test]
    fn a_player_that_is_playing_gets_asked_to_stop() {
        let processes = vec![
            process(1, "com.spotify.client", true),
            process(2, "com.apple.Music", true),
        ];
        assert_eq!(
            players_making_noise(&processes, 99),
            vec![Player::Spotify, Player::Music]
        );
    }

    /// One player, several audio processes: asking twice would be a second
    /// AppleScript round trip for nothing.
    #[test]
    fn a_player_is_only_listed_once() {
        let processes = vec![
            process(1, "com.spotify.client", true),
            process(2, "com.spotify.client", true),
        ];
        assert_eq!(players_making_noise(&processes, 99), vec![Player::Spotify]);
    }

    /// A browser tab or a video player cannot be read, and a blind media-key
    /// toggle at one could start audio rather than stop it.
    #[test]
    fn an_app_we_cannot_read_is_left_alone() {
        let processes = vec![
            process(11, "com.google.Chrome.helper", true),
            process(12, "com.apple.QuickTimePlayerX", true),
        ];
        assert!(players_making_noise(&processes, 99).is_empty());
    }

    /// Spotify moves playback into a helper process mid-session — observed on
    /// 2026-08-25, where the music paused at 21:36 and then stopped pausing at
    /// 21:41 with nothing changed but the bundle id emitting the audio.
    #[test]
    fn a_players_helper_process_is_still_that_player() {
        let processes = vec![process(21, "com.spotify.client.helper", true)];
        assert_eq!(players_making_noise(&processes, 99), vec![Player::Spotify]);

        let renderers = vec![process(22, "com.apple.Music.helper.renderer", true)];
        assert_eq!(players_making_noise(&renderers, 99), vec![Player::Music]);
    }

    /// The prefix must be a whole id, not a string prefix: a different app whose
    /// name merely begins the same way is not the player.
    #[test]
    fn a_lookalike_bundle_id_is_not_the_player() {
        let processes = vec![
            process(31, "com.spotify.clientele", true),
            process(32, "com.apple.MusicMagpie", true),
        ];
        assert!(players_making_noise(&processes, 99).is_empty());
    }

    #[test]
    fn our_own_sounds_are_not_something_to_pause() {
        let processes = vec![
            process(99, "com.pais.handy", true),
            process(100, "com.pais.handy", true),
        ];
        assert!(players_making_noise(&processes, 99).is_empty());
    }
}
