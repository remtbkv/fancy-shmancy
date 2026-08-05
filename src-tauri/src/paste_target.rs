//! Which application the transcript is about to land in.
//!
//! Some apps turn a large paste into an attachment instead of text — Claude's
//! composer collapses one into a "pasted text" block. Typing the transcript out
//! avoids that, at the cost of taking longer, so the choice is per app: typed
//! out where it has to be, dropped in one go everywhere else.

use log::debug;
use once_cell::sync::Lazy;
use std::sync::Mutex;

use crate::settings::AppSettings;

/// The last app a transcript was sent to. Bundle identifiers are not something
/// anyone knows by heart, so the settings UI offers this one for adding.
static LAST_TARGET: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// The frontmost application's bundle identifier, which is where a paste
/// lands. `None` when there is no frontmost app or the platform can't say.
pub fn frontmost_bundle_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        // Safety: reads the frontmost application from AppKit's shared
        // workspace, on whichever thread the paste runs on. NSWorkspace's
        // frontmostApplication is documented as safe off the main thread.
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let app = workspace.frontmostApplication()?;
            app.bundleIdentifier().map(|id| id.to_string())
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Note where this paste went, for the settings UI to offer.
pub fn remember(bundle_id: &str) {
    if let Ok(mut slot) = LAST_TARGET.lock() {
        *slot = Some(bundle_id.to_string());
    }
}

/// The app the last transcript was sent to, if there has been one this run.
pub fn last_target() -> Option<String> {
    LAST_TARGET.lock().ok().and_then(|slot| slot.clone())
}

/// Whether text going to this app should be typed out rather than dropped in
/// one go. Matching ignores case, since bundle identifiers are written both
/// ways in the wild.
pub fn types_out(settings: &AppSettings, bundle_id: Option<&str>) -> bool {
    let Some(bundle_id) = bundle_id else {
        // Nothing to match against, so take the faster path.
        return false;
    };
    settings
        .typed_out_apps
        .iter()
        .any(|configured| configured.trim().eq_ignore_ascii_case(bundle_id))
}

/// Resolve the style for the paste about to happen, and remember where it went.
pub fn typing_style(settings: &AppSettings) -> crate::clipboard::TypingStyle {
    let bundle_id = frontmost_bundle_id();
    if let Some(id) = &bundle_id {
        remember(id);
    }

    let typed_out = types_out(settings, bundle_id.as_deref());
    debug!(
        "paste target: {} -> {}",
        bundle_id.as_deref().unwrap_or("unknown"),
        if typed_out {
            "typed out"
        } else {
            "all at once"
        }
    );

    if typed_out {
        crate::clipboard::TypingStyle::TypedOut
    } else {
        crate::clipboard::TypingStyle::AllAtOnce
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(apps: &[&str]) -> AppSettings {
        let mut settings = crate::settings::get_default_settings();
        settings.typed_out_apps = apps.iter().map(|a| a.to_string()).collect();
        settings
    }

    #[test]
    fn a_listed_app_gets_the_transcript_typed_out() {
        let settings = settings_with(&["com.anthropic.claudefordesktop"]);
        assert!(types_out(&settings, Some("com.anthropic.claudefordesktop")));
    }

    #[test]
    fn everything_else_gets_it_in_one_go() {
        let settings = settings_with(&["com.anthropic.claudefordesktop"]);
        assert!(!types_out(&settings, Some("com.apple.Safari")));
        assert!(!types_out(&settings, None));
        assert!(!types_out(
            &settings_with(&[]),
            Some("com.anthropic.claudefordesktop")
        ));
    }

    /// Bundle identifiers get written every which way; a list entry that
    /// differs only in case still means the same app.
    #[test]
    fn matching_ignores_case_and_stray_spaces() {
        let settings = settings_with(&["  COM.Anthropic.ClaudeForDesktop "]);
        assert!(types_out(&settings, Some("com.anthropic.claudefordesktop")));
    }
}
