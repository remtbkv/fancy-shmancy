use enigo::{Enigo, Key, Keyboard, Mouse, Settings};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

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
pub fn send_paste_ctrl_v(enigo: &mut Enigo) -> Result<(), String> {
    // Platform-specific key definitions
    #[cfg(target_os = "macos")]
    let (modifier_key, v_key_code) = (Key::Meta, Key::Other(9));
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

    std::thread::sleep(std::time::Duration::from_millis(100));

    enigo
        .key(modifier_key, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    Ok(())
}

/// Sends a Ctrl+Shift+V paste command.
/// This is commonly used in terminal applications on Linux to paste without formatting.
/// Note: On Wayland, this may not work - callers should check for Wayland and use alternative methods.
pub fn send_paste_ctrl_shift_v(enigo: &mut Enigo) -> Result<(), String> {
    // Platform-specific key definitions
    #[cfg(target_os = "macos")]
    let (modifier_key, v_key_code) = (Key::Meta, Key::Other(9)); // Cmd+Shift+V on macOS
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

    std::thread::sleep(std::time::Duration::from_millis(100));

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
pub fn send_paste_shift_insert(enigo: &mut Enigo) -> Result<(), String> {
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

    std::thread::sleep(std::time::Duration::from_millis(100));

    enigo
        .key(Key::Shift, enigo::Direction::Release)
        .map_err(|e| format!("Failed to release Shift key: {}", e))?;

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
            let text: String = (0..len).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
            let size = typing_chunk_size(&text);
            let chars: Vec<char> = text.chars().collect();
            let rejoined: String = chars.chunks(size).flat_map(|c| c.iter()).collect();
            assert_eq!(rejoined, text, "length {len}");
        }
    }
}
