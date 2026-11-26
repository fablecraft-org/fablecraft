use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppErrorPayload, AppResult};

mod adaptive_history;
mod history;
mod history_changes;
pub use history::{HistoryComparison, HistoryCursor, HistoryPage, HistoryVersion};
pub(crate) mod manuscript;
mod migrations;
use manuscript::Manuscript;
mod passage_anchors;

const DEFAULT_CARD_TYPE: &str = "card";
const NEW_CARD_EDITOR_DOCUMENT: &str =
    r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
const CURRENT_DOCUMENT_SCHEMA_VERSION: i64 = migrations::MIGRATIONS.len() as i64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub created_at_ms: u64,
    pub document_id: String,
    pub file_modified_at_ms: u64,
    pub name: String,
    pub opened_at_ms: u64,
    pub path: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentClock {
    pub document_id: String,
    pub file_modified_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRecord {
    pub document_id: String,
    pub id: String,
    pub order_index: usize,
    pub parent_id: Option<String>,
    #[serde(rename = "type")]
    pub card_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardContentRecord {
    pub card_id: String,
    pub content_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionRecord {
    pub created_at_ms: u64,
    pub id: String,
    pub sequence: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub cards: Vec<CardRecord>,
    pub contents: Vec<CardContentRecord>,
    pub manuscript: Option<Manuscript>,
    pub revisions: Vec<RevisionRecord>,
    pub summary: DocumentSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableDocumentSnapshot {
    pub cards: Vec<CardRecord>,
    pub contents: Vec<CardContentRecord>,
    pub document_id: String,
    #[serde(default, skip_serializing)]
    pub base_revision_id: Option<String>,
    #[serde(default, skip_serializing)]
    pub manuscript_aware: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manuscript: Option<Manuscript>,
}

impl From<&DocumentSnapshot> for EditableDocumentSnapshot {
    fn from(snapshot: &DocumentSnapshot) -> Self {
        Self {
            cards: snapshot.cards.clone(),
            contents: snapshot.contents.clone(),
            document_id: snapshot.summary.document_id.clone(),
            base_revision_id: snapshot.revisions.first().map(|revision| revision.id.clone()),
            manuscript_aware: true,
            manuscript: snapshot.manuscript.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentResult {
    pub revision_id: String,
    pub saved_at_ms: u64,
}

pub struct DocumentRepository;

impl DocumentRepository {
    pub(crate) fn check_file_compatibility(path: &Path) -> AppResult<()> {
        validate_fable_path(path)?;
        open_version_checked_connection(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(())
    }

    pub fn create(path: PathBuf) -> Result<DocumentSummary, AppErrorPayload> {
        Self::create_inner(path).map_err(AppErrorPayload::from)
    }

    pub fn open(path: PathBuf) -> Result<DocumentSummary, AppErrorPayload> {
        Self::open_inner(path).map_err(AppErrorPayload::from)
    }

    pub fn load(path: PathBuf) -> Result<DocumentSnapshot, AppErrorPayload> {
        Self::load_inner(path).map_err(AppErrorPayload::from)
    }

    pub fn clock(path: PathBuf) -> Result<DocumentClock, AppErrorPayload> {
        Self::clock_inner(path).map_err(AppErrorPayload::from)
    }

    pub fn save(
        path: PathBuf,
        snapshot: EditableDocumentSnapshot,
    ) -> Result<SaveDocumentResult, AppErrorPayload> {
        Self::save_inner(path, snapshot).map_err(AppErrorPayload::from)
    }

    fn create_inner(path: PathBuf) -> AppResult<DocumentSummary> {
        validate_fable_path(&path)?;

        if path.exists() {
            return Err(AppError::conflict(
                "document_exists",
                format!(
                    "A Fablecraft document already exists at {}.",
                    path.display()
                ),
            ));
        }

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        OpenOptions::new().write(true).create_new(true).open(&path)?;
        let mut connection = open_connection(&path)?;
        run_migrations(&mut connection)?;
        seed_document(&mut connection)?;
        summarize_document(&connection, &path)
    }

    fn open_inner(path: PathBuf) -> AppResult<DocumentSummary> {
        validate_fable_path(&path)?;

        if !path.exists() {
            return Err(AppError::not_found(
                "document_missing",
                format!("No Fablecraft document exists at {}.", path.display()),
            ));
        }

        let mut connection = open_connection(&path)?;
        run_migrations(&mut connection)?;
        let transaction = connection.transaction()?;
        let summary = summarize_document(&transaction, &path)?;
        transaction.commit()?;
        history::queue_preparation(path, summary.document_id.clone());
        Ok(summary)
    }

    fn load_inner(path: PathBuf) -> AppResult<DocumentSnapshot> {
        validate_fable_path(&path)?;

        if !path.exists() {
            return Err(AppError::not_found(
                "document_missing",
                format!("No Fablecraft document exists at {}.", path.display()),
            ));
        }

        let mut connection = open_connection(&path)?;
        run_migrations(&mut connection)?;
        let transaction = connection.transaction()?;
        build_document_snapshot(&transaction, &path)
    }

    fn clock_inner(path: PathBuf) -> AppResult<DocumentClock> {
        validate_fable_path(&path)?;

        if !path.exists() {
            return Err(AppError::not_found(
                "document_missing",
                format!("No Fablecraft document exists at {}.", path.display()),
            ));
        }

        let mut connection = open_connection(&path)?;
        run_migrations(&mut connection)?;
        let transaction = connection.transaction()?;
        build_document_clock(&transaction, &path)
    }

    fn save_inner(
        path: PathBuf,
        snapshot: EditableDocumentSnapshot,
    ) -> AppResult<SaveDocumentResult> {
        validate_fable_path(&path)?;

        if !path.exists() {
            return Err(AppError::not_found(
                "document_missing",
                format!("No Fablecraft document exists at {}.", path.display()),
            ));
        }

        let mut connection = open_connection(&path)?;
        run_migrations(&mut connection)?;

        let document = snapshot.document_id.clone();
        history::ensure_timeline(&mut connection, &document)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = Self::write_revision(&transaction, snapshot, false)?;
        transaction.commit()?;
        Ok(result)
    }

    fn write_revision(
        transaction: &Connection,
        mut snapshot: EditableDocumentSnapshot,
        restored: bool,
    ) -> AppResult<SaveDocumentResult> {
        check_version(transaction)?;
        let existing_document_id = document_id(transaction)?;
        let latest = history::head(transaction)?;
        if latest.as_ref().map(|entry| &entry.id) != snapshot.base_revision_id.as_ref() {
            return Err(AppError::conflict(
                "stale_document_revision",
                "This document changed on disk. Your unsaved edits are still in this window.",
            ));
        }
        if !snapshot.manuscript_aware && transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM manuscript)", [], |row| row.get::<_, bool>(0)
        )? {
            return Err(AppError::conflict(
                "manuscript_aware_writer_required",
                "This document contains a manuscript. Update the writer to save it.",
            ));
        }
        validate_snapshot(&snapshot, &existing_document_id)?;
        passage_anchors::normalize(&snapshot.cards, &mut snapshot.contents);
        if let Some(prose) = &snapshot.manuscript {
            manuscript::validate(prose, &snapshot.cards)?;
        }

        let saved_at_ms = now_ms()?.max(transaction.query_row(
            "SELECT updated_at_ms FROM documents WHERE id = ?1",
            [&existing_document_id],
            |row| row.get::<_, u64>(0),
        )?.max(latest.as_ref().map_or(0, |entry| entry.created_at_ms)).saturating_add(1));
        let revision_id = Uuid::new_v4().to_string();
        let revision_snapshot = serde_json::to_string(&snapshot).map_err(|error| {
            AppError::storage(
                "snapshot_serialization_failed",
                "Failed to serialize the document revision snapshot.",
                Some(error.to_string()),
            )
        })?;

        transaction.execute("DELETE FROM manuscript", [])?;
        transaction.execute("DELETE FROM card_content", [])?;
        transaction.execute("DELETE FROM cards", [])?;

        for card in sorted_cards(&snapshot.cards) {
            transaction.execute(
                "INSERT INTO cards (id, document_id, parent_id, order_index, type)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    card.id,
                    card.document_id,
                    card.parent_id,
                    card.order_index as i64,
                    card.card_type
                ],
            )?;
        }

        for content in sorted_contents(&snapshot.contents) {
            transaction.execute(
                "INSERT INTO card_content (card_id, content_json) VALUES (?1, ?2)",
                params![content.card_id, content.content_json],
            )?;
        }

        if let Some(prose) = &snapshot.manuscript {
            transaction.execute(
                "INSERT INTO manuscript (singleton, id, content_json, passages_json) VALUES (1, ?1, ?2, ?3)",
                params![prose.id, prose.content_json, serde_json::to_string(&prose.passages).expect("serializable passages")],
            )?;
        }

        transaction.execute(
            "UPDATE documents SET updated_at_ms = ?1 WHERE id = ?2",
            params![saved_at_ms as i64, existing_document_id],
        )?;
        transaction.execute(
            "INSERT INTO revisions (id, snapshot, created_at_ms) VALUES (?1, ?2, ?3)",
            params![revision_id.clone(), revision_snapshot, saved_at_ms as i64],
        )?;

        if restored {
            transaction.execute("UPDATE revision_index SET history_restore = 1 WHERE id = ?1", [&revision_id])?;
        }
        history::record_save(transaction, &revision_id, saved_at_ms, &snapshot, latest.as_ref(), restored)?;

        Ok(SaveDocumentResult {
            revision_id,
            saved_at_ms,
        })
    }
}

fn open_connection(path: &Path) -> AppResult<Connection> {
    let (connection, _) = open_version_checked_connection(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    // Keep the database truly single-file. WAL would introduce -wal and -shm sidecars.
    connection.pragma_update(None, "journal_mode", "DELETE")?;

    Ok(connection)
}

fn open_version_checked_connection(path: &Path, flags: OpenFlags) -> AppResult<(Connection, i64)> {
    let connection = Connection::open_with_flags(path, flags)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    let version = check_version(&connection)?;
    Ok((connection, version))
}

fn check_version(connection: &Connection) -> AppResult<i64> {
    let version = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > CURRENT_DOCUMENT_SCHEMA_VERSION {
        return Err(AppError::InvalidInput {
            code: "unsupported_document_version",
            message: format!(
                "This document uses a newer Fablecraft file format ({version}). Update Fablecraft to open it."
            ),
            details: Some(format!(
                "Document schema {version}. This build supports up to {CURRENT_DOCUMENT_SCHEMA_VERSION}."
            )),
        });
    }
    Ok(version)
}

fn run_migrations(connection: &mut Connection) -> AppResult<()> {
    if check_version(connection)? == CURRENT_DOCUMENT_SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current_version = check_version(&transaction)?;
    for index in current_version as usize..migrations::MIGRATIONS.len() {
        migrations::apply(&transaction, index)?;
        transaction.pragma_update(None, "user_version", index + 1)?;
    }
    transaction.commit()?;
    Ok(())
}

fn seed_document(connection: &mut Connection) -> AppResult<()> {
    let existing_document_id: Option<String> = connection
        .query_row("SELECT id FROM documents LIMIT 1", [], |row| row.get(0))
        .optional()?;

    if existing_document_id.is_some() {
        return Ok(());
    }

    let timestamp = now_ms()?;
    let document_id = Uuid::new_v4().to_string();
    let root_card_id = Uuid::new_v4().to_string();

    let transaction = connection.unchecked_transaction()?;

    transaction.execute(
        "INSERT INTO documents (id, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3)",
        params![document_id, timestamp as i64, timestamp as i64],
    )?;

    transaction.execute(
        "INSERT INTO cards (id, document_id, parent_id, order_index, type)
         VALUES (?1, ?2, NULL, ?3, ?4)",
        params![root_card_id, document_id, 0_i64, DEFAULT_CARD_TYPE],
    )?;

    transaction.execute(
        "INSERT INTO card_content (card_id, content_json) VALUES (?1, ?2)",
        params![root_card_id, NEW_CARD_EDITOR_DOCUMENT],
    )?;

    transaction.commit()?;

    Ok(())
}

fn build_document_snapshot(connection: &Connection, path: &Path) -> AppResult<DocumentSnapshot> {
    let summary = summarize_document(connection, path)?;
    let cards = load_cards(connection, &summary.document_id)?;
    let mut contents = load_contents(connection)?;
    passage_anchors::normalize(&cards, &mut contents);
    let revisions = history::recent(connection)?;
    let manuscript = manuscript::load(connection, &cards)?;

    Ok(DocumentSnapshot {
        cards,
        contents,
        manuscript,
        revisions,
        summary,
    })
}

fn build_document_clock(connection: &Connection, path: &Path) -> AppResult<DocumentClock> {
    check_version(connection)?;
    let existing_document_id = document_id(connection)?;
    let updated_at_ms: i64 = connection.query_row(
        "SELECT updated_at_ms
         FROM documents
         WHERE id = ?1",
        [existing_document_id.clone()],
        |row| row.get(0),
    )?;

    Ok(DocumentClock {
        document_id: existing_document_id,
        file_modified_at_ms: file_modified_at_ms(path)?,
        updated_at_ms: updated_at_ms as u64,
    })
}

fn file_modified_at_ms(path: &Path) -> AppResult<u64> {
    Ok(fs::metadata(path)?
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            AppError::storage(
                "document_clock_failed",
                "Fablecraft could not read the document modification time.",
                Some(error.to_string()),
            )
        })?
        .as_millis() as u64)
}

fn summarize_document(connection: &Connection, path: &Path) -> AppResult<DocumentSummary> {
    check_version(connection)?;
    let existing_document_id = document_id(connection)?;
    let (created_at_ms, updated_at_ms): (u64, u64) = connection.query_row(
        "SELECT created_at_ms, updated_at_ms
         FROM documents
         WHERE id = ?1",
        [existing_document_id.clone()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    Ok(DocumentSummary {
        created_at_ms,
        document_id: existing_document_id,
        file_modified_at_ms: file_modified_at_ms(path)?,
        name: path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("Untitled")
            .to_string(),
        opened_at_ms: now_ms()?,
        path: path.to_string_lossy().to_string(),
        updated_at_ms,
    })
}

fn document_id(connection: &Connection) -> AppResult<String> {
    connection
        .query_row("SELECT id FROM documents LIMIT 1", [], |row| row.get(0))
        .optional()?
        .ok_or_else(|| {
            AppError::storage(
                "document_uninitialized",
                "The .fable file is missing its document record.",
                None,
            )
        })
}

fn load_cards(connection: &Connection, document_id: &str) -> AppResult<Vec<CardRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, document_id, parent_id, order_index, type
         FROM cards
         WHERE document_id = ?1
         ORDER BY COALESCE(parent_id, ''), order_index ASC, id ASC",
    )?;
    let rows = statement.query_map([document_id], |row| {
        Ok(CardRecord {
            document_id: row.get(1)?,
            id: row.get(0)?,
            order_index: row.get::<_, i64>(3)? as usize,
            parent_id: row.get(2)?,
            card_type: row.get(4)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn load_contents(connection: &Connection) -> AppResult<Vec<CardContentRecord>> {
    let mut statement = connection.prepare(
        "SELECT card_id, content_json
         FROM card_content
         ORDER BY card_id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(CardContentRecord {
            card_id: row.get(0)?,
            content_json: row.get(1)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn validate_snapshot(snapshot: &EditableDocumentSnapshot, document_id: &str) -> AppResult<()> {
    if snapshot.document_id != document_id {
        return Err(AppError::invalid_input(
            "document_mismatch",
            "The snapshot does not match the currently opened document.",
        ));
    }

    validate_cards(&snapshot.cards, document_id)?;
    validate_contents(&snapshot.cards, &snapshot.contents)?;

    Ok(())
}

fn validate_cards(cards: &[CardRecord], document_id: &str) -> AppResult<()> {
    let mut seen_ids = HashSet::new();
    let mut root_ids = Vec::new();

    for card in cards {
        if card.document_id != document_id {
            return Err(AppError::invalid_input(
                "card_document_mismatch",
                "Every card must belong to the active document.",
            ));
        }

        if card.card_type != DEFAULT_CARD_TYPE {
            return Err(AppError::invalid_input(
                "invalid_card_type",
                "The MVP only supports the default card type.",
            ));
        }

        if !seen_ids.insert(card.id.clone()) {
            return Err(AppError::invalid_input(
                "duplicate_card_id",
                "Card identifiers must be unique within a document.",
            ));
        }

        if card.parent_id.as_deref() == Some(card.id.as_str()) {
            return Err(AppError::invalid_input(
                "self_referential_card",
                "A card cannot be its own parent.",
            ));
        }

        if card.parent_id.is_none() {
            root_ids.push(card.id.clone());
        }
    }

    if !cards.is_empty() && root_ids.is_empty() {
        return Err(AppError::invalid_input(
            "root_card_missing",
            "A Fablecraft document must contain at least one root-depth card.",
        ));
    }

    let card_ids: HashSet<&String> = cards.iter().map(|card| &card.id).collect();
    let mut sibling_groups: HashMap<Option<String>, Vec<&CardRecord>> = HashMap::new();
    let mut child_map: HashMap<String, Vec<String>> = HashMap::new();

    for card in cards {
        if let Some(parent_id) = &card.parent_id {
            if !card_ids.contains(parent_id) {
                return Err(AppError::invalid_input(
                    "missing_parent_card",
                    "Every parent reference must resolve to an existing card.",
                ));
            }

            child_map
                .entry(parent_id.clone())
                .or_default()
                .push(card.id.clone());
        }

        sibling_groups
            .entry(card.parent_id.clone())
            .or_default()
            .push(card);
    }

    for group in sibling_groups.values_mut() {
        group.sort_by(|left, right| {
            left.order_index
                .cmp(&right.order_index)
                .then(left.id.cmp(&right.id))
        });

        for (expected_index, card) in group.iter().enumerate() {
            if card.order_index != expected_index {
                return Err(AppError::invalid_input(
                    "invalid_sibling_order",
                    "Sibling order indexes must be contiguous.",
                ));
            }
        }
    }

    let mut visited = HashSet::new();
    let mut stack = root_ids;

    while let Some(card_id) = stack.pop() {
        if !visited.insert(card_id.clone()) {
            continue;
        }

        if let Some(children) = child_map.get(&card_id) {
            for child_id in children {
                stack.push(child_id.clone());
            }
        }
    }

    if visited.len() != cards.len() {
        return Err(AppError::invalid_input(
            "disconnected_tree",
            "All cards must belong to the root-depth forest.",
        ));
    }

    Ok(())
}

fn validate_contents(cards: &[CardRecord], contents: &[CardContentRecord]) -> AppResult<()> {
    let card_ids: HashSet<&String> = cards.iter().map(|card| &card.id).collect();
    let mut seen_cards = HashSet::new();

    for content in contents {
        if !card_ids.contains(&content.card_id) {
            return Err(AppError::invalid_input(
                "missing_content_card",
                "Every content record must reference an existing card.",
            ));
        }

        if !seen_cards.insert(content.card_id.clone()) {
            return Err(AppError::invalid_input(
                "duplicate_content_record",
                "Each card can only have one content record.",
            ));
        }
    }

    for card in cards {
        if !seen_cards.contains(&card.id) {
            return Err(AppError::invalid_input(
                "missing_card_content",
                "Every card must retain a content record.",
            ));
        }
    }

    Ok(())
}

fn sorted_cards(cards: &[CardRecord]) -> Vec<CardRecord> {
    let mut grouped_cards: HashMap<Option<String>, Vec<CardRecord>> = HashMap::new();

    for card in cards {
        grouped_cards
            .entry(card.parent_id.clone())
            .or_default()
            .push(card.clone());
    }

    for siblings in grouped_cards.values_mut() {
        siblings.sort_by(|left, right| {
            left.order_index
                .cmp(&right.order_index)
                .then(left.id.cmp(&right.id))
        });
    }

    let mut sorted = Vec::with_capacity(cards.len());
    let mut stack = grouped_cards.remove(&None).unwrap_or_default();
    stack.reverse();

    while let Some(card) = stack.pop() {
        if let Some(mut children) = grouped_cards.remove(&Some(card.id.clone())) {
            children.reverse();
            stack.extend(children);
        }

        sorted.push(card);
    }

    sorted
}

fn sorted_contents(contents: &[CardContentRecord]) -> Vec<CardContentRecord> {
    let mut sorted = contents.to_vec();
    sorted.sort_by(|left, right| left.card_id.cmp(&right.card_id));
    sorted
}

fn validate_fable_path(path: &Path) -> AppResult<()> {
    let extension = path.extension().and_then(|value| value.to_str());

    if extension != Some("fable") {
        return Err(AppError::invalid_input(
            "invalid_document_extension",
            "Fablecraft documents must use the .fable extension.",
        ));
    }

    Ok(())
}

fn now_ms() -> AppResult<u64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            AppError::storage(
                "clock_error",
                "The system clock moved backwards.",
                Some(error.to_string()),
            )
        })?;

    Ok(duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY_EDITOR_DOCUMENT: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;

    fn temp_document_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("fablecraft-{label}-{}.fable", Uuid::new_v4()))
    }

    fn revision_body(path: &Path, id: &str) -> String {
        open_connection(path).unwrap().query_row(
            "SELECT snapshot FROM revisions WHERE id = ?1", [id], |row| row.get(0),
        ).unwrap()
    }

    #[test]
    fn existing_connection_never_recreates_a_missing_document() {
        let path = temp_document_path("missing-connection");
        assert!(super::open_connection(&path).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn create_initializes_schema_and_root_card() {
        let path = temp_document_path("create");

        let summary = DocumentRepository::create(path.clone()).expect("document should create");

        assert_eq!(summary.name, path.file_stem().unwrap().to_string_lossy());

        let connection = Connection::open(&path).expect("sqlite file should exist");
        let card_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .expect("card query should succeed");
        let content_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM card_content", [], |row| row.get(0))
            .expect("content query should succeed");
        let root_content_json: String = connection
            .query_row("SELECT content_json FROM card_content LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("content query should succeed");
        let layer_table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'layers'",
                [],
                |row| row.get(0),
            )
            .expect("schema query should succeed");

        assert_eq!(card_count, 1);
        assert_eq!(content_count, 1);
        assert_eq!(root_content_json, EMPTY_EDITOR_DOCUMENT);
        assert_eq!(layer_table_count, 0);

        fs::remove_file(path).expect("temp file should be removable");
    }

    #[test]
    fn open_returns_existing_document_summary() {
        let path = temp_document_path("open");
        let created = DocumentRepository::create(path.clone()).expect("document should create");

        let opened = DocumentRepository::open(path.clone()).expect("document should open");

        assert_eq!(opened.document_id, created.document_id);
        assert_eq!(opened.created_at_ms, created.created_at_ms);

        fs::remove_file(path).expect("temp file should be removable");
    }

    #[test]
    fn migrates_version_two_and_protects_manuscript_from_partial_and_legacy_writers() {
        let path = temp_document_path("manuscript-migration");
        let mut legacy = Connection::open(&path).unwrap();
        for migration in &super::migrations::MIGRATIONS[..2] {
            legacy.execute_batch(migration).unwrap();
        }
        legacy.pragma_update(None, "user_version", 2).unwrap();
        super::seed_document(&mut legacy).unwrap();
        legacy.execute(
            "INSERT INTO revisions (id, snapshot, created_at_ms) VALUES ('legacy', '{}', 1)",
            [],
        ).unwrap();
        drop(legacy);

        let original = DocumentRepository::load(path.clone()).unwrap();
        assert!(original.manuscript.is_none());
        assert_eq!(original.revisions[0].id, "legacy");
        let mut editable = EditableDocumentSnapshot::from(&original);
        let id = Uuid::new_v4().to_string();
        let passage = super::manuscript::Passage {
            id: Uuid::new_v4().to_string(),
            from: 2,
            to: 4,
            target_card_ids: vec![original.cards[0].id.clone()],
        };
        editable.manuscript = Some(super::manuscript::Manuscript {
            id: id.clone(),
            content_json: serde_json::json!({
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a😀b"}]}]
            }).to_string(),
            passages: vec![passage.clone()],
        });
        let save = DocumentRepository::save(path.clone(), editable).unwrap();
        let reopened = DocumentRepository::load(path.clone()).unwrap();
        assert_eq!(reopened.manuscript.as_ref().unwrap().passages[0].id, passage.id);
        assert_eq!(reopened.manuscript.as_ref().unwrap().id, id);
        assert!(revision_body(&path, &reopened.revisions[0].id).contains(&passage.id));
        assert!(!revision_body(&path, &reopened.revisions[1].id).contains("manuscript"));

        let connection = Connection::open(&path).unwrap();
        let legacy_error = connection.execute("DELETE FROM cards", []).unwrap_err();
        assert!(legacy_error.to_string().contains("Update Fablecraft"));
        let mut partial = EditableDocumentSnapshot::from(&reopened);
        partial.manuscript = None;
        partial.manuscript_aware = false;
        assert_eq!(DocumentRepository::save(path.clone(), partial).unwrap_err().code, "manuscript_aware_writer_required");

        let mut invalid = EditableDocumentSnapshot::from(&reopened);
        invalid.manuscript.as_mut().unwrap().passages[0].from = 3; // Inside the emoji.
        assert_eq!(DocumentRepository::save(path.clone(), invalid).unwrap_err().code, "invalid_manuscript");
        let mut invalid = EditableDocumentSnapshot::from(&reopened);
        invalid.manuscript.as_mut().unwrap().passages[0].target_card_ids = vec!["missing".into()];
        assert_eq!(DocumentRepository::save(path.clone(), invalid).unwrap_err().code, "invalid_manuscript");

        connection.execute("UPDATE manuscript SET passages_json = 'invalid JSON'", []).unwrap();
        let repaired = DocumentRepository::load(path.clone()).unwrap();
        assert_eq!(repaired.revisions[0].id, save.revision_id);
        let prose = repaired.manuscript.unwrap();
        assert!(prose.content_json.contains("a😀b"));
        assert!(prose.passages.is_empty());

        let mut clear = EditableDocumentSnapshot::from(&reopened);
        clear.manuscript = None;
        DocumentRepository::save(path.clone(), clear).unwrap();
        assert!(DocumentRepository::load(path.clone()).unwrap().manuscript.is_none());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_manuscript_links_resolve_to_the_last_card_per_span() {
        let path = temp_document_path("legacy-manuscript-overlaps");
        DocumentRepository::create(path.clone()).unwrap();
        let initial = DocumentRepository::load(path.clone()).unwrap();
        let root = initial.cards[0].id.clone();
        let second = Uuid::new_v4().to_string();
        let mut editable = EditableDocumentSnapshot::from(&initial);
        editable.cards.push(CardRecord {
            id: second.clone(), document_id: editable.document_id.clone(), card_type: DEFAULT_CARD_TYPE.into(),
            parent_id: None, order_index: 1,
        });
        editable.contents.push(CardContentRecord {
            card_id: second.clone(), content_json: NEW_CARD_EDITOR_DOCUMENT.into(),
        });
        DocumentRepository::save(path.clone(), editable).unwrap();

        let old = Uuid::new_v4().to_string();
        let new = Uuid::new_v4().to_string();
        let content = serde_json::json!({
            "type": "doc", "content": [{"type": "paragraph", "content": [{"type":"text","text":"Alpha beta gamma."}]}]
        });
        let legacy = serde_json::json!([
            {"id":old, "from":1, "to":18, "targetCardIds":[root, second]},
            {"id":new, "from":7, "to":11, "targetCardIds":[root]},
        ]);
        let connection = Connection::open(&path).unwrap();
        connection.execute("INSERT INTO manuscript VALUES (1, ?1, ?2, ?3)",
            params![Uuid::new_v4().to_string(), content.to_string(), legacy.to_string()]).unwrap();
        let loaded = DocumentRepository::load(path.clone()).unwrap();
        let mut passages = loaded.manuscript.as_ref().unwrap().passages.clone();
        passages.sort_by_key(|p| p.from);
        assert_eq!(passages.len(), 3);
        assert_eq!((passages[0].from, passages[0].to, &passages[0].id), (1, 7, &old));
        assert_eq!(passages[0].target_card_ids, vec![second.clone()]);
        assert_eq!((passages[1].from, passages[1].to, &passages[1].id), (7, 11, &new));
        assert_eq!(passages[1].target_card_ids, vec![root]);
        assert_eq!((passages[2].from, passages[2].to), (11, 18));
        assert_eq!(passages[2].target_card_ids, vec![second]);
        let reopened = DocumentRepository::load(path.clone()).unwrap().manuscript.unwrap();
        assert!(reopened.passages.iter().any(|p| p.id == passages[2].id));

        let mut invalid = EditableDocumentSnapshot::from(&loaded);
        let links = &mut invalid.manuscript.as_mut().unwrap().passages;
        links.iter_mut().find(|p| p.id == new).unwrap().from = 5;
        assert_eq!(DocumentRepository::save(path.clone(), invalid).unwrap_err().code, "invalid_manuscript");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_future_file_versions_before_opening() {
        let path = temp_document_path("future-version");
        DocumentRepository::create(path.clone()).unwrap();
        let snapshot = DocumentRepository::load(path.clone()).unwrap();
        let document = snapshot.summary.document_id.clone();
        let editable = EditableDocumentSnapshot::from(&snapshot);
        let future_version = super::CURRENT_DOCUMENT_SCHEMA_VERSION + 1;
        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", future_version).unwrap();
        drop(connection);
        let bytes = fs::read(&path).unwrap();

        let errors = [
            DocumentRepository::open(path.clone()).unwrap_err(),
            DocumentRepository::load(path.clone()).unwrap_err(),
            DocumentRepository::clock(path.clone()).unwrap_err(),
            DocumentRepository::save(path.clone(), editable).unwrap_err(),
            DocumentRepository::prepared_history_page(path.clone(), document.clone(), None, None, None)
                .err().expect("future format must reject History access"),
            DocumentRepository::restore_revision(path.clone(), document, "test-revision".into(), None)
                .unwrap_err(),
        ];
        for error in errors {
            assert_eq!(error.code, "unsupported_document_version");
            assert!(error.message.contains(&format!("file format ({future_version})")));
            assert!(error.message.contains("Update Fablecraft"));
        }
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn serializes_competing_writers_on_the_same_base_revision() {
        use std::sync::{Arc, Barrier};
        let path = temp_document_path("competing-manuscript-writes");
        DocumentRepository::create(path.clone()).unwrap();
        let original = DocumentRepository::load(path.clone()).unwrap();
        let mut first = EditableDocumentSnapshot::from(&original);
        first.manuscript = Some(super::manuscript::Manuscript {
            id: Uuid::new_v4().to_string(), content_json: NEW_CARD_EDITOR_DOCUMENT.to_string(), passages: vec![],
        });
        DocumentRepository::save(path.clone(), first).unwrap();
        let saved = DocumentRepository::load(path.clone()).unwrap();
        let gate = Arc::new(Barrier::new(2));
        let attempts: Vec<_> = ["one", "two"].into_iter().map(|text| {
            let path = path.clone();
            let gate = gate.clone();
            let mut candidate = EditableDocumentSnapshot::from(&saved);
            super::manuscript::edit(candidate.manuscript.as_mut().unwrap(), 1, 1,
                &[serde_json::json!({"type": "text", "text": text})]).unwrap();
            std::thread::spawn(move || {
                gate.wait();
                DocumentRepository::save(path, candidate)
            })
        }).collect();
        let results: Vec<_> = attempts.into_iter().map(|attempt| attempt.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter_map(|result| result.as_ref().err()).next().unwrap().code,
            "stale_document_revision");
        let current = DocumentRepository::load(path.clone()).unwrap();
        assert_eq!(current.revisions.len(), 1);
        assert_eq!(current.revisions[0].id, results.iter().find_map(|result| result.as_ref().ok()).unwrap().revision_id);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn save_round_trips_snapshot_and_creates_revision() {
        let path = temp_document_path("save");
        DocumentRepository::create(path.clone()).expect("document should create");

        let snapshot = DocumentRepository::load(path.clone()).expect("snapshot should load");
        let root_card = snapshot
            .cards
            .iter()
            .find(|card| card.parent_id.is_none())
            .expect("root card should exist")
            .clone();
        let child_card_id = Uuid::new_v4().to_string();

        let result = DocumentRepository::save(
            path.clone(),
            EditableDocumentSnapshot {
                base_revision_id: None,
                manuscript_aware: true,
                manuscript: None,
                cards: vec![
                    root_card.clone(),
                    CardRecord {
                        document_id: snapshot.summary.document_id.clone(),
                        id: child_card_id.clone(),
                        order_index: 0,
                        parent_id: Some(root_card.id.clone()),
                        card_type: DEFAULT_CARD_TYPE.to_string(),
                    },
                ],
                contents: vec![
                    snapshot
                        .contents
                        .first()
                        .expect("base content should exist")
                        .clone(),
                    CardContentRecord {
                        card_id: child_card_id,
                        content_json: EMPTY_EDITOR_DOCUMENT.to_string(),
                    },
                ],
                document_id: snapshot.summary.document_id.clone(),
            },
        )
        .expect("snapshot should save");

        let reopened = DocumentRepository::load(path.clone()).expect("snapshot should reload");

        assert_eq!(reopened.cards.len(), 2);
        assert_eq!(reopened.contents.len(), 2);
        assert_eq!(reopened.revisions.len(), 1);
        assert_eq!(reopened.revisions[0].id, result.revision_id);

        fs::remove_file(path).expect("temp file should be removable");
    }

    #[test]
    fn passage_anchors_round_trip_content_and_revisions_and_clean_deleted_targets() {
        let path = temp_document_path("passage-anchors");
        DocumentRepository::create(path.clone()).unwrap();
        let snapshot = DocumentRepository::load(path.clone()).unwrap();
        let root = snapshot.cards[0].clone();
        let mut editable = EditableDocumentSnapshot {
            base_revision_id: None,
            manuscript_aware: true,
            manuscript: None,
            document_id: snapshot.summary.document_id.clone(),
            cards: vec![root.clone(), CardRecord {
                id: "anchored-child".into(), document_id: snapshot.summary.document_id,
                parent_id: Some(root.id.clone()), order_index: 0, card_type: DEFAULT_CARD_TYPE.into(),
            }],
            contents: vec![
                CardContentRecord { card_id: root.id.clone(), content_json: serde_json::json!({
                    "type":"doc", "content":[{"type":"paragraph","content":[{"type":"text","text":"A passage", "marks":[
                        {"type":"passageAnchor","attrs":{"childCardId":"anchored-child"}}
                    ]}]}]
                }).to_string() },
                CardContentRecord { card_id: "anchored-child".into(), content_json: EMPTY_EDITOR_DOCUMENT.into() },
            ],
        };
        DocumentRepository::save(path.clone(), editable.clone()).unwrap();
        let loaded = DocumentRepository::load(path.clone()).unwrap();
        assert!(loaded.contents.iter().find(|content| content.card_id == root.id).unwrap().content_json.contains("passageAnchor"));
        assert!(revision_body(&path, &loaded.revisions[0].id).contains("passageAnchor"));
        editable.base_revision_id = Some(loaded.revisions[0].id.clone());
        editable.cards.retain(|card| card.id != "anchored-child");
        editable.contents.retain(|content| content.card_id != "anchored-child");
        DocumentRepository::save(path.clone(), editable).unwrap();
        let loaded = DocumentRepository::load(path.clone()).unwrap();
        assert!(!loaded.contents[0].content_json.contains("passageAnchor"));
        assert!(!revision_body(&path, &loaded.revisions[0].id).contains("passageAnchor"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn saves_and_reopens_a_manuscript_with_an_empty_tree() {
        let path = temp_document_path("empty-tree");
        DocumentRepository::create(path.clone()).unwrap();
        let initial = DocumentRepository::load(path.clone()).unwrap();
        let mut editable = EditableDocumentSnapshot::from(&initial);
        editable.cards.clear();
        editable.contents.clear();
        let manuscript_id = Uuid::new_v4().to_string();
        editable.manuscript = Some(super::Manuscript {
            id: manuscript_id.clone(),
            content_json: EMPTY_EDITOR_DOCUMENT.to_string(),
            passages: Vec::new(),
        });

        let saved = DocumentRepository::save(path.clone(), editable).unwrap();
        let reopened = DocumentRepository::load(path.clone()).unwrap();
        assert!(reopened.cards.is_empty());
        assert!(reopened.contents.is_empty());
        let manuscript = reopened.manuscript.unwrap();
        assert_eq!(manuscript.id, manuscript_id);
        assert_eq!(manuscript.content_json, EMPTY_EDITOR_DOCUMENT);
        assert!(manuscript.passages.is_empty());
        assert_eq!(reopened.revisions[0].id, saved.revision_id);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn save_allows_multiple_root_depth_cards() {
        let path = temp_document_path("multiple-roots");
        DocumentRepository::create(path.clone()).expect("document should create");

        let snapshot = DocumentRepository::load(path.clone()).expect("snapshot should load");
        let root_card = snapshot
            .cards
            .iter()
            .find(|card| card.parent_id.is_none())
            .expect("root card should exist")
            .clone();
        let second_root_id = Uuid::new_v4().to_string();

        DocumentRepository::save(
            path.clone(),
            EditableDocumentSnapshot {
                base_revision_id: None,
                manuscript_aware: true,
                manuscript: None,
                cards: vec![
                    root_card.clone(),
                    CardRecord {
                        document_id: snapshot.summary.document_id.clone(),
                        id: second_root_id.clone(),
                        order_index: 1,
                        parent_id: None,
                        card_type: DEFAULT_CARD_TYPE.to_string(),
                    },
                ],
                contents: vec![
                    snapshot
                        .contents
                        .first()
                        .expect("base content should exist")
                        .clone(),
                    CardContentRecord {
                        card_id: second_root_id,
                        content_json: EMPTY_EDITOR_DOCUMENT.to_string(),
                    },
                ],
                document_id: snapshot.summary.document_id.clone(),
            },
        )
        .expect("snapshot with multiple root-depth cards should save");

        let reopened = DocumentRepository::load(path.clone()).expect("snapshot should reload");
        let roots = reopened
            .cards
            .iter()
            .filter(|card| card.parent_id.is_none())
            .collect::<Vec<_>>();

        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].order_index, 0);
        assert_eq!(roots[1].order_index, 1);

        fs::remove_file(path).expect("temp file should be removable");
    }
}
