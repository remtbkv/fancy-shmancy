//! Abandons a push-to-talk recording when the hold turns out to be text editing.
//!
//! A modifier that doubles as a push-to-talk shortcut — right Option, say — is
//! also half of Option+Delete and Option+Arrow. Holding it to delete a word
//! would otherwise open the microphone, show the overlay and paste whatever it
//! heard. While the shortcut is held, this guard watches for the keys that only
//! ever mean editing and throws the recording away when one arrives.
//!
//! The watcher is a second, listen-only keyboard tap. It cannot use the
//! registered-hotkey path: those are blocked from reaching other applications,
//! and Delete has to keep deleting.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use handy_keys::{Key, KeyboardListener};
use log::{debug, info, warn};
use once_cell::sync::Lazy;
use tauri::AppHandle;

use crate::settings::AppSettings;

/// How long the watcher waits for a key before re-checking whether it should
/// still be running.
const POLL_TIMEOUT: Duration = Duration::from_millis(200);

struct GuardState {
    /// Keys that abandon the recording, parsed once when the guard is armed.
    /// Empty means disarmed — nothing is watched for.
    cancel_keys: Mutex<Vec<Key>>,
    armed: AtomicBool,
    /// Set while a watcher thread is alive; cleared to ask it to stop.
    running: Arc<AtomicBool>,
    started: AtomicBool,
}

static GUARD: Lazy<GuardState> = Lazy::new(|| GuardState {
    cancel_keys: Mutex::new(Vec::new()),
    armed: AtomicBool::new(false),
    running: Arc::new(AtomicBool::new(false)),
    started: AtomicBool::new(false),
});

/// Parse the configured key names, dropping any the key parser doesn't know
/// rather than failing the whole guard over one typo in the settings file.
fn parse_cancel_keys(names: &[String]) -> Vec<Key> {
    let mut keys = Vec::with_capacity(names.len());
    for name in names {
        match name.trim().parse::<Key>() {
            Ok(key) if !keys.contains(&key) => keys.push(key),
            Ok(_) => {}
            Err(e) => warn!("Ignoring unknown editing-cancel key '{}': {}", name, e),
        }
    }
    keys
}

/// How long the visible and audible parts of a recording are held back so a
/// hold that turns out to be Option+Delete leaves nothing on screen. Zero when
/// the guard cannot cancel this recording anyway — a hands-free or scripted
/// start has no held shortcut to reinterpret, so it shows up at once.
pub fn quiet_start_ms(settings: &AppSettings) -> u64 {
    if is_enabled(settings) && GUARD.armed.load(Ordering::SeqCst) {
        settings.editing_cancel_grace_ms
    } else {
        0
    }
}

/// The guard only applies to a shortcut that is physically held: in toggle mode
/// the key is long since up, and arrows then mean ordinary navigation.
fn is_enabled(settings: &AppSettings) -> bool {
    settings.cancel_on_editing_keys && settings.push_to_talk
}

/// Start (or stop) the watcher to match the current setting. Safe to call
/// repeatedly — at startup and whenever the setting changes.
pub fn sync(app: &AppHandle, settings: &AppSettings) {
    if settings.cancel_on_editing_keys {
        start(app);
    } else {
        stop();
    }
}

fn start(app: &AppHandle) {
    if GUARD.started.swap(true, Ordering::SeqCst) {
        return;
    }

    let listener = match KeyboardListener::new() {
        Ok(listener) => listener,
        Err(e) => {
            warn!(
                "Editing-key guard disabled: could not open a keyboard listener ({}). \
                 Push-to-talk will not be cancelled by Delete or the arrow keys.",
                e
            );
            GUARD.started.store(false, Ordering::SeqCst);
            return;
        }
    };

    GUARD.running.store(true, Ordering::SeqCst);
    let running = Arc::clone(&GUARD.running);
    let app = app.clone();

    thread::spawn(move || {
        info!("Editing-key guard watching for cancels");
        while running.load(Ordering::SeqCst) {
            let Ok(event) = listener.recv_timeout(POLL_TIMEOUT) else {
                continue;
            };

            if !event.is_key_down || !GUARD.armed.load(Ordering::SeqCst) {
                continue;
            }
            let Some(key) = event.key else {
                continue;
            };

            let is_cancel_key = GUARD
                .cancel_keys
                .lock()
                .map(|keys| keys.contains(&key))
                .unwrap_or(false);

            if is_cancel_key {
                disarm();
                debug!(
                    "{} pressed during a held shortcut — dropping the recording",
                    key
                );
                crate::utils::cancel_current_operation_from(
                    &app,
                    "editing key pressed while the shortcut was held",
                );
            }
        }
        GUARD.started.store(false, Ordering::SeqCst);
        info!("Editing-key guard stopped");
    });
}

fn stop() {
    disarm();
    GUARD.running.store(false, Ordering::SeqCst);
}

/// Start watching: the shortcut is down and the recording it began can still
/// turn out to have been an editing chord.
pub fn arm(settings: &AppSettings) {
    if !is_enabled(settings) {
        return;
    }

    let keys = parse_cancel_keys(&settings.editing_cancel_keys);
    if keys.is_empty() {
        return;
    }

    if let Ok(mut slot) = GUARD.cancel_keys.lock() {
        *slot = keys;
    }
    GUARD.armed.store(true, Ordering::SeqCst);
}

/// Watch again after a release that turned out to be key auto-repeat: the
/// shortcut never actually came up. Reuses the keys parsed when the hold
/// began, so it costs nothing to call on every repeat.
pub fn rearm() {
    let has_keys = GUARD
        .cancel_keys
        .lock()
        .map(|keys| !keys.is_empty())
        .unwrap_or(false);
    if has_keys {
        GUARD.armed.store(true, Ordering::SeqCst);
    }
}

/// Stop watching: the shortcut came up, latched hands-free, or the recording
/// already ended. From here on an arrow key is just an arrow key.
pub fn disarm() {
    GUARD.armed.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(enabled: bool, push_to_talk: bool, grace_ms: u64) -> AppSettings {
        let mut settings = crate::settings::get_default_settings();
        settings.cancel_on_editing_keys = enabled;
        settings.push_to_talk = push_to_talk;
        settings.editing_cancel_grace_ms = grace_ms;
        settings
    }

    #[test]
    fn default_cancel_keys_all_parse() {
        let settings = crate::settings::get_default_settings();
        let keys = parse_cancel_keys(&settings.editing_cancel_keys);
        assert_eq!(
            keys.len(),
            settings.editing_cancel_keys.len(),
            "every shipped editing-cancel key must be a key handy-keys knows"
        );
        assert!(keys.contains(&Key::Delete));
        assert!(keys.contains(&Key::LeftArrow));
        assert!(keys.contains(&Key::RightArrow));
        assert!(keys.contains(&Key::UpArrow));
        assert!(keys.contains(&Key::DownArrow));
    }

    #[test]
    fn unknown_key_names_are_dropped_not_fatal() {
        let keys = parse_cancel_keys(&[
            "backspace".to_string(),
            "not-a-key".to_string(),
            "left".to_string(),
        ]);
        assert_eq!(keys, vec![Key::Delete, Key::LeftArrow]);
    }

    #[test]
    fn duplicate_key_names_are_collapsed() {
        let keys = parse_cancel_keys(&[
            "backspace".to_string(),
            "delete".to_string(),
            "Backspace".to_string(),
        ]);
        assert_eq!(keys, vec![Key::Delete]);
    }

    #[test]
    fn toggle_mode_never_arms_the_guard() {
        assert!(!is_enabled(&settings_with(true, false, 400)));
        assert_eq!(quiet_start_ms(&settings_with(true, false, 400)), 0);
    }

    /// Only a recording the guard could still throw away waits before showing
    /// itself. A hands-free start arms nothing, so its overlay is immediate.
    #[test]
    fn quiet_start_only_applies_while_the_guard_is_live() {
        let settings = settings_with(true, true, 400);

        disarm();
        assert_eq!(quiet_start_ms(&settings), 0);

        arm(&settings);
        assert_eq!(quiet_start_ms(&settings), 400);
        assert_eq!(quiet_start_ms(&settings_with(false, true, 400)), 0);

        disarm();
    }
}
