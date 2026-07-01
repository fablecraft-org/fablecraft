mod app_state;
mod commands;
mod error;
mod integrations;
pub mod mcp;
mod native_menu;
pub mod session;
pub mod storage;

use app_state::AppState;
use commands::{
    create_document, create_untitled_document_in_directory, delete_fable_document,
    list_current_document_directory, list_fable_directory, load_current_document,
    load_current_document_clock, open_document, read_text_file, rename_fable_document,
    save_current_document, save_document, take_pending_open_document_paths, write_text_file,
};
use integrations::{
    enable_claude_desktop_integration, enable_codex_integration, load_local_integration_statuses,
};
use mcp::{invoke_mcp_tool, list_mcp_tools};
use tauri::{Emitter, Manager};

const OPEN_DOCUMENTS_EVENT: &str = "fablecraft://open-documents";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenDocumentsPayload {
    paths: Vec<String>,
}

fn handle_open_document_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    if let Some(state) = app.try_state::<AppState>() {
        match state.pending_open_document_paths.lock() {
            Ok(mut pending_paths) => {
                pending_paths.extend(paths.iter().cloned());
            }
            Err(error) => {
                eprintln!("failed to record pending open document paths: {error}");
            }
        }
    }

    if let Err(error) = app.emit(OPEN_DOCUMENTS_EVENT, OpenDocumentsPayload { paths }) {
        eprintln!("failed to emit open document event: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .menu(native_menu::build_native_menu)
        .manage(AppState::default())
        .on_menu_event(native_menu::handle_native_menu_event)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            create_document,
            create_untitled_document_in_directory,
            delete_fable_document,
            enable_claude_desktop_integration,
            enable_codex_integration,
            invoke_mcp_tool,
            list_current_document_directory,
            list_fable_directory,
            list_mcp_tools,
            load_current_document,
            load_current_document_clock,
            load_local_integration_statuses,
            open_document,
            read_text_file,
            rename_fable_document,
            save_current_document,
            save_document,
            take_pending_open_document_paths,
            write_text_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building Fablecraft");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .filter(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("fable"))
                })
                .map(|path| path.to_string_lossy().to_string())
                .collect();

            handle_open_document_paths(app_handle, paths);
        }
    });
}
