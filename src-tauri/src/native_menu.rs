use serde::Serialize;
use tauri::{
    menu::{
        Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    AppHandle, Emitter, Runtime,
};

pub const MENU_ACTION_EVENT: &str = "fablecraft://menu-action";

const APP_SETTINGS: &str = "app.settings";
const APP_CHECK_FOR_UPDATES: &str = "app.check_for_updates";
const FILE_NEW_DOCUMENT: &str = "file.new_document";
const FILE_OPEN_DOCUMENT: &str = "file.open_document";
const FILE_OPEN_RECENT: &str = "file.open_recent";
const FILE_SAVE: &str = "file.save";
const FILE_IMPORT_MARKDOWN: &str = "file.import_markdown";
const FILE_EXPORT_MARKDOWN: &str = "file.export_markdown";
const EDIT_UNDO: &str = "edit.undo";
const EDIT_REDO: &str = "edit.redo";
const CARD_MERGE_ABOVE: &str = "card.merge_above";
const CARD_MERGE_BELOW: &str = "card.merge_below";
const CARD_SHIFT_UP: &str = "card.shift_up";
const CARD_SHIFT_DOWN: &str = "card.shift_down";
const CARD_SPLIT: &str = "card.split";
const CARD_CREATE_CHILD: &str = "card.create_child";
const CARD_CREATE_ANCHORED_CHILD: &str = "card.create_anchored_child";
const CARD_CREATE_PARENT: &str = "card.create_parent";
const CARD_CREATE_ABOVE: &str = "card.create_above";
const CARD_CREATE_BELOW: &str = "card.create_below";
const TOOLS_COMMAND_PALETTE: &str = "tools.command_palette";
const TOOLS_SEARCH: &str = "tools.search";
const TOOLS_ENABLE_CODEX: &str = "tools.enable_codex";
const TOOLS_ENABLE_CLAUDE_DESKTOP: &str = "tools.enable_claude_desktop";
const WINDOW_RELOAD: &str = "window.reload";
const WINDOW_WIDE_LENS: &str = "window.wide_lens";
const WINDOW_NORMAL: &str = "window.normal";
const WINDOW_COMPACT: &str = "window.compact";
const WINDOW_LARGE: &str = "window.large";
const WINDOW_ZOOM_IN: &str = "window.zoom_in";
const WINDOW_ZOOM_OUT: &str = "window.zoom_out";
const HELP_SHORTCUTS: &str = "help.shortcuts";
const HELP_COMMANDS: &str = "help.commands";
const HELP_GETTING_STARTED: &str = "help.getting_started";
const HELP_REPORT_BUG: &str = "help.report_bug";
const HELP_REQUEST_FEATURE: &str = "help.request_feature";

#[derive(Clone, Serialize)]
struct MenuActionPayload<'a> {
    action: &'a str,
}

pub fn build_native_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let import_manuscript_markdown = MenuItemBuilder::with_id("import-manuscript-markdown", "Import Manuscript Markdown").build(app)?;
    let export_manuscript_markdown = MenuItemBuilder::with_id("export-manuscript-markdown", "Export Manuscript Markdown").build(app)?;
    let write_manuscript = MenuItemBuilder::with_id("write-manuscript", "Write Manuscript").build(app)?;
    let link_manuscript_passage = MenuItemBuilder::with_id("link-manuscript-passage", "Link Manuscript Passage").build(app)?;
    let layout_tree = MenuItemBuilder::with_id("layout-tree", "Show Tree").build(app)?;
    let layout_both = MenuItemBuilder::with_id("layout-both", "Show Both").build(app)?;
    let show_history = MenuItemBuilder::with_id("show-history", "Toggle History")
        .accelerator(if cfg!(target_os = "macos") { "Cmd+Shift+H" } else { "Ctrl+H" })
        .enabled(false)
        .build(app)?;
    let layout_manuscript = MenuItemBuilder::with_id("layout-manuscript", "Show Manuscript").build(app)?;
    let pane_left = MenuItemBuilder::with_id("pane-left", "Focus Pane Left").build(app)?;
    let pane_right = MenuItemBuilder::with_id("pane-right", "Focus Pane Right").build(app)?;

    let settings = MenuItemBuilder::with_id(APP_SETTINGS, "Settings")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let check_for_updates =
        MenuItemBuilder::with_id(APP_CHECK_FOR_UPDATES, "Check for Updates...").build(app)?;

    let new_document = MenuItemBuilder::with_id(FILE_NEW_DOCUMENT, "New Document")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open_document = MenuItemBuilder::with_id(FILE_OPEN_DOCUMENT, "Open Document")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_recent = MenuItemBuilder::with_id(FILE_OPEN_RECENT, "Open Recent")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id(FILE_SAVE, "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let import_markdown =
        MenuItemBuilder::with_id(FILE_IMPORT_MARKDOWN, "Import Markdown").build(app)?;
    let export_markdown =
        MenuItemBuilder::with_id(FILE_EXPORT_MARKDOWN, "Export Markdown").build(app)?;

    let undo = MenuItemBuilder::with_id(EDIT_UNDO, "Undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::with_id(EDIT_REDO, "Redo")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;

    let merge_above = MenuItemBuilder::with_id(CARD_MERGE_ABOVE, "Merge Above")
        .accelerator("Alt+Up")
        .build(app)?;
    let merge_below = MenuItemBuilder::with_id(CARD_MERGE_BELOW, "Merge Below")
        .accelerator("Alt+Down")
        .build(app)?;
    let shift_up = MenuItemBuilder::with_id(CARD_SHIFT_UP, "Shift Up")
        .accelerator("Shift+Up")
        .build(app)?;
    let shift_down = MenuItemBuilder::with_id(CARD_SHIFT_DOWN, "Shift Down")
        .accelerator("Shift+Down")
        .build(app)?;
    let split = MenuItemBuilder::with_id(CARD_SPLIT, "Split")
        .accelerator("Tab+Enter")
        .build(app)?;
    let create_child = MenuItemBuilder::with_id(CARD_CREATE_CHILD, "Create Child")
        .build(app)?;
    let create_anchored_child = MenuItemBuilder::with_id(CARD_CREATE_ANCHORED_CHILD, "Create Child from Passage")
        .build(app)?;
    let create_parent = MenuItemBuilder::with_id(CARD_CREATE_PARENT, "Create Parent")
        .build(app)?;
    let create_above = MenuItemBuilder::with_id(CARD_CREATE_ABOVE, "Create Above")
        .build(app)?;
    let create_below = MenuItemBuilder::with_id(CARD_CREATE_BELOW, "Create Below")
        .build(app)?;

    let command_palette = MenuItemBuilder::with_id(TOOLS_COMMAND_PALETTE, "Command Palette")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let search = MenuItemBuilder::with_id(TOOLS_SEARCH, "Search")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let enable_codex = MenuItemBuilder::with_id(TOOLS_ENABLE_CODEX, "Enable Codex").build(app)?;
    let enable_claude_desktop =
        MenuItemBuilder::with_id(TOOLS_ENABLE_CLAUDE_DESKTOP, "Enable Claude Desktop")
            .build(app)?;

    let reload = MenuItemBuilder::with_id(WINDOW_RELOAD, "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id(WINDOW_ZOOM_IN, "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id(WINDOW_ZOOM_OUT, "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;

    let wide_lens = MenuItemBuilder::with_id(WINDOW_WIDE_LENS, "Wide Lens").build(app)?;
    let normal = MenuItemBuilder::with_id(WINDOW_NORMAL, "Normal").build(app)?;
    let compact = MenuItemBuilder::with_id(WINDOW_COMPACT, "Compact").build(app)?;
    let large = MenuItemBuilder::with_id(WINDOW_LARGE, "Large").build(app)?;

    let shortcuts = MenuItemBuilder::with_id(HELP_SHORTCUTS, "Shortcuts").build(app)?;
    let commands = MenuItemBuilder::with_id(HELP_COMMANDS, "Commands").build(app)?;
    let getting_started =
        MenuItemBuilder::with_id(HELP_GETTING_STARTED, "Getting Started").build(app)?;
    let report_bug = MenuItemBuilder::with_id(HELP_REPORT_BUG, "Report a Bug").build(app)?;
    let request_feature =
        MenuItemBuilder::with_id(HELP_REQUEST_FEATURE, "Request a Feature").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Fablecraft")
        .about_with_text("About Fablecraft", None)
        .separator()
        .item(&check_for_updates)
        .separator()
        .item(&settings)
        .separator()
        .hide_with_text("Hide Fablecraft")
        .hide_others_with_text("Hide Others")
        .show_all_with_text("Show All")
        .separator()
        .quit_with_text("Quit")
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_document)
        .item(&open_document)
        .item(&open_recent)
        .item(&save)
        .separator()
        .item(&import_markdown)
        .item(&export_markdown)
        .separator()
        .item(&import_manuscript_markdown)
        .item(&export_manuscript_markdown)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .cut()
        .copy()
        .paste()
        .build()?;

    let card_menu = SubmenuBuilder::new(app, "Card")
        .item(&merge_above)
        .item(&merge_below)
        .separator()
        .item(&shift_up)
        .item(&shift_down)
        .separator()
        .item(&split)
        .separator()
        .item(&create_child)
        .item(&create_anchored_child)
        .item(&create_parent)
        .item(&create_above)
        .item(&create_below)
        .build()?;

    let manuscript_menu = SubmenuBuilder::new(app, "Manuscript")
        .item(&write_manuscript)
        .item(&link_manuscript_passage)
        .build()?;

    let tools_menu = SubmenuBuilder::new(app, "Tools")
        .item(&command_palette)
        .item(&search)
        .item(&show_history)
        .separator()
        .item(&enable_codex)
        .item(&enable_claude_desktop)
        .build()?;

    let window_menu = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .item(&reload)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .separator()
        .item(&wide_lens)
        .item(&compact)
        .item(&normal)
        .item(&large)
        .separator()
        .item(&layout_tree)
        .item(&layout_both)
        .item(&layout_manuscript)
        .item(&pane_left)
        .item(&pane_right)
        .separator()
        .minimize_with_text("Minimize")
        .fullscreen_with_text("Toggle Full Screen")
        .build()?;

    let help_menu = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
        .item(&getting_started)
        .item(&shortcuts)
        .item(&commands)
        .separator()
        .item(&report_bug)
        .item(&request_feature)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&card_menu)
        .item(&manuscript_menu)
        .item(&tools_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}

pub fn handle_native_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().0.as_str() {
        "import-manuscript-markdown" => emit_action(app, "import-manuscript-markdown"),
        "export-manuscript-markdown" => emit_action(app, "export-manuscript-markdown"),
        "write-manuscript" => emit_action(app, "write-manuscript"),
        "link-manuscript-passage" => emit_action(app, "link-manuscript-passage"),
        "layout-tree" => emit_action(app, "layout-tree"),
        "layout-both" => emit_action(app, "layout-both"),
        "show-history" => emit_action(app, "show-history"),
        "layout-manuscript" => emit_action(app, "layout-manuscript"),
        "pane-left" => emit_action(app, "pane-left"),
        "pane-right" => emit_action(app, "pane-right"),
        WINDOW_RELOAD => emit_action(app, "reload-window"),
        FILE_NEW_DOCUMENT => emit_action(app, "new-document"),
        FILE_OPEN_DOCUMENT => emit_action(app, "open-document"),
        FILE_OPEN_RECENT => emit_action(app, "open-recent"),
        FILE_SAVE => emit_action(app, "save"),
        FILE_IMPORT_MARKDOWN => emit_action(app, "import-markdown"),
        FILE_EXPORT_MARKDOWN => emit_action(app, "export-markdown"),
        APP_CHECK_FOR_UPDATES => emit_action(app, "check-for-updates"),
        APP_SETTINGS => emit_action(app, "settings"),
        EDIT_UNDO => emit_action(app, "undo"),
        EDIT_REDO => emit_action(app, "redo"),
        CARD_MERGE_ABOVE => emit_action(app, "merge-with-above"),
        CARD_MERGE_BELOW => emit_action(app, "merge-below"),
        CARD_SHIFT_UP => emit_action(app, "shift-up"),
        CARD_SHIFT_DOWN => emit_action(app, "shift-down"),
        CARD_SPLIT => emit_action(app, "split"),
        CARD_CREATE_CHILD => emit_action(app, "create-child"),
        CARD_CREATE_ANCHORED_CHILD => emit_action(app, "create-anchored-child"),
        CARD_CREATE_PARENT => emit_action(app, "create-parent"),
        CARD_CREATE_ABOVE => emit_action(app, "create-above"),
        CARD_CREATE_BELOW => emit_action(app, "create-below"),
        TOOLS_COMMAND_PALETTE => emit_action(app, "command-palette"),
        TOOLS_SEARCH => emit_action(app, "search"),
        TOOLS_ENABLE_CODEX => emit_action(app, "enable-codex"),
        TOOLS_ENABLE_CLAUDE_DESKTOP => emit_action(app, "enable-claude-desktop"),
        WINDOW_WIDE_LENS => emit_action(app, "view-wide-lens"),
        WINDOW_NORMAL => emit_action(app, "view-normal"),
        WINDOW_COMPACT => emit_action(app, "view-compact"),
        WINDOW_LARGE => emit_action(app, "view-large"),
        WINDOW_ZOOM_IN => emit_action(app, "zoom-in"),
        WINDOW_ZOOM_OUT => emit_action(app, "zoom-out"),
        HELP_GETTING_STARTED => emit_action(app, "help-getting-started"),
        HELP_SHORTCUTS => emit_action(app, "help-shortcuts"),
        HELP_COMMANDS => emit_action(app, "help-commands"),
        HELP_REPORT_BUG => emit_action(app, "help-report-bug"),
        HELP_REQUEST_FEATURE => emit_action(app, "help-request-feature"),
        _ => {}
    }
}

fn emit_action<R: Runtime>(app: &AppHandle<R>, action: &'static str) {
    let _ = app.emit(MENU_ACTION_EVENT, MenuActionPayload { action });
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMenuState {
    document_open: bool,
    manuscript: bool,
    tree_active: bool,
    split_fits: bool,
    link: bool,
    dialog: bool,
}

#[tauri::command]
pub fn update_workspace_menu(app: AppHandle, state: WorkspaceMenuState) -> Result<(), String> {
    let Some(menu) = app.menu() else { return Ok(()) };
    let document = state.document_open && !state.dialog;
    let tree = document && state.tree_active;
    let manuscript = document && state.manuscript;
    for item in menu.items().map_err(|error| error.to_string())? {
        let Some(submenu) = item.as_submenu() else { continue };
        for item in submenu.items().map_err(|error| error.to_string())? {
            let Some(item) = item.as_menuitem() else { continue };
            let enabled = match item.id().as_ref() {
                "layout-both" => {
                    let label = if state.split_fits { "Show Both" } else { "Show Both (Widen Window)" };
                    item.set_text(label).map_err(|error| error.to_string())?;
                    document && state.split_fits
                }
                "show-history" => state.document_open,
                "layout-tree" | "layout-manuscript" | "pane-left" | "pane-right" |
                "import-manuscript-markdown" | TOOLS_SEARCH => document,
                "write-manuscript" => document && !state.manuscript,
                "export-manuscript-markdown" => manuscript,
                "link-manuscript-passage" => manuscript && !tree && state.link,
                FILE_EXPORT_MARKDOWN | CARD_MERGE_ABOVE | CARD_MERGE_BELOW | CARD_SHIFT_UP |
                CARD_SHIFT_DOWN | CARD_SPLIT | CARD_CREATE_CHILD | CARD_CREATE_ANCHORED_CHILD |
                CARD_CREATE_PARENT | CARD_CREATE_ABOVE | CARD_CREATE_BELOW | WINDOW_NORMAL |
                WINDOW_WIDE_LENS | WINDOW_COMPACT | WINDOW_LARGE => tree,
                WINDOW_ZOOM_IN | WINDOW_ZOOM_OUT => document,
                EDIT_UNDO | EDIT_REDO => document,
                _ => continue,
            };
            item.set_enabled(enabled).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
