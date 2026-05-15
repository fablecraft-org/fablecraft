# Fablecraft — Engineering Brief

## 1. Purpose

This document defines the **technical architecture, stack, implementation plan, and acceptance tests** required to build the Fablecraft MVP.

The Product Specification is the source of truth for behavior.
This brief translates it into **buildable engineering instructions**.

---

## 2. Core Technical Decisions

### Desktop
- Tauri (Rust + WebView)

### Frontend
- React + TypeScript
- Vite
- browser builds render the public website
- Tauri builds render the desktop editor
- `npm run tutorial:sync` regenerates the website tutorial snapshot from `src/site/tutorial.fable`
- Tauri updater calls live behind a desktop-only frontend service

### State
- Zustand

### Editor
- Tiptap (ProseMirror)

### Styling
- Tailwind
- Centralized UI tokens (spacing, colors, animation)
- light mode uses a shared soft pink-white paper and dark-ink palette across the website and desktop app
- desktop app icons live in `src-tauri/icons`, are generated from `branding/generated-icons/fablecraft-app-icon-rounded.png`, and must be listed in `src-tauri/tauri.conf.json` under `bundle.icon`; website favicon and web app manifest icons live in `public`
- dark mode uses neutral charcoal surfaces and cool gray contrast rather than warm brown tokens
- shadows stay restrained so borders and spacing do most of the visual work
- desktop cards and panels use only slight corner rounding and rely on shadow hierarchy instead of visible borders

### Storage
- SQLite
- `.fable` = single SQLite file
- Rust: `rusqlite`

### Validation
- Zod

### Testing
- Vitest (unit)
- Optional: Playwright (e2e)

### Website Deployment
- static frontend deployment should work cleanly on Vercel
- the macOS release download must be derived from environment-configured GitHub metadata (`siteContent`) so the website can point at `releases/latest/download/...` without browser-side API calls
- optional future feedback endpoints can reuse the same environment-driven pattern when site forms return
- the website must still render gracefully when those hosted endpoints are not configured

### Desktop Updates
- `@tauri-apps/plugin-updater` checks the signed GitHub `latest.json` manifest configured in `src-tauri/tauri.conf.json`
- `@tauri-apps/plugin-process` / `tauri-plugin-process` provides relaunch after installation
- `src/storage/appUpdater.ts` wraps update check, download progress, install, and relaunch behavior
- background startup checks are quiet unless an update exists; manual checks surface success and error notices

---

## 3. Architecture Layers

### Storage Layer
- SQLite schema
- open/create `.fable`
- autosave

### Domain Layer
- tree operations
- single-plane content operations
- undo logic

### UI State
- active card
- mode

### Editor Layer
- Tiptap integration
- markdown-style rich-text shortcuts
- split + double-enter behavior

### Layout Layer
- sideways tree
- centering logic
- bounded stage-style workspace
- full-tree rendering with overflow-hidden clipping
- transient Cmd/Ctrl zoom shortcut overview state that uses a separate structural tree layout with compact title-only card shells, fixed scaling, and connector lines
- fixed viewport with no scrollbars
- macOS title bar uses overlay chrome with a top drag region; native app/window theme and desktop document shell backgrounds sync to the active light/dark app background
- border-only mode indication

### MCP Layer
- tool endpoints
- error handling

### Website Layer
- runtime split between browser and Tauri
- public landing page (hero, live tutorial demo, footer) and marketing content
- `src/site/tutorial.fable` is the editable source document for the website demo; `src/site/tutorialSnapshot.ts` is generated from it and consumed by `DemoApp`
- hero download link when `VITE_FABLECRAFT_GITHUB_OWNER`, `VITE_FABLECRAFT_GITHUB_REPO`, and `VITE_FABLECRAFT_DOWNLOAD_MAC_ASSET_NAME` are configured; `siteContent` retains Windows/Linux env slots for future multi-platform or off-page distribution
- future authenticated surface for sync and AI connector management
- sparse editorial layout with generous whitespace and minimal copy
- hero-led composition with a very light header and line-based section dividers where sections exist

### Update Layer
- desktop-only updater service in `src/storage/appUpdater.ts`
- startup check is scheduled after the desktop shell mounts and guarded against React StrictMode double invocation
- manual check actions are exposed through the native Fablecraft menu and command palette
- install flow force-saves the current document, downloads and installs the signed update, then relaunches the app

---

## 4. Data Model

### cards
- id
- document_id
- parent_id
- order_index
- type

### card_content
- card_id
- content_json

### revisions
- id
- snapshot

---

## 5. UI Tokens (Critical)

All UI values must be centralized:

```ts
spacing: 24px
cardHeight: 84px
cardWidth: 468px default, 500px wide setting
contentSize: tokenized
contentLineHeight: tokenized
animation: ~140ms ease-in-out
```

---

## 6. Implementation Plan

### Phase 1 — Setup
- scaffold app
- SQLite schema
- startup screen

### Phase 2 — Tree
- create/move/delete cards
- autosave

### Phase 3 — Navigation
- keyboard navigation
- edit mode
- undo

### Phase 4 — Layout
- centered card
- sideways tree

### Phase 5 — Simplification
- remove layers from the desktop UX and document model
- treat the document as a single visible content plane
- migrate older layer-backed files into single-plane card content

### Phase 6 — Command + Search
- command palette
- search
- native File / Edit desktop menu wired into the same app actions
- native menu actions are handled by one stable frontend listener; document-open dialogs must ignore duplicate invocations while a picker is already pending
- settings modal via command palette
- settings uses row-based inline controls rather than native select controls
- theme options are simplified to Light and Dark
- default reading scale stays slightly compact to preserve card density
- card shells use an additional 10px of internal content padding while preserving active vs inactive parity
- keyboard access remains intact: Up/Down move between setting rows, Left/Right change the current row
- while settings is open, workspace keyboard navigation is suspended so keys do not move cards in the background
- search scoped to the document
- Cmd/Ctrl+K toggles the centered palette
- Cmd/Ctrl+F opens centered search

### Phase 7 — Import/Export
- markdown import/export
- startup import creates a new `.fable` document and seeds the root card from Markdown
- export writes Markdown or HTML for the currently selected level
- export save dialogs default to the document name

### Phase 8 — MCP
- server scaffold
- read tools
- local Tauri-backed tool registry exposed through invoke commands
- Claude-compatible local stdio MCP binary: `fablecraft-mcp`
- Cargo `default-run` remains `fablecraft` so `npm run tauri dev` launches the desktop app binary instead of the MCP binary
- read tools: `fablecraft_get_open_documents`, `fablecraft_get_document`, `fablecraft_get_card`, `fablecraft_get_subtree`
- mutation tools: `fablecraft_set_card_text`, `fablecraft_create_child`, `fablecraft_create_sibling_before`, `fablecraft_create_sibling_after`, `fablecraft_move_card`, `fablecraft_wrap_level_in_parent`, `fablecraft_delete_card`
- desktop open/create writes a small process-keyed session file in the OS temp directory so external MCP clients can discover active `.fable` document paths without talking to the running Tauri process
- local developer MCP invocation accepts the same `documentPath` and id-bearing argument payloads as the external stdio server; legacy active-card request fields remain supported only as a compatibility fallback
- MCP mutation responses are lightweight status payloads and do not include a full persisted `DocumentSnapshot`
- `get_document` returns `treeDepthCounts`; `get_card` returns ordered direct `childCardIds`
- structured payload limits on tool args and responses
- the workspace polls a lightweight document clock before loading a full `.fable` snapshot, and commits external changes when there are no unsaved local edits
- MCP remains available as an external integration surface rather than an in-app command palette action

### Phase 9 — Website
- add a browser-only companion website inside the same frontend repo
- detect runtime at startup so browser builds render the website and Tauri builds keep the editor
- implement a minimal sophisticated landing page for `https://fablecraft.xyz`
- include hero, a scroll-first live demo seeded from `src/site/tutorial.fable` via the generated `src/site/tutorialSnapshot.ts`, and footer; the hero download control uses `siteDownloads` and builds the macOS URL from GitHub release env metadata when present, otherwise a muted non-link label
- keep release metadata environment-configurable for Vercel deployment (`siteContent` retains Windows/Linux env URLs for future hero or off-site use)
- keep browser layouts scrollable without breaking the desktop app's fixed-height workspace shell
- add a GitHub Actions release workflow that runs on `v*` tags, builds an arm64 macOS `.dmg`, signs/notarizes the app with Developer ID credentials, emits Tauri updater artifacts with the committed updater public key, renames the public DMG to `Fablecraft-macos-arm64.dmg`, and uploads the macOS release assets plus `latest.json` to the GitHub Release
- add in-app update checks that use the Tauri updater manifest, prompt before installing, force-save before install, and relaunch through the process plugin

---

## 7. Acceptance Tests (Core)

### Navigation
- arrows navigate correctly
- up/down move within the packed spatial column
- left/right change depth only
- typing any printable character enters edit mode and forwards that character into the editor
- Tab+ArrowUp / Down / Right / Left create siblings, children, and wrapped parents in navigation mode
- Shift+Up / Down moves within the packed column, can reorder root cards, and may reparent a card when crossing into a neighboring parent group
- Shift+Right indents the active card under the sibling above as its last child
- Option+Up / Down merges the active card with the sibling above or below while preserving the active card id
- no invalid moves
- empty cards cannot spawn new cards
- newly created cards use an empty level-one heading document without an editor-appended trailing paragraph

### Editing
- enter/escape behavior correct
- backspace deletes empty non-root cards
- Backspace from a trailing empty block trims that block immediately so the active card can remeasure smaller
- ArrowDown at the end of a card moves into the card below in edit mode at the start of that card
- ArrowUp at the start of a card moves into the card above in edit mode at the end of that card
- ArrowRight at the end of a card moves into the first child in edit mode at the start of that card
- Tab+Arrow navigates nearby cards, places the caret at the end of the destination card, and stays in edit mode
- Tab+Arrow creates a card in the pointed direction when no nearby destination card exists in edit mode
- Enter in an empty new-card heading converts the single heading line to a paragraph and does not create a sibling
- Option+Up / Down in edit mode merges with the sibling above or below without leaving edit mode
- markdown shortcuts render correctly, including visible list and heading styling
- preview mode preserves heading and list structure after a card is deselected
- double-enter creates a sibling below and trims the trailing empty paragraph from the source card
- card exit paths trim trailing empty paragraphs and trailing hard breaks from the source card
- split works

### Layout
- active card centered
- workspace stage fills the available window instead of clipping to an internal max width
- workspace background matches the card surface rather than using a separate tint
- on macOS, the native title bar overlays the app content and matches the active light/dark background instead of showing a separate strip
- the desktop shell exposes a fixed top drag region that spans the full window width and the upper 128px, using both Tauri's drag-region marker and an explicit `startDragging` fallback
- no helper text outside cards
- cards do not resize on selection alone
- preview cards retain measured height instead of collapsing back to the minimum, and they remeasure when content changes
- measured card height uses the full rendered card surface so edit mode does not change wrapping or sibling spacing
- the active card keeps the same renderer footprint between navigation and editing
- increased internal card padding still preserves the same active vs inactive footprint
- focused and unfocused cards keep the same footprint
- cards use shadow rather than visible borders
- navigation focus uses the same elevated shadow as the selected editing card
- dark theme card shadows are disabled; card visibility comes from lighter card-surface tokens, with an even lighter editing surface
- card number labels use a theme token with a lighter dark-mode value
- neighborhood cards keep full text contrast and a soft shadow
- non-neighborhood cards keep the same text and surface color, but render without shadow emphasis
- immediate parent aligns with the active card
- the first immediate child aligns to the active card centerline, and later children stack below it even when that child column also contains other subtree groups
- the active child-group anchor must preserve the top-to-bottom order of neighboring sibling subtrees in that column
- when the active card has no children, the child column still reserves a centered empty slot with the active card's measured footprint before sibling child groups above and below are packed
- the workspace renders that reserved slot as an invisible click target rather than a visible placeholder, and may use it to create the first child when card creation is allowed
- no nested scroll
- no scrollbars
- wheel / trackpad panning moves the normal writing stage
- Cmd/Ctrl+- enters overview, renders every card as a compact first-line title with up to two visible lines, starts with the active card centered, and uses the fixed overview scale defined in `DocumentWorkspace`
- overview uses `overviewTreeLayout` rather than normal `stageLayout`; cards have fixed dimensions, columns follow tree depth, parent/child columns have extra horizontal space, and parent-to-child Bezier connector paths render behind the cards
- overview connector strokes use warm gray theme tokens, with the selected card's descendant subtree edges and ancestor-path edges using the darker active connector token
- overview always uses the same fixed scale no matter which card opened it; card navigation inside overview must not recalculate scale, and wheel / trackpad gestures pan the overview graph without changing focus
- overview centers child groups around their parent where possible and caps adjacent child sibling center gaps at 200px
- wheel / trackpad gestures pan the normal stage or overview graph depending on the current mode; they must not enter or exit overview
- Cmd/Ctrl++, the `Zoomed In` command, and the native Window > Zoomed In menu action exit overview and restore the normal rich-card stage around the selected card
- Cmd/Ctrl+-, the `Zoomed Out` command, and the native Window > Zoomed Out menu action enter overview
- exiting overview after selecting a different card must remeasure the newly active full-size card before relying on its height for sibling spacing
- normal rich-card layout must use content-based height estimates for cards whose DOM measurements are not available yet, so long cards are never packed using the minimum card height after returning from overview
- card height measurement must use transform-independent layout dimensions (`offsetHeight` / `scrollHeight`), not transformed bounding boxes, because overview scale transitions can otherwise cache undersized heights and collapse normal spacing

### Single-plane model
- the desktop editor exposes no layer UI or layer model
- content search and editing work against one visible document plane
- older layer-backed SQLite files are migrated by the v2 schema migration into one content row per card

### Storage
- autosave works
- Cmd/Ctrl+S force-flushes dirty changes through the same snapshot persistence path
- opening or creating another document force-flushes dirty changes before the current document path changes
- frontend saves target the snapshot's explicit document path so delayed saves cannot drift to a newly opened document
- revision snapshots are persisted and mirrored in frontend state as editable snapshots only, without summary or prior revision history, so autosave cannot recursively grow revision payloads
- persistence validation allows multiple root-depth cards, requires at least one root-depth card, and enforces contiguous sibling order per parent including the root group
- reopen restores state
- import/export file reads and writes succeed through Tauri commands

### Import / Export
- startup and command palette imports create a new `.fable` document from a Markdown file
- export writes Markdown and HTML for the currently selected level

### Notices
- transient notices auto-dismiss
- notices render in the top-right corner as compact square-edged cards using inverse theme tokens
- dark theme notice surfaces match the selected-card surface token
- repeated external reload polling must not keep a notice alive when the document contents are unchanged
- document clock metadata churn alone must not trigger an external reload notice
- revision-only save churn must not trigger an external reload notice

### Command + Search
- Cmd/Ctrl+K opens a centered command palette
- desktop builds expose native Fablecraft / File / Edit / Card / Tools / Window / Help menus
- native File includes Open Recent after Open Document
- native File groups import and export together
- native Undo / Redo target the active editor in editing mode and the navigation history stack in navigation mode
- native Card actions reuse the same structural operations as keyboard shortcuts
- native Tools includes Enable Codex and Enable Claude Desktop alongside palette and search
- native Fablecraft menu includes Check for Updates
- native Window includes Reload, Zoomed In, Zoomed Out, Minimize, and Toggle Full Screen
- the palette shows at most five filtered results and stays input-focused until dismissed
- the palette input opts out of spellcheck, autocorrect, autocomplete, and autocapitalization so WebKit text-assistance popovers do not cover command results
- Show Command List, Settings, Enable Codex, and Enable Claude Desktop are the leading default commands
- the command palette exposes Open Recent; the action opens a focused overlay backed by the same capped five-path local history as startup
- the command palette exposes Check for Updates
- the command palette exposes Zoomed In and Zoomed Out, reusing the same actions as the native Window menu and zoom keyboard shortcuts
- the help sheet lists both Show Command List and Show Shortcuts
- the help sheet includes the merge shortcuts and merge command labels
- the command palette exposes Merge with Above and Merge Below when the active card has sibling targets
- integration setup commands show a tick when the local config already contains the Fablecraft MCP entry
- Cmd/Ctrl+F opens centered search over the document
- settings labels clearly distinguish theme, text size, line height, and card width
- settings overlays stay within the viewport and scroll internally when content is tall
- settings update token-backed UI immediately and persist locally

### Desktop Updates
- startup update checks prompt only when a signed update is available
- manual Check for Updates reports available, up-to-date, and failure states
- Install and Restart force-saves the current document before downloading and installing
- updater download progress appears in the in-app update prompt when content length is available
- app relaunches after a successful update install
- browser builds never invoke updater or process plugin behavior

### MCP
- `get_open_documents` returns all document paths currently advertised by running app instances
- `get_document` returns structured JSON for the active document plane, including `treeDepthCounts`
- `get_card` returns structured JSON for the active document plane, including ordered direct `childCardIds`
- `get_subtree` returns structured JSON for the active document plane
- `set_card_text` persists through the repository, converts Markdown heading lines into TipTap heading nodes, and returns a lightweight status result
- the Claude-compatible stdio binary accepts explicit `.fable` paths so Claude Desktop can call it directly
- local integration enablement searches both bundled app locations and nearby `target/release` / `src-tauri/target/release` development binaries
- structural tree mutation is exposed through create child, create sibling before/after, move card before/after another card, wrap contiguous sibling ids in a parent, and delete card tools
- `move_card` accepts exactly one of `beforeCardId` or `afterCardId`; the target card determines the destination parent and the moved card keeps its subtree
- external `.fable` changes should appear in the open app without a manual reopen when the document is not dirty
- MCP mutations remain a single undo step in the app state
- oversized MCP payloads return structured errors instead of partial responses

### Website
- browser builds render the public landing page instead of the desktop startup chooser
- the hero presents `The Writers Tool for Structured Thought`
- the first section after the hero shows the live demo workspace seeded from `src/site/tutorial.fable`, and no further main sections appear before the footer
- the website uses a minimal editorial layout distinct from the desktop editor UI
- the website and desktop app share the same soft pink-white paper and dark-ink visual language
- the Tauri startup window background must match the light paper surface so the transparent title bar does not flash white
- when `VITE_FABLECRAFT_GITHUB_OWNER`, `VITE_FABLECRAFT_GITHUB_REPO`, and `VITE_FABLECRAFT_DOWNLOAD_MAC_ASSET_NAME` are set, the hero primary action is a working download link to `https://github.com/<owner>/<repo>/releases/latest/download/<asset>` with a compact `BETA` label; when unset, the same label renders disabled (muted)
- the website hero uses `min-height: min(85vh, 860px)`, and the live demo shell uses `height: 85vh`
- the canonical public macOS asset is `Fablecraft-macos-arm64.dmg`, uploaded by the tagged GitHub release workflow
- Tauri updater artifacts are generated with `bundle.createUpdaterArtifacts = true`; the current tagged release workflow publishes the notarized macOS DMG, the `.app.tar.gz` updater archive, its signature, and a macOS-only `latest.json` manifest
- the desktop app checks the same signed updater manifest shortly after startup and through manual Check for Updates actions
- `.env.example` documents the required website env vars for Vercel or other static hosting
- maintainers publish a new website-backed macOS download by pushing a `v*` tag that matches the desktop version and letting the GitHub Actions workflow attach the renamed DMG asset to the release
- website runtime detection must not invoke desktop updater behavior in browser builds

---

## 8. Constraints

- no sidebar
- no card titles
- no plugins
- no collaboration

---

## 9. Definition of Done

- create/open document
- full keyboard navigation
- edit cards
- layout stable
- command palette works
- search works
- import/export works
- browser build ships the public website (hero, screenshot, footer) with a working hero download link when the GitHub macOS release env metadata is set

---

## 10. Notes for AI

- do not invent features
- prefer simple solutions
- leave TODOs if unclear
- keep UI adjustable via tokens
- prefer env-configurable URLs over hard-coded deployment assumptions for website infrastructure
Card numbering:
- Card numbering is derived at runtime from document structure, not stored in SQLite.
- The current implementation assigns labels by depth and visual order using a depth letter plus two-digit sequence, for example `A01`, `B01`, `B02`.
- Search results must display the derived card label alongside matched content.
Settings presentation:
- Settings rows should expose row-level keyboard focus visually with a leading chevron-style cue.
- Setting options may use stylized capsule controls, but keyboard behavior remains row-based: up/down moves between rows and left/right changes the current value.
- `SettingsDialog` tracks the active row separately from transient DOM focus and restores focus after preference writes so theme token updates do not drop chevrons or keyboard navigation.
- Native window appearance sync should restore window and webview focus while Settings is open because macOS/Tauri theme updates can make the webview stop receiving keyboard events until the window is clicked.
- The macOS title bar style is constant `overlay` chrome and must be applied only once per app process, effectively on app restart; do not call `setTitleBarStyle` during live theme switching because it causes native focus loss.
- Native window appearance diagnostics can isolate focus loss by setting localStorage key `fablecraft.native-window-appearance-diagnostic` to `no-native`, `set-app-theme`, `set-background-color`, `set-window-theme`, `set-title-bar-style`, or `all`; diagnostic mode intentionally skips focus restoration and logs `[theme-focus]` entries.
- Shared titled overlays should render a soft full-width rule beneath the title inside `OverlayShell`.
- `HelpSheet` should use the same surface and shadow treatment as Settings/Search overlays so support panels read as one coherent family.
- Help support surfaces should include a `getting-started` mode reachable from the native Help menu, command palette, and the startup surface.
- The startup and booting panels should visually mirror the website hero wordmark treatment instead of using a separate desktop-only title style.
- Startup, the command palette, and the native File menu should read recent-document history to populate an `Open Recent` path into a dedicated recent-files surface; bootstrap should no longer auto-open any document.
- Recent-document history should store up to five deduplicated paths in recency order while preserving the legacy single-path key as a compatibility fallback.
- `StartupPanel` should use `Structured Thought, Locally Crafted.` as its sole tagline, rendered below the horizontal rule in a lighter uppercase style with `Locally Crafted.` on a second line, and implement stable row-based keyboard focus so up/down arrows move between rows, `Escape` returns from the recent-files submenu, and the row chevron stays tied to the current selection state.
Tree editing:
- Empty-card backspace in the editor must distinguish between leaf deletion and wrapper removal.
- If the active empty card has children, the workspace should unwrap that card and restore focus to the originating child when known, otherwise the first child.
- Document history should maintain both editing and navigation stacks in the shared store so undo/redo can be dispatched consistently from keyboard shortcuts and native menu actions in either mode.
- New-document entry points should switch the app into editing mode immediately after opening the created document.
- The editor placeholder string is `Your story starts here` for the first root card only; later root cards and non-root cards should render without editing placeholder copy.
- Empty non-first cards should render a muted italic `empty card` placeholder in navigation and preview surfaces after editing is abandoned with no content. This placeholder must not be persisted into card content and must disappear when editing resumes and the user types.
- Escape and in-editor card-to-card arrow navigation should abandon an empty leaf card by deleting it before changing mode or focus, including at root depth, unless it is the only card in the document.
- When Backspace or Escape abandons an empty child leaf card from editing mode, focus should return to the deleted card's parent instead of the nearest spatial sibling.
- Empty-card deletion should allow removing a root-level card whenever any other card exists in the tree. The final remaining card in the whole tree is protected from removal, and navigation-mode deletion should clear its content instead.
- `CardEditor` should suppress `Escape`-to-navigation on the final remaining empty card so startup editing does not strand the user in navigation mode.
