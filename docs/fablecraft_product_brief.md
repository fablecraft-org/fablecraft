# Fablecraft — Product Specification&#x20;

## 1. Overview

Fablecraft is a desktop-first writing tool built around a **sideways tree of cards**.

Each card is a rich text editor. Cards form a hierarchical structure that users navigate spatially. The desktop editor exposes a single visible content plane per card.

The desktop editor remains the core product and stays local-first.
The public website at `https://fablecraft.xyz` is the companion surface for discovery, downloads, release communication, and support.

The product is:

- keyboard-first
- minimal (Typora-like)
- spatial (not list-based)
- AI-extensible via MCP
- anchored by a public website for download and product communication
- visually quiet, with soft pink-white paper surfaces and dark ink contrast across desktop and web
- branded by a simplified dark-ink sideways tree icon on a rounded shared-paper tile for desktop app icons and website favicons
- dark theme uses a neutral charcoal palette rather than a warm brown cast
- on desktop, cards and panels should feel nearly square, with only slight corner rounding and a shadow-led, architectural treatment rather than soft or pill-like shapes

### 1.1 Product Surfaces

#### Desktop Editor

- primary writing surface
- local-first
- opens and edits `.fable` documents
- registered with macOS as the owner/editor for `.fable` documents so Finder can open them directly in Fablecraft
- usable without any account
- checks for signed desktop updates from the published release channel and prompts before installing

#### Public Website

- public home for Fablecraft
- primary download destination for the desktop app (hero link targets the latest GitHub macOS release artifact when release config is set)
- place to explain the product and show the editor in action (hero plus product screenshot)
- release notes, update guidance, bug reports, and feature requests may live on external surfaces until dedicated pages return
- later, the place to sign in for sync and hosted AI connector flows once those are specified

Rules:

- the website complements the desktop app; it does not replace it
- stage two does not introduce a browser-based editor
- local writing must remain usable without a network connection
- update checks may require network access, but failed checks must not block local writing
- future sync and hosted AI connectors are staged follow-on capabilities, not part of the current local-only MVP behavior

---

## 2. Core Concepts

### 2.1 Cards

Cards are the fundamental unit.

A card is:

- a node in a tree
- a rich text editor
- variable height
- uniquely identified by `id`

Cards do NOT have titles.

### 2.2 Tree Structure

- Cards form a directed tree
- Structure is defined by:
  - `parent_id`
  - `order_index`
- Children are derived, not stored
- Paths (e.g. `0.2.1`) are computed
- The tree can be empty. Root cards are ordered siblings with `parent_id = null`. An empty Tree opens on an editable first card with the placeholder `Your story starts here`. The first edit saves that card.

### 2.3 Folder Context

- The workspace includes a shallow file-system context to the left of the document tree.
- While inside a document, file-system context cards are hidden. The document name (without `.fable`) appears centered at the top of the window in medium-weight text, including in overview. Long names truncate with an ellipsis.
- The document title sits over an opaque app-background surface with a gradual fade along its left, right, and bottom edges, so cards passing behind it cannot obscure the name. The title stays fixed when the writing canvas pans and does not intercept pointer or window-drag gestures.
- The current folder appears as a distinct folder card while navigating folder context.
- Folder and document context cards use different surfaces from writing cards and do not become persisted document cards.
- Folder and FABLE explorer cards render at half the width of writing cards.
- Explorer context card labels use plain `FOLDER` and `FABLE` labels.
- In directory navigation, Tab and Shift+Tab do not move browser focus between explorer cards or show a separate blue focus highlight; arrow keys control the selected file or folder. Rename fields and dialogs keep their normal keyboard focus behavior.
- FABLE explorer card names hide the `.fable` file extension.
- Folder and FABLE explorer cards follow the same spatial navigation model as writing cards: the selected explorer card is centered, its same-level siblings remain visible in the same vertical column, its parent sits one column to the left, and its remembered child (otherwise its first visible child) sits one column to the right on the same vertical center line.
- Left from a root card or an empty tree selects the current `.fable` document card. While editing a root card or the manuscript, Left at the first caret position also selects the current file. Escape from either editor selects the current file from anywhere in the text. A search or dialog handles its own Escape first. Left again selects the containing folder.
- Returning to the directory reveals the selected FABLE file, its sibling files/folders, and its containing folder. Returning right into the document hides all explorer cards and restores the centered title; moving left back out restores the explorer location, including a nested folder preview. The fixed title and all writing cards are hidden while browsing files and folders, including when the open FABLE file is selected. Right from the open file restores the document’s last Tree, Both, or Manuscript layout and the active pane. The layout and pane are also remembered when the document is reopened.
- When a folder is selected, its parent folder remains visible to the left when one exists, and the right column immediately shows only child folders and `.fable` files in the selected folder.
- Moving left from a FABLE file to its containing folder also shows that folder's public sibling folders and `.fable` files in the selected column. Up/Down and clicks select those same-level neighbours; Right selects the remembered child of the active folder, falling back to its first visible child.
- When a child folder row is selected inside a folder listing, that child folder's own child folders and `.fable` files appear immediately in the next column to the right.
- Non-`.fable` files are not shown.
- Dot-prefixed child folders (such as `.git` and `.private`) are hidden from folder listings and previews; only public child folders are shown.
- Selecting a sibling `.fable` document and moving right opens that document.
- Pressing Enter on a selected FABLE document card enters inline rename mode; typing edits the filename, Enter commits the rename, and Escape cancels it.
- FABLE document renames append `.fable` automatically, reject empty names and path separators, and do not overwrite an existing `.fable` file.
- Selecting a child folder and moving right or pressing Enter browses into that folder.
- Folder preview children are real navigation targets: Right from a selected child folder moves to its remembered child folder or FABLE file (otherwise its first visible child) before entering/opening that child.
- When returning to Tree, Right restores the selected card if the writer left from within that branch. At root depth it restores the remembered root, with the first root as fallback.
- Tab+Right, Tab+Up, or Tab+Down in directory mode creates a new untitled `.fable` file and selects its explorer card with the name ready to edit. From a folder card it creates inside that folder; from a file or child-folder entry it creates beside that entry in its containing folder, including nested previews.
- Creating a directory file keeps the existing document open in the background and stays in directory navigation. Enter confirms the new name; Escape or confirming an empty name keeps the generated `Untitled` name (or the next available numbered name). Right from the selected file opens it through the normal document-opening flow; creation alone does not enter the document.
- Pressing Delete or Backspace on a selected FABLE document card opens a confirmation dialog asking `Move "[file name]" and all its contents to Trash?` before moving the entire `.fable` file to the system Trash. It can be restored using the operating system until Trash is emptied; a Trash failure leaves the document open and never falls back to permanent deletion.
- The delete confirmation dialog shows centered rounded-pill Cancel and Move to Trash actions only; arrow keys move the highlighted selection between them and Enter activates the highlighted action.
- Confirming deletion of the currently open `.fable` file closes that document and returns to the startup surface.
- Folder cards cannot be deleted, and folder or `.fable` document cards cannot be merged, outdented, indented, or reordered with card-structure commands.

### 2.4 Single-plane Content

- topology and visible writing live in a single plane
- there is no layer feature in the desktop app, MCP contract, or persisted current schema
- older layer-backed files are migrated into single-plane card content when opened

### 2.5 Passage-anchored Child Cards

- In editing mode, select non-whitespace text and press Tab+Right to create a child associated with that passage. Cmd+M retains the native Minimize action.
- The native Card menu exposes the same action as `Create Child from Passage`, without a Cmd/Ctrl accelerator.
- The new card is an ordinary child appended after all existing direct children. It immediately receives editing focus and follows normal card-column positioning; it is not aligned to the passage's line.
- The passage keeps a persistent muted grey highlight, including in parent/preview cards. Its highlight becomes bright yellow when its associated child is selected or the editing selection/caret is inside that passage. Active yellow highlights use dark text in both themes.
- Clicking a highlighted passage opens its specific child in editing mode, using normal centering with the source parent visible to its left. The association uses the child id, so same-parent reordering never changes the target. It also updates the remembered child for horizontal return navigation.
- Each passage has one associated direct child. A card may contain multiple separate anchored passages. Overlapping associations are rejected with a notice; invoking the command within an existing passage opens its child rather than making a duplicate. With no selection, Tab+Right keeps its existing child-creation behavior. The native passage action opens an anchor at the caret or does nothing.
- Passage creation supports prose, including headings and lists. Selections containing inline code or code blocks are rejected with a notice because those formats exclude highlight marks; no child is created and formatting is preserved.
- Text edits within a passage retain its association. Deleting all anchored text leaves the child as an ordinary unanchored card. Deleting the child (including abandoning an empty child), or moving it to a different parent, removes the highlight without deleting source text.
- Creation of the child and the source highlight is one editing undo/redo operation. Existing snapshot history, autosave, reopen, and descendant badges include anchored children normally.
- Copying/pasting prose strips associations. Structural subtree paste remaps associations to the new descendant ids. Splitting a source retains anchors in text left with the original parent; text moved to a sibling loses associations to children it no longer parents. Merging cards retains associations when their children move with the merged content. Markdown/HTML export includes the prose without interactive anchors.
- Passage associations remain distinct from the arbitrary same-document references in §2.6. They do not add authors, replies, resolution states, or collaboration.


### 2.6 Inline Card Links

- Links reference an existing card in the currently open document using its fixed id. They display its current structural moniker (for example `B08`) and update when the target moves or is reordered.
- In editing mode, typing `#B8` or `#B08` followed by Space replaces the reference with a compact outlined rounded link chip and keeps the trailing space. Conversion happens only for an existing target, at a standalone token boundary, outside inline code and code blocks. Unknown references remain ordinary text. There are no suggestions, matching-card lists, or hover previews.
- Cmd/Ctrl+C in navigation mode still copies the selected writing card. Cmd/Ctrl+V in an editor inserts a reference to that source card at the caret or replaces the selected text, including in empty cards. Navigation-mode paste continues to copy content. Editing-mode text copy/paste remains ordinary prose copy/paste.
- Copied-card link paste requires an existing target in the same document; another document's card or a deleted source is rejected with a notice. Cut-subtree paste retains its existing structural move behavior, including empty editing targets.
- Chips render inline in both the active editor and surrounding cards, using centralized tokens and the card-identity visual language. Clicking a chip or focusing it and pressing Enter/Space opens the exact target in navigation mode. Arrow keys and Backspace/Delete treat the chip as a single inline object; removing it does not delete its target.
- A card containing only a link is nonempty. Self-links and reciprocal references are allowed. Links derive navigable reference children under the rules in §2.7 without changing card ownership.
- Deleting a target leaves a disabled, struck-through chip retaining its fixed id and last known moniker. Undoing the deletion restores the link. Another card acquiring that moniker never inherits the reference.
- Links participate in existing editing undo/redo, snapshot autosave, and reopen. Structural subtree paste remaps internal references to the fresh copied ids and retains external references only within the same document. Cross-document external references become ordinary moniker text.
- Markdown/HTML export and prose clipboard output include the moniker as text, without document-local interactive links.

### 2.7 Reference Children (Aliases)

- Each source–target pair mentioned by an inline card link produces one reference child, regardless of repeated mentions. Reference children are derived from the source's current content, not extra owned cards. Removing the last mention removes the reference child; creation/removal participates in the same content undo/redo operation.
- Aliases appear above all owned children, ordered by their first mention in the source's prose. They cannot be manually reordered or reparented. Links to any real ancestor of the source, including grandparents, remain inline-only and do not create reference children. A link to an existing direct child still has its own distinct reference appearance.
- Right enters the first owned child when any exists, otherwise the first alias. Up from the first owned child explores aliases above it. This owned-first rule overrides remembered-child selection for a source with visible aliases and for appearances reached through a reference. Unlinked canonical branches retain their existing remembered-child navigation.
- An alias displays the target's current canonical label, owned-descendant count, and a chain-link icon in the top right. Descendants viewed through a reference also show the icon. Counts always exclude reference children and use only actual owned descendants.
- Navigation tracks the displayed appearance path, not only the fixed target id. Left returns to the parent appearance through which the user entered, including through several linked levels. Up/Down follows the displayed spatial column. Selecting a reference card stays in navigation mode; Enter, typing, a second click on the active reference, or double-clicking it jumps to its canonical location before editing.
- Reference children expose the target's owned children and references as the user traverses them. A fixed card id may occur at most twice along any displayed path, counting owned and reference appearances. A child appearance that would introduce a third occurrence is omitted entirely. Self-links and cycles therefore terminate without affecting exploration in other branches.
- Creating a child, sibling or parent, merging, pasting card structure, or changing a subtree reached through a reference uses the underlying real card and returns to the canonical tree. A direct alias cannot be deleted or cut, nor can Shift+arrows or reorder menu commands move it. Delete/Backspace on it does nothing; users remove its inline references in the source instead. Owned descendants reached through aliases can be modified, with the same jump to their real location first.
- Deleting the original leaves a terminal reference card with `?` as its identity and a deleted-card placeholder, with no children or editing action. It retains the fixed target id, so undoing the deletion restores the reference. Inline chips retain their disabled broken-link appearance from §2.6.
- If the selected appearance disappears because a reference or source branch is removed, selection returns to the nearest surviving appearance along its path. Reference paths last for the current document session and reset on document changes; they do not alter persisted card identities.
- Normal layout renders the selected reference neighborhood. Overview includes owned cards and reference entries, expanding reference branches along the currently selected path rather than recursively materializing the entire graph. Further traversal reveals the next level on demand.
- Markdown/HTML export continues to traverse owned cards only and includes their existing prose/moniker text. It never expands or duplicates reference branches.

---

## 3. Card Lifecycle

- New cards start as a single empty paragraph using normal body text. Heading formatting is opt-in through Markdown markers such as `# `, `## `, or `### ` at the start of a line.
- Empty cards cannot create additional cards
- If abandoned empty → removed
- Deleting the final root and its subtree in Tree or through MCP leaves an empty tree. The manuscript remains available.
- Backspace deletes an empty leaf, including the final card.
- Deleting a card returns selection to the most recently visited card that survives the deletion. Creating a card and deleting it therefore returns to the card the user was on before creation. Visit history lasts only for the current document session; without a surviving visited card, normal spatial deletion fallback applies. Explicit arrow navigation still follows its requested destination when abandoning an empty card.
- Cards always render fully (no collapsing)

---

## 4. Interaction Modes

```ts
navigation | editing | search | command
```

### Navigation mode

- structural movement
- creation
- deletion

### Editing mode

- text editing, with explicit Tab+Arrow card creation

### Search mode

- Cmd/Ctrl+F results
- search is scoped to the document

### Command mode

- secondary actions (Cmd/Ctrl+K)

---

## 5. Keyboard Model

### Navigation

- Left → parent
- Right → last visited child during horizontal navigation, otherwise first child
- Cmd/Ctrl+Up / Down → first / last sibling sharing the selected appearance’s parent, including roots as one sibling set
- Cmd/Ctrl+Left → root card of the selected appearance’s branch; at a root, stay on that card rather than entering the directory
- Cmd/Ctrl+Right does not create or navigate cards. Cmd/Ctrl+Arrow retains native text-navigation/selection behavior in editing mode.
- A root jump remembers each traversed child so subsequent Right navigation can retrace the full path. Vertical jumps clear child memory when selection changes; repeated boundary jumps preserve it. Directory Cmd/Ctrl+Up / Down selects the first / last entry in the current set.
- Up → previous card in the current column
- Down → next card in the current column
- From a root card, Left moves to the current `.fable` document context card, then to its containing folder.
- In folder context, Up/Down moves through visible folders and `.fable` files; Right enters folders or opens `.fable` files; Enter renames selected `.fable` files.

Up/down follows the packed spatial column, even across different parent groups. Left/right changes depth. Reference appearances follow §2.7, including owned-first Right navigation and path-aware Left return. Moving left remembers the child just left, so moving right retraces the same path across multiple depths. Moving up or down to another card clears this child-selection memory, including when returning to the previous sibling; Right then starts at the first child again. The same memory applies to folders, FABLE files, and the root cards within the open document. Moving Up/Down between explorer entries clears it too; pressing an arrow at a column boundary without changing selection preserves memory. Memory lasts only for the open document session and falls back to the first child if the remembered child was deleted or moved.

### Movement

- Shift+Up / Down → move within the current column, including root cards and across parent groups
- Shift+Left → outdent
- Shift+Right → make the active card the last child of the sibling above, including at root depth; its descendants move with it. With no sibling above, leave the card unchanged.
- Option+Up / Down → merge with the sibling above or below while keeping the current card

### Creation

- Tab+Arrow is the sole modifier-based card-creation shortcut in navigation and editing modes. Native Card menu actions remain available without Cmd/Ctrl creation accelerators.
- In navigation and editing modes, Tab+Up / Down → new sibling above/below
- In navigation and editing modes, Tab+Right → new last child; in editing mode with selected text, create a passage-anchored child
- In navigation and editing modes, Tab+Left → wrap the current level in a new parent
- In directory navigation, Tab+Right, Tab+Up, or Tab+Down creates a new `.fable` file inside the selected folder or beside a selected child entry, starts inline naming, and waits for Right to open it.
- Newly generated siblings, children, parents, and the first card in a new document all default to normal paragraph text.

### Clipboard

- In navigation mode on a writing card, Cmd/Ctrl+C copies the active card's content and fixed source identity. Navigation paste copies content; editor paste inserts a card link (§2.6).
- In navigation mode on a writing card, Cmd/Ctrl+X cuts the active card plus its full descendant subtree and removes that subtree immediately.
- Cutting the final remaining root card clears that root card and removes its children.
- In navigation mode, Cmd/Ctrl+V pastes only valid Fablecraft card payloads.
- Pasting a valid Fablecraft card payload onto an empty leaf writing card fills that card in place, including while editing a newly created card. A subtree payload fills the active card with its root and recreates descendants beneath it; editing stays active.
- Pasting onto a writing card that already has content or children creates a new sibling card directly below it and pastes into that new card.
- Pasting copied content preserves the source card's rich formatting and does not create children.
- Pasting a cut subtree maps the pasted root onto the in-place or newly created target card and recreates the cut children below it with new card ids.
- Card clipboard payloads work across `.fable` documents through the system clipboard while each document keeps its own undo history.
- Folder and `.fable` explorer context cards ignore card clipboard commands.
- Editing mode keeps normal text cut, copy, and paste behavior inside the active editor. Copied-card payloads insert links (§2.6); cut-subtree payloads pasted into an empty leaf use the structural paste behavior above.

### Editing

- Type → enter edit mode and insert the typed character
- Enter → edit mode
- Escape → return to the open file in the directory. Leaving an empty leaf discards it. The most recently visited surviving card, then its parent, then the spatial fallback determines the selection on return to Tree.
- Backspace on an empty card → delete card
- Backspace on an empty leaf card → delete it and continue editing the most recently visited surviving card. With no visit history, prefer its parent, then the spatial fallback. Deleting the final card shows the empty Tree pane.
- Backspace from a trailing empty line removes that line immediately and returns to the previous line
- ArrowDown at the end of a card opens the card below in edit mode at the start of that card
- ArrowUp at the start of a card opens the card above in edit mode at the end of that card
- ArrowRight at the end of a card opens the first child in edit mode at the start of that card
- In editing mode, Tab+Arrow keys always create in the pointed direction, even when a sibling, parent, or child already exists, and focus the new card in editing mode. Tab+Right with selected text uses passage anchoring (§2.5). Empty cards cannot create more cards; the shortcut does nothing instead of navigating.
- Enter in an empty Markdown heading converts that heading to regular body text instead of creating another card
- Enter in a written heading keeps the heading intact and starts a regular body-text line below it
- Double Enter → new card below
- When Enter completes a blank-paragraph divide within a card, move all content below the divide into the new sibling below, preserve its formatting, and keep editing with the cursor at the start of that lower section.
- Tab+Enter → split at line
- markdown shortcuts render into rich text, including visible headings and lists
- leaving a card removes any trailing empty line from that card
- unselected cards preserve that rich structure in preview mode

---

## 6. Spatial Layout (Critical)

### Core Principle

> The model moves **left to right**, not top to bottom.

### Layout

- workspace renders as a bounded stage that fills the window
- stage background matches the card surface exactly
- on macOS, the native traffic-light title bar overlays the app content so it uses the exact same light/dark background as the workspace
- the top drag region spans the upper 128px of the window in Tree. In Manuscript and Both, dragging is confined to the title strip so writers can click and select prose at the top of the manuscript, including after scrolling
- Active card: vertically centered when it fits; horizontally positioned within the responsive column arrangement described below
- arrow-key navigation recenters the selected card and should not be immediately displaced by residual trackpad pan momentum
- When selection moves in navigation mode, visible cards that remain in view slide into their new positions over 150 ms. Wide Lens connectors move with their cards. Selection responds immediately, and the system Reduce Motion setting skips the slide.
- Parents: left-middle column
- Children: right column
- Siblings: above and below the active card
- Normal writing columns depend on available window width: one = active card and siblings; two = active card and siblings, children; three = immediate parent, active card and siblings, children; four = immediate parent, active card and siblings, children, grandchildren. When entering a sibling group at a leaf with two columns, show its parent on the left and the sibling group on the right. Moving between siblings preserves the group's current column regardless of whether the selected sibling has children. Ancestors beyond the visible parent column and other branches stay hidden. Overview continues to show the whole tree.
- The visible columns fill the window with equal card widths, fixed 24px gaps and 24px outer margins. Cards shrink until a 360px minimum reading width is reached, then the layout drops a column. Column transitions occur at 792px, 1176px, and 1560px of available workspace width; four is the maximum. In four columns the active card sits left of the window center. Visible levels retain their allotted space so selection does not change card width.
- The desktop window minimum size is 408 × 320 logical pixels. Directory cards retain their existing fixed sizing and arrangement; overview retains its fixed-size graph. The manual card-width setting is removed; legacy saved width preferences are ignored.
- Wide Lens is the zoomed-out structural overview: compact, fixed-size title-only card shells at a fixed zoom level. Every card has a soft shadow matching the writing-card shadow style, with no outline. The selected card uses the same shadow geometry with greater darkness, complementing the darker selected graph lines. Wide Lens shadows are visible in both light and dark themes. Hide descendant-count badges in Wide Lens, retaining card numbers and reference indicators.
- overview title shells are wide enough for short titles and may wrap title text across two lines
- overview breaks away from normal writing-view packing rules so it can show how the tree forks by depth
- overview draws parent-to-child Bezier connector lines from the right edge of each parent shell to the left edge of each child shell
- overview connector lines use warm gray theme tokens
- overview darkens connector lines along the selected card's parent chain and throughout the selected card's descendant subtree
- overview uses larger horizontal spacing between parent and child columns than the normal view
- overview opens with the current card centered; selecting another overview card recenters the structural map around that card, while trackpad / wheel panning may move the map away from center
- overview centers child groups around their parent where possible, while keeping adjacent child sibling centers no more than 200px apart
- overview uses the same fixed zoom level regardless of which card opened it; navigating between cards does not rescale the overview
- trackpad / wheel gestures do not trigger overview; once overview is open they pan the structural graph without changing the selected card
- Tree has three writing sizes. Compact uses 85% of the configured text size and line height, fits up to four columns using a 272px target minimum, and caps cards at 352px. Normal uses the responsive columns described above and the configured typography. Large uses 125% typography and a single centered column capped at 880px. The selected card and its siblings share that column when Neighbor Cards is enabled. Each size fits the available pane width, with 24px side margins or more.
- Cmd/Ctrl+= or + zooms in and Cmd/Ctrl+- zooms out. Window > Zoom In and Zoom Out follow the same order. Tree steps through Wide Lens → Compact → Normal → Large. Manuscript steps through Compact → Normal → Large with prose widths capped at 612px, 720px, and 900px and the same typography ratios as Tree. Zoom applies to the active pane and stops at either end. Window and the command palette offer direct Tree view choices. Enter in Wide Lens opens Normal in navigation mode.
- Both panes start at Normal when opening a document and remember their own zoom as the writer switches panes or resizes the window. Tree zoom preserves the selected card, child memory, and keyboard destinations at every size. Tree writing sizes preserve the active editor and selection while resetting shared pan and revealing the caret when needed. Entering or leaving Wide Lens returns Tree to navigation mode. Manuscript zoom keeps the editor and selection in place and reflows the passage margin bars. Directory cards keep their existing sizing and arrangement.
- overview may leave distant parts of the tree outside the viewport when the centered structural map is larger than the window
- returning from overview restores the normal rich-card spacing without temporarily packing long neighboring cards as minimum-height cards
- overview titles are derived from the first non-empty line of each card's existing content; cards still do not have separate persisted titles
- clicking a card in overview selects it as the return target without entering text editing
- at all Tree writing sizes, unselected cards keep the same text and surface color, but render without visible outline or shadow
- dark theme cards use lighter box surfaces instead of shadows; the selected editing card becomes lighter again
- dark theme card number labels use a light token so labels such as `A01` remain visible
- immediate parent aligns vertically with the active card
- in columns anchored by the active card, its ancestors, or remembered descendants, cards belonging to other parents prefer their own parent's top-aligned child slot; preserve tree order and push cards above the anchor upward or cards below it downward only when needed to avoid overlap
- A valid remembered child controls its group’s visual anchor as well as Right navigation: align it with its parent’s vertical center, clamping its top to the usable top edge when necessary to keep its start visible. Stack earlier/later siblings above/below in tree order; the first child may overflow above. Remembered return paths take priority over group centering.
- Without a remembered child, center the child group’s complete height (including gaps) on its parent. Clamp its top to the usable top edge if the group would extend above it; excess cards overflow below. A single child follows the same centering rule. Grandchild groups follow these rules, with neighboring groups displaced outward when needed to avoid overlap and preserve order.
- The underlying spatial layout retains hidden branches for column navigation: first children of other parent groups prefer their parent's top-aligned slot, with later children stacked below, while avoiding the active child group or reserved empty child slot. Visibility filtering does not change tree order or keyboard destinations.
- anchoring the active child group must not reorder neighboring sibling subtrees in that same child column
- when the layout includes the child column and the active card has no children, the child column shows no writing cards and retains a full empty child-creation slot centered on the active card
- that empty child slot matches the selected card footprint but stays visually invisible against the workspace background while remaining clickable for first-child creation
- no helper copy, mode labels, or structural labels outside cards

### Spacing

- column gap = sibling gap
- default = 24px

### Visibility

- show as much as fits
- prioritize the active column, then children, then parent context, then grandchildren as the window widens. A two-column view can use the left column for the parent as described above.
- cards may be partially off-screen

### Card Size

- variable height
- height is tracked per card
- cards retain their measured height in both navigation and editing, and preview heights remeasure after content changes
- height measurement follows the full rendered card surface so selection does not change wrapping or sibling spacing
- Active cards shrink to their current content after text is removed or split; an earlier height or initial estimate must not leave blank space below the text beyond the normal padding and minimum card height.
- the active card keeps the same content box and text reflow between navigation and edit mode
- cards keep generous internal padding without changing footprint across modes
- card content padding is expanded by 10px to increase breathing room
- the focused card uses the elevated active shadow in navigation mode and editing mode so focus is clear before typing begins
- focused cards do not resize just because they are selected
- focused and unfocused cards keep the same footprint
- only the currently selected card shows elevated shadow treatment
- at all Tree writing sizes, unselected cards have no visible outline or shadow
- when a selected card is taller than the window, navigation mode keeps the card top and title visible while the body overflows below the viewport
- Entering edit mode alone preserves placement. Only manual panning or revealing a caret/selection further down may move the card start above the viewport. Caret movement and typing pan the whole frame only enough to keep the selection head visible; resizing while editing also preserves caret visibility. The usable top/bottom inset is 48px.
- cards only grow when content adds lines
- no scrolling inside individual cards
- no nested scroll

### Mouse

- click card:

  - center
  - enter edit mode
  - cursor placed near click
- trackpad / wheel gestures pan the entire bounded normal stage and the overview graph without showing scrollbars. Manual pan persists until selecting a card by click or keyboard restores its structured arrangement; typing and caret movement only pan as needed to reveal the selection.
- Keyboard and Window zoom apply to the active pane. Wheel and trackpad gestures pan the Tree or scroll the Manuscript.

### Animation

- <150ms
- smooth
- slight ease-in/out

---

## 7. Single-plane Writing

- the desktop editor exposes one visible content plane only
- there is no layer UI, layer switching, layer creation flow, or layer-backed content scope
- all card borders use the document theme

---

## 8. Command Palette

Trigger: Cmd/Ctrl+K

Behavior:

- centered panel
- no title bar
- type to filter
- show at most 5 results
- arrows navigate
- Enter executes
- Escape closes
- command input disables spellcheck, autocorrect, and autocapitalization so text-assistance popovers do not cover results
- settings are opened from here as a centered modal

Commands:

Default order:

- Help
- Settings

Document:

- New Document
- Open Document
- Open Recent
- Import Markdown
- Export Level (MD / HTML)
- New Document From Tree

Structure:

- Merge with Above
- Merge Below

View:

- Wide Lens
- Compact
- Normal
- Large

Integrations:

- Enable Codex
- Enable Claude Desktop
- show a tick once the local config already contains the Fablecraft MCP registration

Help:

- Show Command List
- Show Shortcuts

NOT included:

- create/delete/move cards

---

## 9. Native Menu Bar

Desktop builds expose native menus with the following structure:

### Fablecraft

- About Fablecraft
- Settings
- Hide Fablecraft
- Hide Others
- Show All
- Quit

### File

- New Document
- Open Document
- Open Recent
- Save
- Import Markdown
- Export Markdown

Import and export should appear together as a grouped block.

### Edit

- Undo
- Redo
- Cut
- Copy
- Paste

### Card

- Merge Above
- Merge Below
- Shift Up
- Shift Down
- Split
- Create Child
- Create Parent
- Create Above
- Create Below

### Tools

- Command Palette
- Search
- Enable Codex
- Enable Claude Desktop

### Window

- Reload
- Zoom In
- Zoom Out
- Wide Lens
- Compact
- Normal
- Large
- Minimize
- Toggle Full Screen

### Help

- Shortcuts
- Commands

The native menu should trigger the same underlying application actions as keyboard shortcuts, editor actions, and command-palette commands.

---

## 10. Search

- Cmd/Ctrl+F
- search content in the document
- arrow navigation
- Enter → jump

---

## 11. Settings

Access: command palette

Command label: `Settings`

Minimal only.

Includes:

- theme
- light
- dark
- font
- text size
- default reading scale should stay slightly compact to preserve card density
- line height
- automatic card width based on the window (no manual width control)
- neighbor cards visibility
- row-based inline controls instead of native selectors
- keyboard navigation is preserved: Up/Down move between setting rows, Left/Right change the current row
- the active row remains selected after immediate preference changes such as switching between light and dark themes
- while settings is open, those keys should not move the tree in the background
- settings panel stays inside the window and scrolls internally when needed
- changes apply immediately through centralized tokens

All UI values must be configurable tokens.

---

## 12. Startup Behavior

- show the bottom beta notice until the user dismisses it with ×; dismissal is remembered locally across new windows and app restarts, for all documents, and is not reset by appearance settings

- always show the centered startup panel instead of auto-reopening a document
- show Open Recent when recent documents exist
- Open Recent presents up to five `.fable` files ordered by recency
- Before showing recent files at startup or opening Open Recent, check that every saved path still points to a file. Remove missing files and directory paths from saved history, preserving recency order. Recheck each time Open Recent is opened.
- always show:
  - New
  - Open
  - Import

Keyboard accessible.

---

## 13. Storage

- `.fable` = single SQLite file

Rules:

- one document open at a time
- autosave only; Cmd/Ctrl+S force-flushes pending autosave work without introducing a visible save button
- opening or creating another document force-flushes dirty changes in the current document before the active document changes
- when the open `.fable` file changes externally, the workspace refreshes once local edits are no longer dirty
- opening a document in a newer file format prompts the user to update Fablecraft and leaves the active document in place
- if another build upgrades the open file before pending edits can be saved, autosave pauses and the user can save those edits in a separate copy

---

## 14. Import / Export

Import:

- markdown → single card
- import creates a fresh `.fable` document from the selected Markdown file

Export:

- one level only
- export targets the currently selected level
- export filename defaults to the document name
- markdown and html outputs separate cards with clear level separators

New document from tree:

- New Document From Tree opens the standard document save dialog with a filename suggested from the selected card. The selected card becomes the root of the new `.fable` document, and all descendants move with it in their original hierarchy and sibling order.
- Once the new tree is saved, the command removes it from the source document and opens the new document. If the selected card was the source's only root, the source keeps an empty root card.

---

## 15. AI / MCP

- app exposes structure through a local MCP tool surface
- read tools: open documents, document, card, subtree, manuscript
- local Claude-compatible stdio MCP server is available for external tool use
- mutation tools: set card text, create child, create sibling before, create sibling after, move card before/after another card, wrap level from a card-id list, delete card, edit manuscript
- desktop app writes a local open-document session file so external MCP clients can discover active `.fable` paths; the response may include multiple paths for multiple app instances or future tab/window surfaces
- `get_document` includes structural tree depth counts, for example `[1, 4, 7, 32]` for card counts by depth from root outward
- `get_document` includes the saved revision and manuscript word and character counts. An absent manuscript has null metadata. Word counts use whitespace-separated text and character counts use UTF-16 code units.
- `get_manuscript` can read plain text by an inclusive start and exclusive end character offset. Each page provides the editor ranges for its text blocks and the passage links touching them. Clients can pin reads to the saved revision and use the continuation offset for large ranges. Omitting the range reads the full rich manuscript.
- `edit_manuscript` can insert, replace, or delete text within one text block using the same character offsets and the revision from a read. Edits preserve formatting outside the edited range and use the manuscript passage-link mapping rules. Rich-text edits use editor positions and rich nodes.
- `get_card` includes ordered direct child card ids when present
- external MCP writes should appear in the open document without manually reopening it
- `set_card_text` converts Markdown heading lines such as `# Title`, `## Section`, and `### Beat` into rendered card headings while leaving other Markdown syntax as ordinary text
- MCP tools do not expose layer ids or layer operations
- older layer-backed files are migrated into the single-plane schema; layers are not retained as a compatibility feature

Rules:

- transactional
- one action = one undo
- structured errors
- payload limits enforced
- mutation responses return lightweight status payloads rather than full document snapshots

### Notices

- transient notices appear in the top-right corner as compact square-edged card surfaces
- notice cards use inverse theme colors: dark card in light theme, light card in dark theme
- in dark theme, notice cards use the selected-card surface color

---

## 16. Public Website

Hero slogan:

- `The Writers Tool for Structured Thought`

Core jobs:

- communicate what Fablecraft is and who it is for
- drive desktop downloads from `https://fablecraft.xyz` (hero CTA links to the latest GitHub macOS DMG via a stable `releases/latest/download/...` URL when release config is set)
- introduce the spatial tree through a live browser demo seeded from the repository tutorial `.fable` document
- prepare a future authenticated surface for sync and AI connector management
- deeper distribution and support surfaces (release notes, multi-platform download grid, feedback forms) may return or move to external pages as the product matures

Initial site structure (current):

- hero section with the core slogan and a download CTA (disabled label when the GitHub release config is absent); the live macOS download CTA is marked with a compact `BETA` label
- live demo section immediately below the hero, then the footer

Rules:

- the site is a marketing, distribution, and support surface first
- the desktop app remains the primary place where writing happens
- update delivery may be website-backed, but the writing workflow stays local-first
- the macOS website download should resolve against the latest GitHub Release asset without client-side GitHub API calls
- feedback and release communication may use external tools (for example GitHub Issues or mail) until dedicated site sections are restored
- future sync and AI connector features require a separate explicit scope definition before implementation
- the website should stay sparse: generous spacing, minimal copy, and only the information required to download, understand, update, or contact the product
- the website should feel hero-led and architectural rather than section-heavy or dashboard-like
- the hero and live editor demo should each occupy roughly 85% of the viewport height on desktop-sized layouts

---

## 17. Desktop Updates

- the desktop app checks the configured signed Tauri update manifest shortly after startup
- available updates are presented in a minimal in-app prompt with `Install and Restart` and `Later`
- the app menu and command palette include `Check for Updates`
- manual checks report when Fablecraft is already up to date or when the check fails
- installing an update saves the current document before downloading, installing, and restarting the app
- failed background checks stay quiet; failed manual checks or installs show concise user-facing errors
- update delivery does not change the local-first writing model, require an account, or introduce sync

---

## 18. Non-Goals

- no sidebar
- no graph view
- no browser-based editor in stage two
- no mandatory account for local writing
- no collaboration
- no plugins
- same-document inline card links, derived reference children, and passage-anchored direct children are supported as defined in §2.5–2.7. Manuscript-to-card links are defined in §20. Cross-document links remain outside scope
- no multi-select
- no sync in the current MVP
- no hosted AI connector accounts in the current MVP

---

## 19. Summary

Fablecraft is a:

- spatial writing tool
- card-based tree
- single-plane editor
- keyboard-first interface
- desktop-first editor with a companion website for download and support

Its core innovation is allowing users to move across **levels of abstraction** while maintaining a clean, minimal interface.
Card identity:
- Each card shows a human-friendly structural number in the top-right corner.
- Cards leave the top-left corner free of identifiers. Immediately to the left of the top-right structural number, a small rounded card-shaped outline shows the total descendant count (children, grandchildren, and deeper descendants, excluding the card itself). Leaf cards hide the badge entirely; hidden descendants are included. Writing cards show this badge; Wide Lens omits descendant counts while retaining the structural number.
- The current first-pass numbering model is grid-like by depth: root cards begin at `A01`, their children at `B01`, `B02`, and so on.
- The numbering is present in workspace cards and search results to make navigation and discussion easier without introducing titles.
Settings clarity:
- The settings dialog must make keyboard focus obvious at the row level, so users can tell which setting is currently targeted before changing values.
- Exactly one setting row shows a chevron, matching the row targeted by keyboard changes; moving selection removes the previous chevron immediately.
- Inline setting choices should read as tactile pill controls rather than plain text buttons.
- Titled overlays should use a subtle full-width divider under the heading so panels feel structured without introducing heavy dark borders.
- The shortcuts and command list panels should share the same soft, shadow-led overlay language as Settings and Search rather than using separate card-grid styling.
- Fablecraft should expose a short getting-started guide from the Help menu, the command palette, and the startup surface.
- The desktop startup surface should use the same `fablecraft` wordmark styling and slogan treatment as the website hero.
- The startup surface should use `Structured Thought, Locally Crafted.` as its tagline instead of `The Writers Tool for Structured Thought.`
- The startup tagline should sit below the horizontal rule, use a lighter tone, and render in capitalized styling.
- `Locally Crafted.` should render on its own line in the startup tagline.
- The app should always open on the startup surface rather than auto-reopening a document.
- If recent documents are known, the startup surface should show an `Open Recent` option that opens a dedicated recent-files panel with up to five `.fable` files ordered by recency.
- The command palette and native File menu should expose `Open Recent`; selecting it should present the same five-item recent-document history.
- The recent-files panel should include a final `Back` option, and `Escape` should also return to the main startup menu.
- The startup surface should be keyboard-friendly: focus should land on the first row, the chevron should stay aligned to the current row, and up/down arrows should move between rows.
Editing behavior:
- Backspacing an empty structural parent that still has children must remove the wrapper and return focus to the child flow, not delete the entire subtree beneath it.
- Undo and redo should work in both navigation mode and editing mode, using the same document snapshot model rather than splitting behavior between modes.
- A newly created document should open directly into edit mode on the first card.
- The editing placeholder copy should read `Your story starts here` on the first card only, not on later root-level cards.
- Empty non-first cards should render a muted italic `empty card` placeholder after the user leaves editing with no content; the placeholder is visual only and disappears as soon as the user starts typing.
- Escape or in-editor arrow navigation away from an empty leaf removes the abandoned card. Escape or Backspace on the final empty card can leave an empty tree.

### Document Trash cleanup

- If moving a document to Trash fails, the confirmation dialog shows the system error and document path beneath the safety message so the failure can be diagnosed.
- On macOS, if the native Trash operation fails, Fablecraft asks Finder to move the document to Trash. This fallback may prompt for permission to control Finder; if it also fails, the dialog shows both errors. Neither method permanently deletes the file.
- Trashed documents disappear from the tree and recent-document list. Trashing the open document clears its cached contents and history and returns to startup; trashing another document keeps the current document open.
- On macOS, restore a trashed document by dragging it out of Trash and opening it again. The native Trash API may not provide Finder's Put Back action.

## 20. Manuscript v1

A .fable document can contain one continuous rich-text manuscript alongside its idea tree. Its reading order is independent of cards. [Manuscript v1 specification](manuscript_v1_proposal.md)

- **Workspace.** Show Tree, Show Both, and Show Manuscript are available in Window and the command palette. Both keeps Tree on the left and Manuscript on the right, with a single-line divider that responds to pointer and keyboard resizing. Dragging the divider preserves pane focus and text selection. Manuscript keeps at least 32 px of space on each side at split-capable widths and 24 px in narrow windows. Below the split breakpoint, the active pane fills the window and Show Both indicates that more width is needed. Widening restores the requested split unless the writer explicitly chooses a single pane. The requested layout, last active pane, and divider ratio are local per-document preferences, including when the manuscript is blank. Pane changes preserve the editors, their selections, and scroll state during the session. In Both, the selected Tree card keeps its place while Manuscript has focus and regains its active styling when Tree regains focus. Tree and Manuscript retain their own writing sizes as focus changes.
- **Keyboard.** Use Cmd+Option+Left/Right on macOS and Ctrl+Alt+Left/Right on Windows and Linux. At split widths, the first step reveals and focuses the other pane. A second step in the same direction opens that pane alone. Below the breakpoint, each direction opens its destination directly. The shortcuts ignore repeats and composition. Focus Pane Left and Right also appear in Window and the palette. Cmd/Ctrl+F searches the active pane.
- **Creation and editing.** Entering an empty Manuscript pane focuses a blank editor. The first edit creates the manuscript in one undo step. Write Manuscript explicitly creates and focuses an empty manuscript. Import Manuscript Markdown remains available from File and the command palette. Navigation-mode card copy pastes the card's own formatted prose in the manuscript. Chips become label text. The manuscript uses the card prose schema and normal rich-text editing. Use cut and paste to rearrange prose. Clearing the prose leaves an empty manuscript in place and clears its passage links. Undo restores both the prose and links. Undo is chronological across both panes once a manuscript is part of the document session.
- **Passage links.** Control+L on selected manuscript prose focuses Tree. Navigate as usual or click an idea card, then press Enter to link the selected card. Enter returns focus to the passage with the caret at its start. Escape cancels and restores the selection. Typing an existing card ID such as `#B02` links the whole manuscript paragraph and consumes the ID. In Both, its card becomes active as soon as the ID is accepted. A tag on a blank line shows the margin bar immediately, and the first prose in that paragraph persists the link. The linked range grows as the writer continues the paragraph and ends when Enter starts the next one. A thick grey line in the left margin marks the linked lines and adjusts when the text wraps. Each character can link to one card. A new link replaces the target wherever the ranges intersect and preserves older links outside that range. In Both, a manuscript selection touching a passage activates its linked card in Tree while the manuscript keeps keyboard focus. A selection spanning separate links activates the first linked card in reading order. Card footers show backlinks in reading order and each entry places the caret at the start of its passage, including in aliases and Wide Lens. The × beside a backlink removes that association in one undoable step and keeps the prose. Logical line labels follow paragraph and hard-break structure and remain stable when prose wraps differently.
- **Revision.** Text edits map ranges with the prose. Pure deletion removes a passage when no linked text survives. A whole-span replacement keeps its targets. The first successful paste of a cut in its source manuscript carries linked fragments and retains the identity of fully moved passages. Later pastes, copy, and cross-document paste insert independent prose. Deleted targets are pruned without affecting other targets. Undo and redo include the links each edit changed.
- **Files.** File and the palette expose separate Import and Export Manuscript Markdown commands. Import reads and validates UTF-8, confirms replacement and loss of existing links, and is undoable in one step. Export writes the whole current prose with a suggested ` - Manuscript.md` suffix. Markdown carries supported rich formatting and regular URLs. Passage IDs and card associations remain in the .fable file.
- **External changes.** A clean window refreshes after a validated external write. A stale save keeps the local edits in memory and offers Save a Separate Copy and Reload Latest Revision. The writer can explicitly discard local changes after confirmation.
- **Deferred.** Write locking, comments, and alternate manuscripts remain outside this increment.


## History v1

[History v1 proposal](history_v1_proposal.md)

The History heading and close button stay visible while the snapshot list scrolls. The timeline ends with the earliest retained snapshot, followed by the document’s original creation date and time in plain text.

- **Browse.** Open or close History with Cmd+Shift+H on Mac, Ctrl+H on Windows and Linux, or Tools → Toggle History. The command palette also offers Show History. History opens to the right of the active Tree or Manuscript pane, or full width with Back on narrow windows. A close icon sits at the top right. The timeline starts with Current selected and shows retained snapshots with the newest first. Preload ten historical rows and their saved diffs while the document is open. Show available rows immediately while checking for updates, then fetch the next ten in the background. New saves can add their predecessor to the archive. Older hidden saves never become timeline entries. Beginning to edit Current closes History. The History panel matches the background of the displayed Tree or Manuscript pane. Timeline cards have transparent backgrounds and equal width and spacing. The selected or keyboard-focused snapshot uses the Tree card shadow. Up and Down move between timeline entries and load older saves as needed. Enter focuses the selected snapshot’s read-only Tree or Manuscript. Escape returns to the selected timeline row. Escape from the timeline or the History shortcut closes History and restores the previous live layout and pane. Each save shows a concise local time label and its exact timestamp on hover. Labels use elapsed seconds or minutes for the last two hours, a local time with hours, minutes, and am or pm for Today, Yesterday, and weekday labels through the preceding seven local calendar days, and the full date thereafter. A historical preview keeps the live workspace available by returning to Current.
- **Inspect changes.** A snapshot opens directly in the regular read-only workspace. A Tree-only change opens Tree and a Manuscript-only change opens Manuscript. Mixed changes keep the displayed pane. Each pane opens at an affected location when available. Added text is highlighted relative to the previous visible save. Timeline rows show rounded card IDs only when cards changed, using green for additions, orange for edits and moves, and red for deletions. Green and red totals include characters added and removed across cards and the manuscript. Current represents the latest save and shows the same diff summary against the first historical card beneath it.
- **Restore.** Press Enter on a historical card or manuscript to request editing. Confirm to restore the entire snapshot, including the tree, rich prose, manuscript, and passage links, as a new latest revision. History closes and editing starts in the chosen card or manuscript. The restore leaves intervening snapshots in the archive and is undoable as one edit. A save from another writer leaves the historical view in place, refreshes Current, and requires confirmation against the updated Current. Escape dismisses confirmation first. Unavailable, expired, and identical snapshots cannot be restored.
- **Copy.** Copy a formatted text selection or use Cmd/Ctrl+C in historical Tree navigation to copy the active subtree. Pasting a subtree beside a live card assigns fresh IDs, remaps internal references, applies normal rules for external references, and creates one undoable change. A loaded snapshot remains readable and copyable if its revision expires while History is open.
- **Retention.** When a save replaces Current, evaluate that previous snapshot once. Keep burst boundaries, substantial pre-loss and restore checkpoints, and same-burst drafts whose recoverable edits meet the threshold. Immediately prune low-value saves from the same burst. Every ten minutes, thin the retained archive by age. Reserve a ten-minute landmark for saves aged ten minutes to an hour, an hourly landmark through 24 hours, a six-hour landmark through seven days, and daily or weekly landmarks thereafter. Older bands allow fewer recovery saves or require higher scores. [Adaptive retention policy](history_v1_proposal.md#physical-pruning)
