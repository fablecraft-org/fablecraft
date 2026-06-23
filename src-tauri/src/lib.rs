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
    save_current_document, save_document, write_text_file,
};
use integrations::{
    enable_claude_desktop_integration, enable_codex_integration, load_local_integration_statuses,
};
use mcp::{invoke_mcp_tool, list_mcp_tools};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fablecraft");
}
