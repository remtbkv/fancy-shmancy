use enigo::{Enigo, Key, Keyboard, Mouse, Settings};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
mod macos {
    use super::Key;
    use log::{debug, warn};
    use std::ffi::c_void;

    type TisInputSourceRef = *const c_void;
    type CfDataRef = *const c_void;
    type CfStringRef = *const c_void;

    // kVK_ANSI_V. This is the behavior Handy used before layout-aware
    // resolution and remains the safest fallback if macOS cannot expose the
    // active layout.
    const ANSI_V_KEYCODE: u16 = 9;
    const KEYCODE_COUNT: u16 = 128;
    const UC_KEY_ACTION_DISPLAY: u16 = 3;
    const UC_KEY_TRANSLATE_NO_DEAD_KEYS_MASK: u32 = 1;
    // Carbon's cmdKey is bit 8. UCKeyTranslate expects Carbon modifiers shifted
    // right by 8, so Command is represented by bit 0 here.
    const COMMAND_MODIFIER_STATE: u32 = 1;

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn TISCopyCurrentKeyboardLayoutInputSource() -> TisInputSourceRef;
        fn TISGetInputSourceProperty(
            input_source: TisInputSourceRef,
            property_key: CfStringRef,
        ) -> CfDataRef;
        static kTISPropertyUnicodeKeyLayoutData: CfStringRef;
        fn UCKeyTranslate(
            key_layout: *const u8,
            virtual_key_code: u16,
            key_action: u16,
            modifier_key_state: u32,
            keyboard_type: u32,
            key_translate_options: u32,
            dead_key_state: *mut u32,
            max_string_length: usize,
            actual_string_length: *mut usize,
            unicode_string: *mut u16,
        ) -> i32;
        fn LMGetKbdType() -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDataGetBytePtr(data: CfDataRef) -> *const u8;
        fn CFRelease(value: *const c_void);
    }

    struct InputSource(TisInputSourceRef);

    impl Drop for InputSource {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: TISCopyCurrentKeyboardLayoutInputSource returned this
                // retained reference, so this balances that ownership.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn find_keycode(mut matches: impl FnMut(u16) -> bool) -> Option<u16> {
        (0..KEYCODE_COUNT).find(|&keycode| matches(keycode))
    }

    /// Resolves the physical key that macOS interprets as `v` while Command is
    /// held. Including Command is important: non-Latin layouts commonly map
    /// Cmd shortcuts to their ANSI equivalents, while standard Dvorak does not.
    ///
    /// TIS APIs must run on the main thread. Handy's paste path already enters
    /// through `AppHandle::run_on_main_thread` before reaching this function.
    fn resolve_command_v_keycode() -> Result<u16, String> {
        // SAFETY: This function is called on the macOS main thread. The returned
        // source follows the Create Rule and is released by InputSource::drop.
        let source = InputSource(unsafe { TISCopyCurrentKeyboardLayoutInputSource() });
        if source.0.is_null() {
            return Err("macOS returned no current keyboard layout input source".into());
        }

        // SAFETY: The source remains retained for the duration of the scan and
        // the property constant is provided by Carbon.
        let layout_data =
            unsafe { TISGetInputSourceProperty(source.0, kTISPropertyUnicodeKeyLayoutData) };
        if layout_data.is_null() {
            return Err("current macOS keyboard layout has no Unicode layout data".into());
        }

        // SAFETY: layout_data is a CFData owned by the retained input source and
        // remains valid until source is dropped after the scan.
        let layout = unsafe { CFDataGetBytePtr(layout_data) };
        if layout.is_null() {
            return Err("current macOS keyboard layout data is empty".into());
        }

        // SAFETY: LMGetKbdType has no arguments and returns the current physical
        // keyboard type used by UCKeyTranslate.
        let keyboard_type = unsafe { LMGetKbdType() } as u32;
        let keycode = find_keycode(|keycode| {
            let mut dead_key_state = 0;
            let mut chars = [0_u16; 4];
            let mut length = 0_usize;

            // SAFETY: layout points to valid UCKeyboardLayout bytes while source
            // is retained. All output pointers reference initialized local
            // storage of the declared sizes.
            let status = unsafe {
                UCKeyTranslate(
                    layout,
                    keycode,
                    UC_KEY_ACTION_DISPLAY,
                    COMMAND_MODIFIER_STATE,
                    keyboard_type,
                    UC_KEY_TRANSLATE_NO_DEAD_KEYS_MASK,
                    &mut dead_key_state,
                    chars.len(),
                    &mut length,
                    chars.as_mut_ptr(),
                )
            };

            status == 0 && length == 1 && chars[0] == u16::from(b'v')
        })
        .ok_or_else(|| "could not map Cmd+V in the current macOS keyboard layout".to_string())?;

        Ok(keycode)
    }

    pub(super) fn command_v_key() -> Key {
        match resolve_command_v_keycode() {
            Ok(keycode) => {
                debug!("Resolved Cmd+V for the active macOS layout to keycode {keycode}");
                Key::Other(u32::from(keycode))
            }
            Err(error) => {
                warn!(
                    "Could not resolve Cmd+V for the active macOS layout ({error}); using ANSI V keycode {ANSI_V_KEYCODE}"
                );
                Key::Other(u32::from(ANSI_V_KEYCODE))
            }
        }
    }
}

/// Wrapper for Enigo to store in Tauri's managed state.
/// Enigo is wrapped in a Mutex since it requires mutable access.
pub struct EnigoState(pub Mutex<Enigo>);

impl EnigoState {
    pub fn new() -> Result<Self, String> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Failed to initialize Enigo: {}", e))?;
        Ok(Self(Mutex::new(enigo)))
    }
}

/// Get the current mouse cursor position using the managed Enigo instance.
/// Returns None if the state is not available or if getting the location fails.
pub fn get_cursor_position(app_handle: &AppHandle) -> Option<(i32, i32)> {
    let enigo_state = app_handle.try_state::<EnigoState>()?;
    let enigo = enigo_state.0.lock().ok()?;
    enigo.location().ok()
}

/// Sends a Ctrl+V or Cmd+V paste command using platform-specific virtual key codes.
/// This ensures the paste works regardless of keyboard layout (e.g., Russian, AZERTY, DVORAK).
/// Note: On Wayland, this may not work - callers should check for Wayland and use alternative methods.
///
/// `hold_ms` is how long the modifier stays held after the V click before being
/// released. Most applications read the modifier from the V event's flags and
/// need no hold at all, but applications that poll global keyboard state when
/// handling the key need the modifier to still be down — the hold insures
/// against those. Callers that can detect a failed chord (e.g. the
/// receipt-sequenced paste path) may use a much shorter hold.
pub fn send_paste_ctrl_v(enigo: &mut Enigo, hold_ms: u64) -> Result<(), String> {
    // Platform-specific key definitions
    #[cfg(target_os = "macos")]
    let (modifier_key, v_key_code) = (Key::Meta, macos::command_v_key());
    #[cfg(target_os = "windows")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Other(0x56)); // VK_V
    #[cfg(target_os = "linux")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Unicode('v'));

    // Press modifier + V
    enigo
        .key(modifier_key, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {}", e))?;
    enigo
        .key(v_key_code, enigo::Direction::Click)
        .map_err(|e| format!("Failed to click V key: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(hold_ms));

    enigo
        .key(modifier_key, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    Ok(())
}

/// Sends a Ctrl+Shift+V paste command.
/// This is commonly used in terminal applications on Linux to paste without formatting.
/// Note: On Wayland, this may not work - callers should check for Wayland and use alternative methods.
pub fn send_paste_ctrl_shift_v(enigo: &mut Enigo, hold_ms: u64) -> Result<(), String> {
    // Platform-specific key definitions
    #[cfg(target_os = "macos")]
    let (modifier_key, v_key_code) = (Key::Meta, macos::command_v_key());
    #[cfg(target_os = "windows")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Other(0x56)); // VK_V
    #[cfg(target_os = "linux")]
    let (modifier_key, v_key_code) = (Key::Control, Key::Unicode('v'));

    // Press Ctrl/Cmd + Shift + V
    enigo
        .key(modifier_key, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {}", e))?;
    enigo
        .key(Key::Shift, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press Shift key: {}", e))?;
    enigo
        .key(v_key_code, enigo::Direction::Click)
        .map_err(|e| format!("Failed to click V key: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(hold_ms));

    enigo
        .key(Key::Shift, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release Shift key: {}", e))?;
    enigo
        .key(modifier_key, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    Ok(())
}

/// Sends a Shift+Insert paste command (Windows and Linux only).
/// This is more universal for terminal applications and legacy software.
/// Note: On Wayland, this may not work - callers should check for Wayland and use alternative methods.
pub fn send_paste_shift_insert(enigo: &mut Enigo, hold_ms: u64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let insert_key_code = Key::Other(0x2D); // VK_INSERT
    #[cfg(not(target_os = "windows"))]
    let insert_key_code = Key::Other(0x76); // XK_Insert (keycode 118 / 0x76, also used as fallback)

    // Press Shift + Insert
    enigo
        .key(Key::Shift, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press Shift key: {}", e))?;
    enigo
        .key(insert_key_code, enigo::Direction::Click)
        .map_err(|e| format!("Failed to click Insert key: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(hold_ms));

    enigo
        .key(Key::Shift, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release Shift key: {}", e))?;

    Ok(())
}

/// Replay a hotkey chord to whatever is in front, so a shortcut the app
/// intercepted can still do what it would have done. Used when
/// paste-last-transcript has nothing recent enough to paste and has to hand
/// the keystroke back.
///
/// The chord uses the same names as stored bindings ("command+shift+v").
pub fn send_chord(enigo: &mut Enigo, chord: &str) -> Result<(), String> {
    let (modifiers, key) = parse_chord(chord)?;

    for modifier in &modifiers {
        enigo
            .key(*modifier, enigo::Direction::Press)
            .map_err(|e| format!("Failed to press modifier for '{}': {}", chord, e))?;
    }

    let result = enigo
        .key(key, enigo::Direction::Click)
        .map_err(|e| format!("Failed to send key for '{}': {}", chord, e));

    std::thread::sleep(std::time::Duration::from_millis(50));

    for modifier in modifiers.iter().rev() {
        enigo
            .key(*modifier, enigo::Direction::Release)
            .map_err(|e| format!("Failed to release modifier for '{}': {}", chord, e))?;
    }

    result
}

/// Split a stored binding into the modifiers to hold and the one key to strike.
/// Chords with no strikable key — a bare modifier or a mouse button — cannot be
/// replayed and report that rather than sending something half-right.
fn parse_chord(chord: &str) -> Result<(Vec<Key>, Key), String> {
    let mut modifiers = Vec::new();
    let mut key = None;

    for raw in chord.split('+') {
        let part = raw.trim().to_lowercase();
        // Bindings can name a side ("option_right"); either one presses the
        // same modifier here.
        let part = part
            .strip_suffix("_left")
            .or_else(|| part.strip_suffix("_right"))
            .unwrap_or(&part)
            .to_string();

        if part.is_empty() {
            continue;
        }

        match part.as_str() {
            "cmd" | "command" | "meta" | "super" | "win" => modifiers.push(Key::Meta),
            "ctrl" | "control" => modifiers.push(Key::Control),
            "shift" => modifiers.push(Key::Shift),
            "alt" | "opt" | "option" => modifiers.push(Key::Alt),
            "fn" | "function" => return Err(format!("Cannot replay the fn key in '{}'", chord)),
            _ => {
                if key.is_some() {
                    return Err(format!("More than one key in '{}'", chord));
                }
                key = Some(named_key(&part).ok_or_else(|| {
                    format!("Don't know how to replay the key '{}' in '{}'", part, chord)
                })?);
            }
        }
    }

    match key {
        Some(key) => Ok((modifiers, key)),
        None => Err(format!("Nothing to strike in '{}'", chord)),
    }
}

fn named_key(name: &str) -> Option<Key> {
    let key = match name {
        "space" => Key::Space,
        "tab" => Key::Tab,
        "return" | "enter" => Key::Return,
        "escape" | "esc" => Key::Escape,
        "delete" | "backspace" => Key::Backspace,
        "forwarddelete" | "del" => Key::Delete,
        "left" | "leftarrow" => Key::LeftArrow,
        "right" | "rightarrow" => Key::RightArrow,
        "up" | "uparrow" => Key::UpArrow,
        "down" | "downarrow" => Key::DownArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        "f13" => Key::F13,
        "f14" => Key::F14,
        "f15" => Key::F15,
        "f16" => Key::F16,
        "f17" => Key::F17,
        "f18" => Key::F18,
        "f19" => Key::F19,
        "f20" => Key::F20,
        _ => {
            let mut chars = name.chars();
            let first = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            Key::Unicode(first)
        }
    };
    Some(key)
}

/// Send the whole text in one go, no chunking. A transcript being re-pasted is
/// not being dictated now, so watching it type itself out again is just a wait.
pub fn paste_text_at_once(enigo: &mut Enigo, text: &str) -> Result<(), String> {
    for (index, line) in text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .enumerate()
    {
        if index > 0 {
            send_soft_newline(enigo)?;
        }
        enigo
            .text(line)
            .map_err(|e| format!("Failed to send text directly: {}", e))?;
    }

    Ok(())
}

/// Pastes text directly using the enigo text method.
/// This tries to use system input methods if possible, otherwise simulates keystrokes one by one.
pub fn paste_text_direct(enigo: &mut Enigo, text: &str) -> Result<(), String> {
    let chunk_chars = typing_chunk_size(text);

    for (index, line) in text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .enumerate()
    {
        if index > 0 {
            send_soft_newline(enigo)?;
        }

        let chars: Vec<char> = line.chars().collect();
        for (position, chunk) in chars.chunks(chunk_chars).enumerate() {
            if position > 0 {
                std::thread::sleep(CHUNK_PAUSE);
            }
            let piece: String = chunk.iter().collect();
            enigo
                .text(&piece)
                .map_err(|e| format!("Failed to send text directly: {}", e))?;
        }
    }

    Ok(())
}

const CHUNK_PAUSE: std::time::Duration = std::time::Duration::from_millis(6);
/// Small enough that a chunk is never a visible block of text arriving at once —
/// well under one terminal line, so it still reads as typing rather than a paste.
const MAX_CHUNK_CHARS: usize = 48;
const MIN_CHUNK_CHARS: usize = 12;

/// How much text to send per keystroke event, scaled to the size of the
/// transcript. A dictated sentence and a three-minute ramble should take about
/// the same time to land: chunking a long one at the short-message rate would
/// drag on for seconds, and the point of typing it out is that the text stays
/// editable, not that it looks hand-typed.
fn typing_chunk_size(text: &str) -> usize {
    let total = text.chars().count();
    (total / 30).clamp(MIN_CHUNK_CHARS, MAX_CHUNK_CHARS)
}

/// Shift+Return: a line break in editors and chat inputs that treat a bare
/// Return as "send", and indistinguishable from Return everywhere else. A
/// transcript that happens to contain a newline should never fire off a
/// half-finished message.
fn send_soft_newline(enigo: &mut Enigo) -> Result<(), String> {
    enigo
        .key(Key::Shift, enigo::Direction::Press)
        .map_err(|e| format!("Failed to press Shift: {}", e))?;
    let result = enigo
        .key(Key::Return, enigo::Direction::Click)
        .map_err(|e| format!("Failed to send Return: {}", e));
    enigo
        .key(Key::Shift, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release Shift: {}", e))?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paste_chord_parses_into_modifiers_and_one_key() {
        let (modifiers, key) = parse_chord("command+shift+v").unwrap();
        assert_eq!(modifiers, vec![Key::Meta, Key::Shift]);
        assert_eq!(key, Key::Unicode('v'));
    }

    #[test]
    fn a_side_specific_modifier_presses_the_plain_one() {
        let (modifiers, key) = parse_chord("option_right+space").unwrap();
        assert_eq!(modifiers, vec![Key::Alt]);
        assert_eq!(key, Key::Space);
    }

    #[test]
    fn chords_with_nothing_to_strike_are_refused() {
        // A bare modifier and a mouse button both have no keystroke to replay.
        assert!(parse_chord("option_right").is_err());
        assert!(parse_chord("mouse4").is_err());
        assert!(parse_chord("fn").is_err());
    }

    #[test]
    fn named_keys_survive_the_round_trip() {
        assert_eq!(parse_chord("ctrl+left").unwrap().1, Key::LeftArrow);
        assert_eq!(parse_chord("f13").unwrap().1, Key::F13);
        assert_eq!(parse_chord("shift+backspace").unwrap().1, Key::Backspace);
    }

    #[test]
    fn short_transcripts_type_at_the_slow_end() {
        assert_eq!(typing_chunk_size("hello there"), MIN_CHUNK_CHARS);
        assert_eq!(typing_chunk_size(&"a".repeat(200)), MIN_CHUNK_CHARS);
    }

    #[test]
    fn the_rate_climbs_with_length_then_stops() {
        assert_eq!(typing_chunk_size(&"a".repeat(900)), 30);
        assert_eq!(typing_chunk_size(&"a".repeat(1_440)), MAX_CHUNK_CHARS);
        // A five-minute ramble is capped at the same size as a long paragraph:
        // beyond this a chunk starts looking like pasted text.
        assert_eq!(typing_chunk_size(&"a".repeat(50_000)), MAX_CHUNK_CHARS);
    }

    /// Whatever the size, the whole transcript lands: no piece is dropped and
    /// the ordering is the text's own.
    #[test]
    fn chunking_covers_the_text_exactly() {
        for len in [1usize, 11, 12, 13, 500, 1_500] {
            let text: String = (0..len)
                .map(|i| char::from(b'a' + (i % 26) as u8))
                .collect();
            let size = typing_chunk_size(&text);
            let chars: Vec<char> = text.chars().collect();
            let rejoined: String = chars.chunks(size).flat_map(|c| c.iter()).collect();
            assert_eq!(rejoined, text, "length {len}");
        }
    }
}
