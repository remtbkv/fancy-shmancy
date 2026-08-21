use crate::actions::process_transcription_output;
use crate::managers::{
    history::{HistoryManager, PaginatedHistory, RecordingStorageUsage},
    transcription::TranscriptionManager,
};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub async fn get_history_entries(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    cursor: Option<i64>,
    limit: Option<usize>,
) -> Result<PaginatedHistory, String> {
    history_manager
        .get_history_entries(cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn toggle_history_entry_saved(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .toggle_saved_status(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_audio_file_path(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    file_name: String,
) -> Result<String, String> {
    let path = history_manager.get_audio_file_path(&file_name);
    path.to_str()
        .ok_or_else(|| "Invalid file path".to_string())
        .map(|s| s.to_string())
}

/// Length of a recording, read from the WAV header. The history list used to
/// get this by loading the audio itself, which made every entry a media target
/// the play key could hijack.
#[tauri::command]
#[specta::specta]
pub async fn get_audio_duration_secs(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    file_name: String,
) -> Result<Option<f64>, String> {
    let path = history_manager.get_audio_file_path(&file_name);
    let Ok(reader) = hound::WavReader::open(&path) else {
        return Ok(None);
    };
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Ok(None);
    }
    Ok(Some(reader.duration() as f64 / spec.sample_rate as f64))
}

#[tauri::command]
#[specta::specta]
pub async fn delete_history_entry(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .delete_entry(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn retry_history_entry_transcription(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    id: i64,
) -> Result<(), String> {
    let entry = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {} not found", id))?;

    let audio_path = history_manager.get_audio_file_path(&entry.file_name);
    let samples = crate::audio_toolkit::read_wav_samples(&audio_path)
        .map_err(|e| format!("Failed to load audio: {}", e))?;

    if samples.is_empty() {
        return Err("Recording has no audio samples".to_string());
    }

    transcription_manager.initiate_model_load();

    let tm = Arc::clone(&transcription_manager);
    let transcription = tauri::async_runtime::spawn_blocking(move || tm.transcribe(samples))
        .await
        .map_err(|e| format!("Transcription task panicked: {}", e))?
        .map_err(|e| e.to_string())?;

    if transcription.is_empty() {
        return Err("Recording contains no speech".to_string());
    }

    let processed =
        process_transcription_output(&app, &transcription, entry.post_process_requested).await;
    history_manager
        .update_transcription(
            id,
            transcription,
            processed.post_processed_text,
            processed.post_process_prompt,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_history_limit(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    limit: usize,
) -> Result<(), String> {
    let mut settings = crate::settings::get_settings(&app);
    settings.history_limit = limit;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn update_recording_retention_period(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    period: String,
) -> Result<(), String> {
    use crate::settings::RecordingRetentionPeriod;

    let retention_period = match period.as_str() {
        "never" => RecordingRetentionPeriod::Never,
        "preserve_limit" => RecordingRetentionPeriod::PreserveLimit,
        "days3" => RecordingRetentionPeriod::Days3,
        "weeks2" => RecordingRetentionPeriod::Weeks2,
        "months3" => RecordingRetentionPeriod::Months3,
        "storage_limit" => RecordingRetentionPeriod::StorageLimit,
        _ => return Err(format!("Invalid retention period: {}", period)),
    };

    let mut settings = crate::settings::get_settings(&app);
    settings.recording_retention_period = retention_period;
    crate::settings::write_settings(&app, settings);

    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// What the recordings folder costs right now, and what an hour of dictation
/// adds to it. The second figure is measured from the audio actually kept, not
/// assumed from the sample format, so it reflects what this user's speech
/// really costs after silence has been filtered out.
#[tauri::command]
#[specta::specta]
pub async fn get_recording_storage_usage(
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<RecordingStorageUsage, String> {
    let bytes = history_manager.recordings_bytes();
    let seconds = history_manager
        .total_recorded_seconds()
        .map_err(|e| e.to_string())?;
    let bytes_per_hour = if seconds > 1.0 {
        (bytes as f64 / seconds) * 3600.0
    } else {
        0.0
    };
    Ok(RecordingStorageUsage {
        bytes_used: bytes as f64,
        bytes_per_hour,
        hours_recorded: seconds / 3600.0,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn update_recording_storage_limit(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    limit_gb: f64,
) -> Result<(), String> {
    let mut settings = crate::settings::get_settings(&app);
    settings.recording_storage_limit_gb = limit_gb.clamp(0.5, 500.0);
    crate::settings::write_settings(&app, settings);
    history_manager
        .cleanup_old_entries()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The folder recordings are written to right now, so the settings screen can
/// show it rather than describing it.
#[tauri::command]
#[specta::specta]
pub async fn get_recordings_dir(
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<String, String> {
    Ok(history_manager
        .recordings_dir()
        .to_string_lossy()
        .to_string())
}

/// Choose where recordings go. An empty string restores the default. Existing
/// recordings stay where they are — moving a user's audio without being asked
/// is not a thing a settings toggle should do.
#[tauri::command]
#[specta::specta]
pub async fn set_recordings_dir(
    app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    dir: String,
) -> Result<String, String> {
    let trimmed = dir.trim().to_string();
    if !trimmed.is_empty() {
        std::fs::create_dir_all(&trimmed).map_err(|e| format!("Cannot use that folder: {e}"))?;
    }
    let mut settings = crate::settings::get_settings(&app);
    settings.recordings_dir = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    crate::settings::write_settings(&app, settings);
    Ok(history_manager
        .recordings_dir()
        .to_string_lossy()
        .to_string())
}
