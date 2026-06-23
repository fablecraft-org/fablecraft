use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::storage::DocumentSummary;

const SESSION_FILE_NAME: &str = "fablecraft-open-documents.json";
const MAIN_SLOT_ID: &str = "main";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentSession {
    pub document_id: String,
    pub document_path: String,
    pub process_id: u32,
    pub slot_id: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentSessionFile {
    pub open_documents: Vec<OpenDocumentSession>,
    pub updated_at_ms: u64,
}

pub fn session_file_path() -> PathBuf {
    std::env::temp_dir().join(SESSION_FILE_NAME)
}

pub fn record_open_document(summary: &DocumentSummary) -> AppResult<()> {
    let mut session_file = read_open_document_sessions().unwrap_or(OpenDocumentSessionFile {
        open_documents: Vec::new(),
        updated_at_ms: current_time_ms(),
    });
    let process_id = std::process::id();
    let updated_at_ms = current_time_ms();

    session_file
        .open_documents
        .retain(|session| !(session.process_id == process_id && session.slot_id == MAIN_SLOT_ID));
    session_file.open_documents.push(OpenDocumentSession {
        document_id: summary.document_id.clone(),
        document_path: summary.path.clone(),
        process_id,
        slot_id: MAIN_SLOT_ID.to_string(),
        updated_at_ms,
    });
    session_file.updated_at_ms = updated_at_ms;
    write_open_document_sessions(&session_file)
}

pub fn read_open_document_sessions() -> AppResult<OpenDocumentSessionFile> {
    let path = session_file_path();

    if !path.exists() {
        return Ok(OpenDocumentSessionFile {
            open_documents: Vec::new(),
            updated_at_ms: current_time_ms(),
        });
    }

    let contents = fs::read_to_string(&path).map_err(AppError::from)?;

    let session_file = serde_json::from_str(&contents).map_err(|error| {
        AppError::storage(
            "open_document_session_parse_failed",
            "Fablecraft could not parse the open document session file.",
            Some(error.to_string()),
        )
    })?;

    Ok(prune_missing_document_sessions(session_file))
}

fn write_open_document_sessions(session_file: &OpenDocumentSessionFile) -> AppResult<()> {
    let path = session_file_path();
    let contents = serde_json::to_string_pretty(session_file).map_err(|error| {
        AppError::storage(
            "open_document_session_serialize_failed",
            "Fablecraft could not serialize the open document session file.",
            Some(error.to_string()),
        )
    })?;

    fs::write(path, contents).map_err(AppError::from)
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn prune_missing_document_sessions(
    mut session_file: OpenDocumentSessionFile,
) -> OpenDocumentSessionFile {
    session_file
        .open_documents
        .retain(|session| is_existing_fable_document(&session.document_path));
    session_file
}

fn is_existing_fable_document(path: &str) -> bool {
    let path = PathBuf::from(path);
    let extension = path.extension().and_then(|value| value.to_str());

    path.is_file() && matches!(extension, Some(value) if value.eq_ignore_ascii_case("fable"))
}

#[cfg(test)]
mod tests {
    use super::{
        prune_missing_document_sessions, OpenDocumentSession, OpenDocumentSessionFile, MAIN_SLOT_ID,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn pruning_sessions_drops_missing_document_paths() {
        let existing_path = unique_temp_path("existing", "fable");
        let missing_path = unique_temp_path("missing", "fable");
        let non_fable_path = unique_temp_path("notes", "txt");

        fs::write(&existing_path, b"").expect("test document should be writable");
        fs::write(&non_fable_path, b"").expect("test text file should be writable");

        let session_file = OpenDocumentSessionFile {
            open_documents: vec![
                test_session("existing", existing_path.to_string_lossy().as_ref()),
                test_session("missing", missing_path.to_string_lossy().as_ref()),
                test_session("text", non_fable_path.to_string_lossy().as_ref()),
            ],
            updated_at_ms: 123,
        };

        let pruned = prune_missing_document_sessions(session_file);

        assert_eq!(pruned.open_documents.len(), 1);
        assert_eq!(pruned.open_documents[0].document_id, "existing");
        assert_eq!(pruned.updated_at_ms, 123);

        fs::remove_file(existing_path).expect("test document should be removable");
        fs::remove_file(non_fable_path).expect("test text file should be removable");
    }

    fn test_session(document_id: &str, document_path: &str) -> OpenDocumentSession {
        OpenDocumentSession {
            document_id: document_id.to_string(),
            document_path: document_path.to_string(),
            process_id: 1,
            slot_id: MAIN_SLOT_ID.to_string(),
            updated_at_ms: 123,
        }
    }

    fn unique_temp_path(label: &str, extension: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();

        std::env::temp_dir().join(format!(
            "fablecraft-session-test-{label}-{nonce}.{extension}"
        ))
    }
}
