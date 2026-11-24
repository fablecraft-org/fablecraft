# Manuscript v1 — product and engineering specification

**Status.** Implemented in Fablecraft 0.6.0. The product and engineering briefs describe the shipped behavior.

## Scope

The writer can keep zero or one manuscript in each local .fable document. The manuscript is continuous, independently editable prose with the same rich Markdown writing experience as cards. Its reading order is independent of the idea tree. Each character can link to one idea card, and a card can lead back to many passages. New links replace earlier links over the same text. Markdown import and export apply to the whole manuscript. Use [History](history_v1_proposal.md) to browse and recover prior manuscript revisions. Comments, alternate manuscripts, and write locking remain deferred.

**Revision features.** Use cut and paste to move prose and its links. Defer alternate wording, suggested edits, a dedicated outline and comparison views. Integrate manuscript edits with existing undo/redo and autosave. The writer can organise prose with headings without first dividing it into named passages.

## Creating and viewing a manuscript

| Situation | Result |
| --- | --- |
| Open a document with no manuscript | Open Tree. Choosing Both or Manuscript shows a blank editor. Focusing it places the caret so typing or pasting creates the manuscript in one undo step. Viewing the pane alone makes no document edit. |
| Choose Write Manuscript from the menu or palette | Create one empty rich-text document, focus its caret and autosave. An intentionally empty manuscript survives reopen. |
| Switch views | Tree, Both and Manuscript are directly addressable. Both places the tree on the left and manuscript on the right. Preserve each pane’s selection, scroll position and tree zoom during switches. |
| Enter Both | Directional entry focuses the newly revealed pane. Direct menu entry to Both preserves focus. A single-pane command focuses its destination. Clicking a pane activates it. Announce the active pane without adding an outline beside the separator. |
| Resize | Start around 40% tree and 60% prose. A single-line divider is adjustable by pointer and keyboard. Keep a readable maximum text width. Compute the Both breakpoint from the minimum readable widths of one tree card and the manuscript, their padding and the divider. Below it, show the active pane only. Left goes directly to Tree and Right directly to Manuscript. Direct Both is unavailable with an explanation. Preserve both carets/selections and restore a previously requested split on widening unless the writer explicitly chose a single-pane layout. Test on either side of the breakpoint and at 408 px. |
| Return to a document | Remember layout and split ratio per document locally. Restore Tree if the manuscript has been removed. Layout, focus, cursor and zoom are presentation state outside document undo. |
| Remove Manuscript | Explicit command confirms removal of prose and its passage links, then returns to Tree. One undo restores both. Clearing all prose during editing leaves an empty manuscript. |

## Keyboard and command routing

Use Command+Option with Left/Right on macOS and Ctrl+Alt with Left/Right on Windows and Linux. Each distinct press takes one step. Ignore key repeat. Clicking a pane in Both sets the active pane directly.

| Starting state | ⌘⌥← / Ctrl+Alt+Left | ⌘⌥→ / Ctrl+Alt+Right |
| --- | --- | --- |
| Tree only | Stay | Both, manuscript active |
| Both, tree active | Tree only | Both, manuscript active |
| Both, manuscript active | Both, tree active | Manuscript only |
| Manuscript only | Both, tree active | Stay |

The table applies where Both fits. Below the breakpoint, a backlink opens the full manuscript and following a source opens the full tree. This mapping applies while writing as well as browsing an open document. Require the full chord so ordinary modified-arrow navigation in text and the tree retains its existing behavior. Test desktop-level interception on each supported platform. Expose both directional actions through the menu and palette even when the desktop captures a chord. Keep all three direct layout choices in the menu and palette.

Use literal Control+L on every platform to link a non-whitespace manuscript selection. In Both the manuscript must have focus. Route this only on an eligible selection in a writable manuscript. Apple lists Control+L for centering the cursor or selection and Command+Left/Right for line navigation. Verify contextual routing in the shipped webview. [Apple keyboard shortcuts](https://support.apple.com/en-us/102650)

Expose named commands in the native menu, command palette and shortcut help. Pane focus and layout are independent. Show and announce which pane is active. Directory navigation is tree context and cannot supply a link target. Dialogs, IME composition, menu tracking and link target selection take precedence over workspace keys. Tab retains accessible focus traversal outside the existing tree-specific gestures. Pane switching commits current editor input before changing focus and never deletes an empty card as a side effect of the switch.

## Manuscript editing, order and search

- Share the card editor’s prose schema, typography, Markdown input rules, supported marks, headings, lists, quotes, code, hard breaks and ordinary web links. Keep card-specific structural gestures scoped to cards. Enter makes normal prose blocks, including after blank lines. Typing an existing card moniker such as `#B02` in a manuscript paragraph adds a link to the full paragraph and consumes the ID. A tag alone activates the card and shows the grey margin bar. The first prose in that paragraph persists the association. Continuing that paragraph extends the linked span. Enter starts a separate paragraph. Pasting a moniker or typing it in code leaves it as plain text. Copying a whole card in tree navigation and pasting into the manuscript inserts that card’s own rich prose at the selection, excluding descendants. Selecting all its prose in the card editor and copying works too. Resolve card-only chips to their readable labels and omit card-only annotations. The source survives independently. One paste is one undo step. Support pasting into the focused empty manuscript pane as its first edit, creating the manuscript and inserting the text atomically. This is the workflow for an existing draft card. Use the link command for selected spans, or type a card ID to link the full paragraph.
- Use cut and paste to move paragraphs, lists, blockquotes, or smaller fragments within the manuscript.
- Cmd/Ctrl+F searches the active pane. Manuscript search is ordered by reading position and reveals and selects each result. Existing tree search and tree zoom keep their meanings in Tree. Menus enable operations according to pane focus.
- Undo/redo runs through shared document history across both panes. Linking one card to one passage, moving prose, deleting a card and importing a manuscript each undo atomically, including their link effects. Switching focus or following a link creates no undo entry.

## Linking a passage to ideas

1. Start in the manuscript editor. Select non-whitespace text, press Control+L, and switch focus to Tree. Keep the manuscript visible in Both while choosing. A card footer follows existing links; link creation always begins with manuscript text.
2. Use the normal Tree navigation keys or click a card. Press Enter to confirm the selected card. Directory navigation and card edits are unavailable while choosing. Escape cancels.
3. Restore the previous manuscript layout and focus. Confirmation leaves the caret at the passage start and cancellation restores the original selection. A grey bar in the left margin spans the linked text’s rendered lines. Press Control+L again to change the target. Relinking is one undoable operation. Choosing the same card on the same range is a no-op. A new link replaces older links over its selected text and preserves their portions outside it.

4. The manuscript margin bar marks linked text. In Both, selecting linked manuscript text activates its canonical card in Tree while retaining manuscript focus. A selection touching multiple distinct links activates the first in reading order. The tree’s existing select-text-to-create-child and inline card-link behaviors retain their own semantics.
5. Targets are existing, owned writing cards in the same document, including roots. A reference appearance resolves to its canonical card. Exclude missing targets, files, folders and the manuscript itself. New idea creation while choosing a target and linking from an implicit caret-only paragraph are deferred.

## Card backlinks and line numbers

- The × next to a backlink removes its passage association without deleting manuscript text. Undo restores the association. The control is available in the normal footer, overflow, and Wide Lens list.

- Show a short excerpt from the beginning of each linked passage in manuscript order. Where useful, prefix it with a compact logical line label, for example “L12 · The nurse moved the cart…”. Count logical text blocks, hard breaks and literal code newlines starting at 1. Wrapped screen rows depend on pane width and font. Two entries may have identical labels or excerpts; each activates its own passage ID. Editor character positions are internal coordinates. If space is tight, prioritise the excerpt. Recompute excerpts and optional labels as prose changes.
- Clicking or keyboard-activating a footer entry opens Both from Tree when width permits, or the full manuscript on narrow windows, scrolls the exact passage into view, and focuses the manuscript with a caret at the passage start. The original card stays selected and the leftward pane shortcut returns focus there. Accessible names include the line range and excerpt. In normal card previews show up to three entries plus a keyboard-operable “N more”. In Wide Lens use a compact count with access to the same list, preserving fixed shell size. Reference appearances show the canonical card’s backlinks.
- Example: two sentences in a single paragraph can both read “Line 4”. Activating the second entry must land on the second sentence. Inserting a paragraph above updates both labels to “Line 5”.

## Range behavior during revision

On the first confirmed link, allocate a persistent passage UUID and record its current start and end positions plus its target card ID. The half-open range includes the start and stops just before the end. Each committed editor transaction maps the positions forward in the same document change, including edits made before the passage. Inside a text node the editor counts UTF-16 code units; rich-text block boundaries also occupy positions. Save these coordinates alongside the exact manuscript revision they describe. Reopening that revision restores the stored ranges directly. Derive the displayed line labels and excerpts from those ranges.

For example, a passage at [100, 130) moves to [105, 135) after inserting five ordinary letters earlier in the same paragraph. Inserting three letters inside then extends it to [105, 138). Typing later in the manuscript leaves both endpoints alone. The same passage UUID and card targets survive all three edits. Repeated wording elsewhere has no effect on which occurrence opens.

| Operation | Passage behavior |
| --- | --- |
| Type within a span or change formatting | Preserve its links. Text inserted strictly inside belongs to the span. Text inserted exactly at either outer edge belongs outside. |
| Replace the entire span in one edit | Keep its links on the replacement prose. A pure deletion removes the passage and its links when no linked text survives. Deleting and typing later are separate operations. Undo restores text and links together. |
| Split/join paragraphs or delete part of a span | Map endpoints through the edit and retain surviving linked text. Distinct passage IDs stay distinct when ranges happen to converge after editing. |
| Copy manuscript text | Paste independent rich prose. External clipboard formats carry text and supported formatting. |
| Cut and paste within the same manuscript | On the first successful paste of a pending cut back into its source manuscript, move the linked portions with their text. Preserve the ID for a fully moved passage. For a partially cut passage, retain its surviving source range and give the pasted fragment its own ID with the same surviving card targets. Pasted linked ranges take precedence over any earlier links they intersect. Later pastes insert independent prose. Pasting across documents carries prose only. |
| Undo, redo and clipboard validity | Cut and paste each form one undo step. Carry relative ranges with the rich fragment and validate the cut identity, source manuscript and surviving targets on paste. Undoing the cut invalidates the pending move. Undoing a paste removes the pasted links; redo restores that exact paste. A failed paste leaves a valid pending move available. |
| Reorder, reparent or rename a card | Resolve by stable card ID. Structural numbering can change freely. Card prose edits do not rewrite manuscript prose. |
| Delete, copy or convert a card/subtree to another document | Deleting a target removes its linked ranges. Card copies start with no manuscript backlinks. Conversion carries no cross-document associations. Undo follows the existing operation’s history contract. |

## Markdown interchange

Use distinct File and palette commands, Import Manuscript Markdown and Export Manuscript Markdown. The existing card import creates a new .fable and selected-level export serves the tree. Manuscript commands always address the open document.

- Import UTF-8 Markdown into a temporary rich-text model and validate it before changing the document. A successful import creates the manuscript if absent. If one exists, prompt to Replace or Cancel, stating that replacement removes existing passage links. Replacement is one undoable operation. Cancellation, unreadable files and parse failures preserve the entire current state. Empty Markdown imports as an empty manuscript.
- Export the complete current manuscript in reading order, including pending editor input, to a user-chosen .md file. Suggest the document basename plus “ - Manuscript.md”. Empty manuscripts export as empty files. Internal passage associations, gutter labels, card identities and interface controls are excluded. Follow platform overwrite confirmation.
- Maintain a tested mapping for the shared rich-text schema and the supported Markdown subset, including nested lists, literal punctuation, code fences, ordinary URLs and hard breaks. Require semantic round-trip fidelity for supported forms. Preserve unsupported source syntax as literal text where feasible and surface lossy conversions before replacement. Raw HTML must never execute. The .fable file carries full-fidelity prose and links. Importing an export creates new text with no passage associations.

## Live AI edits

Allow AI edits while the manuscript is open. Route them through the validated document write path and map passage ranges through manuscript changes. Refresh a clean window after an external save. Validate stale writes against the current revision and preserve pending local work on conflict.

## Persistence and implementation boundaries

- Add an optional manuscript rich-text record to the editable document snapshot and a set of stable passage IDs with disjoint half-open editor ranges and one owned-card ID per passage. Store these in the same SQLite file. Backlinks and line labels are derived indexes. Existing card passage marks enforce a direct-child rule and reject overlaps, so manuscript associations need their own model.
- Use the editor transaction’s position maps for ordinary edits, explicit source-to-destination mapping for cut and paste, and the same undo boundary for text and links. Define persisted coordinates as ProseMirror document positions with UTF-16 text offsets. Include emoji, combining characters, empty blocks, hard breaks and multi-block selections in fixtures. Recompute indexes once per manuscript change and reuse across tree cards.
- Persist manuscript, cards and links in one transaction and revision. Legacy documents and historical revisions with no manuscript field load with zero manuscripts. A partial or legacy writer editing cards must preserve existing manuscript state or fail safely. Detect unsupported newer file versions before opening for write. Establish the compatibility path for older installed binaries before migration rolls out.
- Autosave, force-flush, document switching, reopening, external reload, MCP card mutations and undo/redo must all use a manuscript-aware snapshot. Include a base-revision check inside the write transaction for all writers. A stale writer keeps its unsaved work available and reports a conflict. Offer saving that work to a separate .fable or explicitly reloading the latest revision. No silent overwrite or automatic merge. The existing AI card tools must continue working on open documents. The local MCP server reads the manuscript and applies revision-checked rich-text range edits using the same passage mapping as typing.
- Keep editor, focus, and target-selection state in the interaction layer, pure range and line mapping in the domain layer, and migration/validation in Rust. Catch invalid ranges and missing targets before saving. Preserve readable manuscript text if damaged link metadata needs repair. Existing files open locally without a backend.

## Acceptance scenarios beyond unit coverage

1. Open a pre-manuscript file, visit all three layouts, write the first sentence and reopen. Verify no manuscript was created until the first edit or an explicit creation command. Exercise creation, removal and undo.
2. Draft a long article, leave the caret midway, browse several cards, change layouts and return. Exercise every transition in the keyboard table, both endpoints, key repeat, a selected passage, and shifted selection keys. Check caret, scroll, independent zoom and key routing. Exercise mouse, keyboard-only, narrow window, dark theme, IME and screen-reader focus.
3. Link lines 4–7 to A and then lines 6–9 to B. Verify lines 4–5 still activate A and lines 6–9 activate B while the manuscript retains focus. Repeat an existing pairing, cancel target selection in Tree, delete B, undo and reopen. Follow both cards’ backlinks.
4. With adjacent linked spans, type at their boundaries, replace a whole span, insert a paragraph above, cut and paste part of a linked section and undo. Verify text, links, line ranges and stable identity. Resize and zoom without changing labels.
5. Move a card subtree, follow an alias, paste a duplicate and convert a subtree. Confirm only the intended canonical cards carry backlinks. Keyboard navigation can reach overflow entries.
6. Round-trip supported rich prose through Markdown. Try invalid input, cancelled replacement and write failure. Check pending text, existing tree import/export, undo, and the absence of internal identifiers in exported Markdown.
7. Open the same document twice. Edit via MCP while it is open, including during a pending local edit. Verify that new edits and stale snapshots are handled without losing local work.
8. Benchmark a long manuscript with many linked passages and a large tree. Measure keystroke latency, jump latency and footer rendering on the supported desktop build. Set release thresholds from an agreed representative document before implementation sign-off.
9. Copy a whole formatted draft card into an absent and an existing manuscript. Check rich prose, independent edits, selection replacement, one-step undo and persistence after reopening.
10. Resize across the split breakpoint with each pane active. Test direct navigation and backlink jumps at narrow width and restore the split on widening.
11. Cut a paragraph containing adjacent links, paste elsewhere in the manuscript and follow each backlink. Repeat with a partially intersecting range, a second paste, copy, cross-document paste, a deleted target and an undone cut. Verify cut/paste undo and redo restore the expected text and associations.

## Implementation verification

Tune the split breakpoint and excerpt length in the desktop build. Exercise file-format compatibility against an older build before release. These checks can proceed during implementation.
