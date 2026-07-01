use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct OpenDocumentContext {
    pub document_id: String,
    pub path: PathBuf,
}

#[derive(Default)]
pub struct AppState {
    pub current_document: Mutex<Option<OpenDocumentContext>>,
    pub pending_open_document_paths: Mutex<Vec<String>>,
}
