use std::path::PathBuf;
use std::{fs, path::Path};

use tauri::State;

use crate::app_state::{AppState, OpenDocumentContext};
use crate::error::{AppError, AppErrorPayload};
use crate::session::record_open_document;
use crate::storage::{
    DocumentClock, DocumentRepository, DocumentSnapshot, DocumentSummary, EditableDocumentSnapshot,
    SaveDocumentResult,
};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FableDirectoryEntry {
    kind: String,
    name: String,
    path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FableDirectory {
    current_document_path: String,
    entries: Vec<FableDirectoryEntry>,
    folder_name: String,
    folder_path: String,
    parent_folder_path: Option<String>,
}

#[tauri::command]
pub fn create_document(
    path: String,
    state: State<'_, AppState>,
) -> Result<DocumentSummary, AppErrorPayload> {
    let summary = DocumentRepository::create(PathBuf::from(&path))?;
    update_app_state(&state, &summary);
    Ok(summary)
}

#[tauri::command]
pub fn create_untitled_document_in_directory(
    path: String,
    state: State<'_, AppState>,
) -> Result<DocumentSummary, AppErrorPayload> {
    let directory = PathBuf::from(path);

    if !directory.is_dir() {
        return Err(AppError::invalid_input(
            "directory_missing",
            "Choose an existing folder before creating a document.",
        )
        .into());
    }

    let document_path = next_untitled_document_path(&directory);
    let summary = DocumentRepository::create(document_path)?;
    update_app_state(&state, &summary);
    Ok(summary)
}

#[tauri::command]
pub fn delete_fable_document(path: String) -> Result<(), AppErrorPayload> {
    let document_path = PathBuf::from(path);

    validate_deletable_fable_document_path(&document_path)?;
    fs::remove_file(&document_path)
        .map_err(AppError::from)
        .map_err(AppErrorPayload::from)?;
    Ok(())
}

#[tauri::command]
pub fn rename_fable_document(
    path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<DocumentSummary, AppErrorPayload> {
    let document_path = PathBuf::from(path);
    let next_path = renamed_fable_document_path(&document_path, &name)?;

    if next_path != document_path {
        fs::rename(&document_path, &next_path)
            .map_err(AppError::from)
            .map_err(AppErrorPayload::from)?;
    }

    let summary = DocumentRepository::open(next_path)?;
    let current_path = current_document_path(&state).ok();

    if current_path.as_ref() == Some(&document_path) {
        update_app_state(&state, &summary);
    }

    Ok(summary)
}

#[tauri::command]
pub fn open_document(
    path: String,
    state: State<'_, AppState>,
) -> Result<DocumentSummary, AppErrorPayload> {
    let summary = DocumentRepository::open(PathBuf::from(&path))?;
    update_app_state(&state, &summary);
    Ok(summary)
}

#[tauri::command]
pub fn list_current_document_directory(
    state: State<'_, AppState>,
) -> Result<FableDirectory, AppErrorPayload> {
    let document_path = current_document_path(&state)?;
    let folder_path = document_path
        .parent()
        .ok_or_else(|| {
            AppError::invalid_input(
                "document_folder_missing",
                "The current document does not have a containing folder.",
            )
        })?
        .to_path_buf();

    list_fable_directory_for_document(folder_path, document_path)
}

#[tauri::command]
pub fn list_fable_directory(
    path: String,
    state: State<'_, AppState>,
) -> Result<FableDirectory, AppErrorPayload> {
    let document_path = current_document_path(&state)?;
    list_fable_directory_for_document(PathBuf::from(path), document_path)
}

#[tauri::command]
pub fn load_current_document(
    state: State<'_, AppState>,
) -> Result<DocumentSnapshot, AppErrorPayload> {
    let path = current_document_path(&state)?;
    DocumentRepository::load(path)
}

#[tauri::command]
pub fn load_current_document_clock(
    state: State<'_, AppState>,
) -> Result<DocumentClock, AppErrorPayload> {
    let path = current_document_path(&state)?;
    DocumentRepository::clock(path)
}

#[tauri::command]
pub fn save_current_document(
    snapshot: EditableDocumentSnapshot,
    state: State<'_, AppState>,
) -> Result<SaveDocumentResult, AppErrorPayload> {
    let path = current_document_path(&state)?;
    DocumentRepository::save(path, snapshot)
}

#[tauri::command]
pub fn save_document(
    path: String,
    snapshot: EditableDocumentSnapshot,
) -> Result<SaveDocumentResult, AppErrorPayload> {
    DocumentRepository::save(PathBuf::from(path), snapshot)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, AppErrorPayload> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::not_found(
            "file_missing",
            format!("No file exists at {}.", file_path.display()),
        )
        .into());
    }

    fs::read_to_string(file_path)
        .map_err(AppError::from)
        .map_err(AppErrorPayload::from)
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), AppErrorPayload> {
    let file_path = PathBuf::from(&path);

    if let Some(parent) = Path::new(&file_path).parent() {
        fs::create_dir_all(parent)
            .map_err(AppError::from)
            .map_err(AppErrorPayload::from)?;
    }

    fs::write(file_path, contents)
        .map_err(AppError::from)
        .map_err(AppErrorPayload::from)?;
    Ok(())
}

fn list_fable_directory_for_document(
    folder_path: PathBuf,
    document_path: PathBuf,
) -> Result<FableDirectory, AppErrorPayload> {
    if !folder_path.is_dir() {
        return Err(AppError::invalid_input(
            "directory_missing",
            "Choose an existing folder before browsing documents.",
        )
        .into());
    }

    let mut entries = fs::read_dir(&folder_path)
        .map_err(AppError::from)
        .map_err(AppErrorPayload::from)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();

            if path.is_dir() {
                return Some(FableDirectoryEntry {
                    kind: "folder".to_string(),
                    name,
                    path: path.to_string_lossy().to_string(),
                });
            }

            let is_fable_file = path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case("fable"))
                .unwrap_or(false);

            if is_fable_file {
                return Some(FableDirectoryEntry {
                    kind: "document".to_string(),
                    name,
                    path: path.to_string_lossy().to_string(),
                });
            }

            None
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        let left_kind_order = if left.kind == "folder" { 0 } else { 1 };
        let right_kind_order = if right.kind == "folder" { 0 } else { 1 };

        left_kind_order
            .cmp(&right_kind_order)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(FableDirectory {
        current_document_path: document_path.to_string_lossy().to_string(),
        entries,
        folder_name: folder_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| folder_path.to_string_lossy().to_string()),
        parent_folder_path: folder_path
            .parent()
            .map(|parent| parent.to_string_lossy().to_string()),
        folder_path: folder_path.to_string_lossy().to_string(),
    })
}

fn next_untitled_document_path(directory: &Path) -> PathBuf {
    let first_path = directory.join("Untitled.fable");

    if !first_path.exists() {
        return first_path;
    }

    for index in 2.. {
        let candidate_path = directory.join(format!("Untitled {}.fable", index));

        if !candidate_path.exists() {
            return candidate_path;
        }
    }

    unreachable!("unbounded untitled document names should eventually find a free path")
}

fn renamed_fable_document_path(path: &Path, name: &str) -> Result<PathBuf, AppErrorPayload> {
    if !path.is_file() {
        return Err(AppError::not_found(
            "document_missing",
            format!("No Fablecraft document exists at {}.", path.display()),
        )
        .into());
    }

    let extension = path.extension().and_then(|value| value.to_str());
    if !matches!(extension, Some(value) if value.eq_ignore_ascii_case("fable")) {
        return Err(AppError::invalid_input(
            "document_not_fable",
            "Only .fable documents can be renamed here.",
        )
        .into());
    }

    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(AppError::invalid_input(
            "document_name_empty",
            "Enter a document name before renaming.",
        )
        .into());
    }

    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err(AppError::invalid_input(
            "document_name_invalid",
            "Document names cannot contain path separators.",
        )
        .into());
    }

    let stem = if trimmed_name.to_lowercase().ends_with(".fable") {
        &trimmed_name[..trimmed_name.len() - ".fable".len()]
    } else {
        trimmed_name
    }
    .trim();
    if stem.is_empty() {
        return Err(AppError::invalid_input(
            "document_name_empty",
            "Enter a document name before renaming.",
        )
        .into());
    }

    let file_name = format!("{stem}.fable");
    let next_path = path
        .parent()
        .ok_or_else(|| {
            AppError::invalid_input(
                "document_folder_missing",
                "The document does not have a containing folder.",
            )
        })?
        .join(file_name);

    if next_path == path {
        return Ok(next_path);
    }

    if next_path.exists() {
        return Err(AppError::invalid_input(
            "document_name_exists",
            "A .fable document with that name already exists.",
        )
        .into());
    }

    Ok(next_path)
}

fn validate_deletable_fable_document_path(path: &Path) -> Result<(), AppErrorPayload> {
    if !path.is_file() {
        return Err(AppError::not_found(
            "document_missing",
            format!("No Fablecraft document exists at {}.", path.display()),
        )
        .into());
    }

    let extension = path.extension().and_then(|value| value.to_str());
    if !matches!(extension, Some(value) if value.eq_ignore_ascii_case("fable")) {
        return Err(AppError::invalid_input(
            "document_not_fable",
            "Only .fable documents can be deleted here.",
        )
        .into());
    }

    Ok(())
}

fn current_document_path(state: &State<'_, AppState>) -> Result<PathBuf, AppErrorPayload> {
    state
        .current_document
        .lock()
        .expect("app state mutex should not be poisoned")
        .as_ref()
        .map(|context| context.path.clone())
        .ok_or_else(|| {
            AppError::invalid_input(
                "no_document_open",
                "Open or create a document before loading or saving it.",
            )
            .into()
        })
}

fn update_app_state(state: &State<'_, AppState>, summary: &DocumentSummary) {
    let mut guard = state
        .current_document
        .lock()
        .expect("app state mutex should not be poisoned");

    *guard = Some(OpenDocumentContext {
        document_id: summary.document_id.clone(),
        path: PathBuf::from(summary.path.clone()),
    });
    let _ = record_open_document(summary);
}

#[cfg(test)]
mod tests {
    use super::{renamed_fable_document_path, validate_deletable_fable_document_path};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_folder(label: &str) -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        let folder = std::env::temp_dir().join(format!("fablecraft-{label}-{timestamp}"));

        fs::create_dir_all(&folder).expect("temp folder should be created");
        folder
    }

    #[test]
    fn renamed_fable_document_path_appends_extension_and_rejects_collisions() {
        let folder = temp_folder("rename");
        let document_path = folder.join("story.fable");
        let existing_path = folder.join("existing.fable");

        fs::write(&document_path, "").expect("document file should be created");
        fs::write(&existing_path, "").expect("existing file should be created");

        let renamed_path = renamed_fable_document_path(&document_path, "field notes")
            .expect("valid rename should produce a path");

        assert_eq!(renamed_path, folder.join("field notes.fable"));
        assert!(renamed_fable_document_path(&document_path, "existing").is_err());
        assert!(renamed_fable_document_path(&document_path, "bad/name").is_err());

        fs::remove_dir_all(folder).expect("temp folder should be removable");
    }

    #[test]
    fn delete_fable_document_path_requires_existing_fable_file() {
        let folder = temp_folder("delete");
        let document_path = folder.join("story.fable");
        let text_path = folder.join("notes.txt");
        let nested_folder = folder.join("nested.fable");

        fs::write(&document_path, "").expect("document file should be created");
        fs::write(&text_path, "").expect("text file should be created");
        fs::create_dir_all(&nested_folder).expect("folder should be created");

        assert!(validate_deletable_fable_document_path(&document_path).is_ok());
        assert!(validate_deletable_fable_document_path(&text_path).is_err());
        assert!(validate_deletable_fable_document_path(&nested_folder).is_err());
        assert!(validate_deletable_fable_document_path(&folder.join("missing.fable")).is_err());

        fs::remove_dir_all(folder).expect("temp folder should be removable");
    }
}
