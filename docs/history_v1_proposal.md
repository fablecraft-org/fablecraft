# History v1 — snapshot preview, restore and copy

**Status.** Implemented in Fablecraft 0.6.0. The [Adaptive History policy](#adaptive-history-proposal) describes the shipped behavior. Use disposable document copies for pruning verification.

## History panel

Show the document’s retained autosave snapshots, newest first, with local date and time and a distinct Current entry. Load older entries on demand beyond the recent preview limit. Opening from Both uses the active tree or manuscript surface. Choosing a snapshot immediately renders that saved version in the adjacent surface. While previewing, use the existing directional pane shortcuts to switch between that snapshot’s tree and manuscript. Both surfaces use the same revision ID. If the revision predates the manuscript, show its absence.

Use the regular Tree or Manuscript workspace for historical content. The selected timeline card shows the save time. Browsing, selecting cards, selecting prose, and copying are available. If only one pane changed, open that pane. For mixed changes, keep the active pane. Opening a preview never replaces the editable state or triggers a save. Flush pending live edits before entering history; if that fails, preserve the live work and surface the error. Place the timeline on the right with a close icon in the top-right corner. At narrow widths use a full-width timeline and preview with a Back action. Returning to Current or closing History shows live content again; closing restores the live layout and active pane from before opening History. If another writer saves during preview, keep the preview fixed and refresh Current.

Expose Toggle History in Tools and Show History in the command palette whenever a document is open. Cmd+Shift+H on Mac and Ctrl+H on Windows and Linux open or close History. Focus the timeline on entry. Up and Down browse snapshots. Enter moves focus into the selected read-only snapshot. Enter on a card or manuscript requests a restore to start editing. Escape returns focus to that timeline row. A second Escape or the History shortcut closes History and restores the live view. Escape dismisses a pending restore confirmation first. Current represents the live document even when it has no prior saves. If no historical entry is available, explain that briefly. An unreadable or unsupported historical snapshot gets an unavailable state with its timestamp; other snapshots and Current remain accessible. Block mutation paths in historical preview, including keyboard, native menus, drag/drop and undo/redo. Live AI edits may still reach Current.

## Two ways to use an earlier version

- **Restore Snapshot** confirms the entire document will return to the selected timestamp when the writer requests editing. Append a new revision containing the selected editable state and install it as current in one transaction. Use a fresh revision ID and save time, retain document identity and leave all intervening revisions intact during the restore. Later scheduled maintenance applies the standard retention policy. Keep the former head visible while it remains retained alongside the restore. Preserve the historical tree, card bodies, manuscript and passage links together. Validate against the latest committed revision; if it changed since confirmation, refresh the comparison before applying. Close History and focus the chosen card or manuscript for live editing after success.
- **Copy from Snapshot** lets the writer recover selected prose or a whole subtree. In historical tree navigation, Cmd/Ctrl+C without a text selection copies the active card and descendants, including order and rich content. In a text selection, Copy copies just the selected prose with supported formatting. Return to Current, choose the destination and paste using normal editing or tree placement. A pasted subtree receives fresh card IDs; remap internal references and use the existing clipboard rules for external targets. Text pasted from history is independent prose. The live paste is an ordinary undoable edit. Example: copy yesterday’s deleted branch beside a current card while keeping today’s manuscript edits.

Restore uses the selected snapshot for editable content and the current document head for the save precondition. Discard historical save metadata such as the old base revision. Do not issue a duplicate autosave after the restore commits. If the selected state is already current, disable Restore. Capture the restored change as one live undo step. Copy Subtree places a self-contained fragment on the clipboard before leaving preview, so later paste can still recover cards that no longer exist in Current.

Individual action inversion, per-card version lists and protected deletion checkpoints are outside this first version.

## Retention and availability

The [physical pruning policy](#physical-pruning) defines the active age bands. Prepare snapshot metadata before publishing timeline rows. Prune atomically against the revision set used for scoring. A retry at the same reference time uses the same inputs. Use canonical revision order for listing, pruning, and stale-write checks. The committed head remains the save base. Pruning frees SQLite pages for reuse.

If maintenance removes the selected revision, the loaded preview remains available for copying. Explain that the snapshot expired and disable restoration. If another writer advances Current, keep the historical selection and require confirmation against the new head before restoring.

## Acceptance

- With more than 20 retained revisions, open an older one. Move between its tree and manuscript, then close to the current full-width surface. Browsing produces no save.
- Restore an older version containing deleted cards and an earlier manuscript. Reopen and verify exact editable content under a new revision ID. Exercise stale confirmation and failed-save paths.
- Copy a historical subtree containing internal references and a formatted passage of manuscript text. Paste each into the live document and verify current unrelated edits, ID mapping and undo.
- Test age cutoffs, empty calendar buckets, equal timestamps, repeated local hours, sparse old documents, concurrent saves, idempotence and the absence of extra exceptions. Test destructive pruning only on disposable copies.
- Exercise first writable open of a legacy file, an empty archive, a corrupt historical row, tied legacy timestamps, preview expiry and restoration while live AI edits arrive. Verify preview cannot mutate live state through menu or keyboard commands.


## Adaptive History proposal

The default timeline should make it easy to find an edit worth revisiting. Physical pruning should preserve a useful spread of whole-document restore points and favor versions that recover material missing from Current. Burst classification determines whether a previous head enters the timeline or is pruned on save. The thresholds, weights, and limits below are the shipped values. Keep them together in a versioned policy so a test or simulation can reproduce a decision.

### What the timeline shows

- Select **Current** at the top. Read the first **10 historical rows** and their persisted diffs from SQLite. Fetch the next **10** in the background. Close History when the writer starts editing Current.
- An autosave evaluates only the immediately previous Current for archive membership. A prose burst continues on one card or the manuscript within a **60-second** save gap and **10-minute** span. Identical saves within the gap can collapse. Changes of surface, structure, links, or several writing surfaces start a boundary. Retain the preceding snapshot at a boundary and around a restore. Within one burst, retain the preceding snapshot if it has at least **12 uncovered points** against the newly committed snapshot or immediately precedes substantial loss. Substantial loss removes at least **20 prose tokens from one surface**, **3 cards**, or the entire manuscript.
- Save membership and the new Current comparison in the autosave transaction. Later saves never promote an older hidden revision and never reconsider earlier membership. A scheduled maintenance pass can delete retained revisions and updates only the comparison edges affected by its deletions. The initial upgrade freezes older membership and preserves the latest prepared rows that are still present.
- Each timeline entry summarizes its delta from the previous visible entry. Current shows the latest committed revision's diff against the first historical card below it. The timeline panel matches the displayed workspace pane’s background. All timeline cards have transparent backgrounds. The timeline uses the Tree card shadow for selection and keyboard focus. Open the snapshot at an affected card or passage. If the first retained save has no comparison baseline, show **Earliest retained snapshot**. Below the last card, display the document’s original creation date and time as plain text.
- Show elapsed seconds or minutes for saves under **120 minutes** old. Show Today for older saves from today, Yesterday for the preceding local day, and Last plus the weekday for days **2 through 7** back. Include local hours, minutes, and am or pm in these labels. Show the full local date thereafter. Exact timestamps remain available on hover.
- Show affected card IDs in the timeline as rounded rectangles, with green for cards added, orange for cards edited or moved, and red for cards deleted. Show the total characters added in green and removed in red below the card IDs, including manuscript changes. Omit the card badge row when no cards changed. Highlight additions in the selected snapshot relative to the previous visible save. Count Unicode grapheme clusters in the prose and authored hard breaks, and map all added runs to their rich-text positions.

### Measuring what a snapshot can recover

Use the latest **committed** editable snapshot as the baseline. A save can contribute prose, rich formatting, a card placement, or a link. Evaluate each recovery item against both the head and the other snapshots selected for retention. Exact matches against any one survivor cover that item.

1. Match cards by stable ID and the manuscript as one writing surface. For prose, tokenize Unicode letter, number, and combining-mark runs as words and individual non-whitespace punctuation or symbols as tokens. Preserve case and punctuation. Normalize Unicode to NFC and ignore inline whitespace in the prose score. Compare paragraph and heading boundaries, list nesting, and supported rich marks as formatting. Ignore generated card labels and revision metadata.
2. In each surface, compute a deterministic shortest token edit script from the candidate to the head. Prefer a deletion over an insertion when equivalent scripts diverge. Each contiguous run removed from the candidate is one recoverable prose item. Use the whole surface when it was deleted and has no counterpart in the head. A run is covered when it appears as a contiguous sequence in the same surviving card or manuscript. An exact sequence **at least 8 tokens long** in another surface also covers its prose, to give moved text less weight. Card placement, links, and formatting are evaluated independently of a prose match.
3. Score historical formatting on matched prose when its block type, list nesting, or supported marks differ. Removing whole blocks or shortening a block without changing the formatting of the surviving prose does not itself earn formatting points. Count it once per affected card or manuscript. Cover it when a survivor contains that prose in the same surface with the same block structure and marks. Match references by stable source and target IDs. Match anchored links by source and target IDs plus the selected prose, so an offset shift alone adds no value.
4. Count one placement item for a historical card that is missing, has a different parent, or has changed its relative order among surviving siblings. Compare relative order among IDs shared by both sibling groups so insertion or deletion alone does not mark the other siblings as moved. Cover the item when a survivor has the card under the historical parent and preserves its order among the same shared siblings. Even an empty deleted card can carry a placement item.

| Uncovered recovery item | Score |
| --- | ---: |
| A prose run | **1 point per token**, up to **40 points per run** and **120 prose points per snapshot** |
| Historical card placement | **24 points per card**, up to **120 placement points per snapshot** |
| Historical formatting | **8 points per affected surface**, up to **40 formatting points per snapshot** |
| Historical reference or passage link | **12 points per link**, up to **60 link points per snapshot** |
| Last save before a substantial loss | **20 bonus points** while it still covers at least one uncovered item lost in that edit |

Sum the capped categories and the applicable bonus. A candidate whose only difference from another retained state is less text earns no additional recovery points for that surface. A deletion can still matter to navigation, or earn points for a distinct structural state. For example, if B02 goes from `A` to `A + B` to `A` and Current already contains `A`, the middle save recovers `B`. If two saves contain different rewrites of `B`, both can earn points. If both contain the same `B`, the first one retained covers that run for the other. The score measures recoverable items. Only an actual retained snapshot can restore a complete earlier state.

### Physical pruning

Prune a low-value predecessor from the same burst in the new save transaction. Retain all remaining saves for their first **10 minutes**. Check age-based pruning on open and every **10 minutes** while the document is open. Replan when a retained revision crosses an age boundary. Use a single captured reference time and the saved document timezone. Classify by elapsed age before grouping. During the first hour, protect retained substantial pre-loss saves from the periodic sweep.

| Elapsed age | Time landmark | Maximum additional recovery saves | Minimum marginal score |
| --- | --- | ---: | ---: |
| Over **10 minutes** through **1 hour** inclusive | Newest save per ten-minute local window | **3** | **12** |
| Over **1 hour** through **24 hours** inclusive | Newest save per local hour | **3** | **12** |
| Over **24 hours** through **7 days** inclusive | Newest save per six-hour window starting at 00:00, 06:00, 12:00, and 18:00 | **1** | **24** |
| Over **7 days** through **30 days** inclusive | Newest save per local day | **1** | **40** |
| Over **30 days** | Newest save per local week beginning Monday | **1** | **60** |

Reserve time landmarks and recent survivors before ranking extras. Add the highest-scoring eligible candidate in a bucket with capacity, remove its covered recovery items from the remaining candidates, then repeat. Break ties by newer timestamp and later insertion sequence. Repeated hours at a daylight-saving transition share a civil-time window. Revalidate the ordered archive in the deletion transaction. Defer adaptive deletions if the archive changes or a required snapshot is unreadable. Pruning releases SQLite pages for reuse.

### Rollout and acceptance

1. Verify grouping independently of pruning. On disposable copies, dry-run the planner and review survivor IDs, scores, and reasons. Apply the plan on a disposable copy and verify that the retained IDs match. This review is the gate for enabling adaptive deletion.
2. A set of **30** low-value same-surface autosaves **10 seconds** apart collapses as the saves commit. Verify a pruned or legacy-hidden save cannot reappear on a later load or after another save. Verify that recoverable drafts remain available and the newest save always survives. A gap of exactly **60 seconds** and a span of exactly **10 minutes** can still be grouped. A time just beyond either cap starts a new burst.
3. Test append-only drafts, deletion-only saves, competing rewrites, long manuscript replacements, deleted branches, text moved between surfaces, formatting-only changes, reordered siblings, and moved passage links. Overlapping recovery items should lose marginal score once another survivor covers them. A short unique item on its own can fall below the threshold.
4. Test each age cutoff, sparse windows, daylight-saving transitions, tied timestamps, an unreadable historical row, a stale head, and a retry with identical head, reference time, and eligible revisions. Verify the same survivor IDs on the retry and that whole-document restore still uses the selected retained revision.
