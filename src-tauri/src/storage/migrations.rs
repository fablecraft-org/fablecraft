// A development build added this column to migration 5 before the schema
// version was bumped. Migration 6 accepts both shapes of a version 5 file.
const HISTORY_ORIGIN_VERSION: usize = 6;

pub(super) fn apply(connection: &rusqlite::Connection, index: usize) -> rusqlite::Result<()> {
    if index + 1 == HISTORY_ORIGIN_VERSION {
        let has_origin = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('revision_index') WHERE name = 'history_origin')",
            [],
            |row| row.get::<_, bool>(0),
        )?;
        if has_origin {
            return Ok(());
        }
    }
    connection.execute_batch(MIGRATIONS[index])
}

// Append one entry for every breaking on-disk change, including JSON payloads.
// The index plus one is the SQLite user_version checked by older builds.
pub(super) const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS layers (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    layer_index INTEGER NOT NULL,
    color TEXT NOT NULL,
    is_base INTEGER NOT NULL CHECK (is_base IN (0, 1)),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    UNIQUE(document_id, layer_index)
);

CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    parent_id TEXT,
    order_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES cards(id) ON DELETE CASCADE,
    UNIQUE(document_id, parent_id, order_index)
);

CREATE TABLE IF NOT EXISTS card_content (
    card_id TEXT NOT NULL,
    layer_id TEXT NOT NULL,
    content_json TEXT NOT NULL,
    PRIMARY KEY (card_id, layer_id),
    FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
    FOREIGN KEY (layer_id) REFERENCES layers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_document_parent_order
    ON cards (document_id, parent_id, order_index);

CREATE INDEX IF NOT EXISTS idx_layers_document_index
    ON layers (document_id, layer_index);
"#,
    r#"
CREATE TABLE card_content_next (
    card_id TEXT PRIMARY KEY,
    content_json TEXT NOT NULL,
    FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
);

INSERT INTO card_content_next (card_id, content_json)
SELECT card_id, content_json
FROM (
    SELECT
        card_content.card_id,
        card_content.content_json,
        ROW_NUMBER() OVER (
            PARTITION BY card_content.card_id
            ORDER BY
                CASE WHEN layers.is_base = 1 THEN 0 ELSE 1 END,
                layers.layer_index ASC,
                layers.id ASC
        ) AS row_number
    FROM card_content
    LEFT JOIN layers ON layers.id = card_content.layer_id
)
WHERE row_number = 1;

DROP TABLE card_content;
DROP TABLE layers;
ALTER TABLE card_content_next RENAME TO card_content;
"#,
    r#"
CREATE TABLE manuscript (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    content_json TEXT NOT NULL,
    passages_json TEXT NOT NULL
);

-- The v0.5.0 writer replaces all cards. Abort its transaction while a
-- manuscript exists. Manuscript-aware writers first remove and then replace
-- this row inside the same revision transaction.
CREATE TRIGGER protect_manuscript_from_legacy_writers
BEFORE DELETE ON cards WHEN EXISTS (SELECT 1 FROM manuscript)
BEGIN
    SELECT RAISE(ABORT, 'Update Fablecraft to edit this manuscript document');
END;
"#,
    r#"
-- Keep existing revision bodies in place, including overflow pages. Only
-- the timeline entries need a stable sequence for paging and retention.
CREATE TABLE revision_index (
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL
);

INSERT INTO revision_index (sequence, id, created_at_ms)
SELECT rowid, id, created_at_ms FROM revisions;

CREATE INDEX revisions_date_sequence ON revision_index (created_at_ms DESC, sequence DESC);

CREATE TRIGGER index_revision_insert AFTER INSERT ON revisions
BEGIN
    INSERT INTO revision_index (id, created_at_ms) VALUES (NEW.id, NEW.created_at_ms);
END;

CREATE TRIGGER index_revision_delete AFTER DELETE ON revisions
BEGIN
    DELETE FROM revision_index WHERE id = OLD.id;
END;

CREATE TRIGGER index_revision_update AFTER UPDATE OF id, created_at_ms ON revisions
BEGIN
    UPDATE revision_index SET id = NEW.id, created_at_ms = NEW.created_at_ms WHERE id = OLD.id;
END;

CREATE TABLE revision_maintenance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    timezone TEXT NOT NULL,
    completed_at_ms INTEGER NOT NULL
);
"#,
    r#"
ALTER TABLE revision_index ADD COLUMN history_burst INTEGER;
ALTER TABLE revision_index ADD COLUMN history_scope TEXT;
ALTER TABLE revision_index ADD COLUMN history_start_ms INTEGER;
ALTER TABLE revision_index ADD COLUMN history_last_ms INTEGER;
ALTER TABLE revision_index ADD COLUMN history_loss TEXT;
ALTER TABLE revision_index ADD COLUMN history_singleton_loss INTEGER NOT NULL DEFAULT 0;
ALTER TABLE revision_index ADD COLUMN history_restore INTEGER NOT NULL DEFAULT 0;
CREATE INDEX revisions_without_history_metadata ON revision_index (sequence) WHERE history_burst IS NULL;
"#,
    "ALTER TABLE revision_index ADD COLUMN history_origin INTEGER NOT NULL DEFAULT 0;",
    r#"
CREATE TABLE prepared_history (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    payload TEXT NOT NULL
);
-- Reevaluate the archive once with the new age bands, retaining its timezone.
UPDATE revision_maintenance SET completed_at_ms = 0;
"#,
    r#"
CREATE TABLE history_timeline (
    id TEXT PRIMARY KEY REFERENCES revisions(id) ON DELETE CASCADE,
    baseline_id TEXT,
    comparison TEXT NOT NULL
);
CREATE TABLE history_timeline_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);
UPDATE revision_maintenance SET completed_at_ms = 0;
"#,
];
