use std::collections::{HashMap, HashSet};

use super::adaptive_history::{
    recovery_score, retention_bucket, retention_plan, substantial_loss, transition, ArchiveEntry,
    MaterialReader, Recovery, Transition, BURST_GAP_MS, BURST_SPAN_MS, DAY_MS, HOUR_MS, MONTH_MS,
    RECENT_GRACE_MS, WEEK_MS,
};

use super::history_changes::{changes_between, HistoryChange};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use chrono_tz::Tz;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{
    build_document_snapshot, document_id, manuscript, now_ms, open_connection, passage_anchors,
    run_migrations, sorted_cards, sorted_contents, validate_fable_path, validate_snapshot,
    DocumentRepository, DocumentSnapshot, EditableDocumentSnapshot, RevisionRecord,
};
use crate::error::{AppError, AppErrorPayload, AppResult};

const PAGE_SIZE: usize = 20;
const PREPARED_PAGE_SIZE: usize = 10;
const METADATA_BATCH_SIZE: usize = 256;
const MAINTENANCE_INTERVAL_MS: u64 = 10 * 60_000;
mod stable;
pub(super) use stable::{ensure_timeline, record_save};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCursor {
    created_at_ms: u64,
    sequence: i64,
}

impl From<&RevisionRecord> for HistoryCursor {
    fn from(entry: &RevisionRecord) -> Self {
        Self {
            created_at_ms: entry.created_at_ms,
            sequence: entry.sequence,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryVersion {
    head_id: Option<String>,
    maintenance_at_ms: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    entries: Vec<RevisionRecord>,
    has_more: bool,
    head_id: Option<String>,
    selected_retained: bool,
    maintenance_at_ms: Option<u64>,
    groups: HashMap<String, HistoryGroup>,
    previous_visible: HashMap<String, Option<String>>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    comparisons: HashMap<String, serde_json::Value>,
    #[serde(default)]
    preparing: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryGroup {
    start_ms: u64,
    end_ms: u64,
    hidden_count: usize,
}

struct HistoryMetadata {
    revision: RevisionRecord,
    burst: Option<i64>,
    scope: Option<String>,
    start_ms: Option<u64>,
    last_ms: Option<u64>,
    loss: Option<String>,
    singleton_loss: bool,
    restored: bool,
    origin: bool,
}

fn metadata(connection: &Connection) -> AppResult<Vec<HistoryMetadata>> {
    let mut statement = connection.prepare(
        "SELECT id, created_at_ms, sequence, history_burst, history_scope, history_start_ms,
                history_last_ms, history_loss, history_singleton_loss, history_restore, history_origin
         FROM revision_index ORDER BY created_at_ms DESC, sequence DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(HistoryMetadata {
            revision: RevisionRecord {
                id: row.get(0)?,
                created_at_ms: row.get(1)?,
                sequence: row.get(2)?,
            },
            burst: row.get(3)?,
            scope: row.get(4)?,
            start_ms: row.get(5)?,
            last_ms: row.get(6)?,
            loss: row.get(7)?,
            singleton_loss: row.get(8)?,
            restored: row.get(9)?,
            origin: row.get(10)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn parse_loss(evidence: &Option<String>) -> AppResult<Option<Recovery>> {
    evidence
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| {
            AppError::storage(
                "history_metadata_unavailable",
                "Could not read History loss evidence.",
                Some(error.to_string()),
            )
        })
}

struct Burst {
    id: i64,
    scope: Option<String>,
    start: u64,
    last: u64,
    origin: bool,
}

impl Burst {
    fn new(sequence: i64, timestamp: u64, origin: bool) -> Self {
        Self {
            id: sequence,
            scope: None,
            start: timestamp,
            last: timestamp,
            origin,
        }
    }

    fn from_metadata(row: &HistoryMetadata) -> Self {
        Self {
            id: row.burst.unwrap_or(row.revision.sequence),
            scope: row.scope.clone(),
            start: row.start_ms.unwrap_or(row.revision.created_at_ms),
            last: row.last_ms.unwrap_or(row.revision.created_at_ms),
            origin: row.origin,
        }
    }

    fn extend(&mut self, prior: &Burst, change: &Transition) {
        match change {
            Transition::Identical => {
                self.id = prior.id;
                self.scope = prior.scope.clone();
                self.start = prior.start;
                self.last = prior.last;
            }
            Transition::Prose(surface) => {
                self.scope = Some(surface.clone());
                if (prior.scope.as_ref() == Some(surface) || prior.origin)
                    && self.last.saturating_sub(prior.last) <= BURST_GAP_MS
                    && self.last.saturating_sub(prior.start) <= BURST_SPAN_MS
                {
                    self.id = prior.id;
                    self.start = prior.start;
                }
            }
            Transition::Boundary => {}
        }
    }

    fn persist(&self, connection: &Connection, id: &str) -> AppResult<()> {
        connection.execute(
            "UPDATE revision_index SET history_burst = ?1, history_scope = ?2, history_start_ms = ?3,
                history_last_ms = ?4, history_origin = ?5 WHERE id = ?6",
            params![self.id, self.scope, self.start, self.last, self.origin, id],
        )?;
        Ok(())
    }
}

fn record_loss(
    connection: &Connection,
    id: &str,
    loss: &Recovery,
    change: &Transition,
) -> AppResult<()> {
    let evidence = serde_json::to_string(loss).expect("recovery items are serializable");
    connection.execute(
        "UPDATE revision_index SET history_loss = ?1, history_singleton_loss = ?2 WHERE id = ?3",
        params![evidence, matches!(change, Transition::Boundary), id],
    )?;
    Ok(())
}

fn initialize_metadata(connection: &mut Connection) -> AppResult<()> {
    while initialize_metadata_batch(connection)? {}
    Ok(())
}

fn initialize_metadata_batch(connection: &mut Connection) -> AppResult<bool> {
    let pending = |db: &Connection| {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM revision_index WHERE history_burst IS NULL)",
            [],
            |row| row.get::<_, bool>(0),
        )
    };
    if !pending(connection)? {
        return Ok(false);
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    super::check_version(&transaction)?;
    if !pending(&transaction)? {
        return Ok(false);
    }
    let document = document_id(&transaction)?;
    let mut rows = metadata(&transaction)?;
    let mut reader = MaterialReader::default();
    let mut previous: Option<(HistoryMetadata, Option<super::adaptive_history::Material>)> = None;
    let last_uninitialized = rows.iter().rposition(|entry| entry.burst.is_none());
    if let Some(last_uninitialized) = last_uninitialized {
        rows.truncate(last_uninitialized + 2);
    }
    let batch_size =
        METADATA_BATCH_SIZE + usize::from(rows.last().is_some_and(|row| row.burst.is_some()));
    rows.drain(..rows.len().saturating_sub(batch_size));
    for mut row in rows.into_iter().rev() {
        let material = revision_snapshot(&transaction, &document, &row.revision.id)
            .ok()
            .and_then(|body| reader.read(&body).ok());
        if row.burst.is_none() {
            let mut burst = Burst::new(
                row.revision.sequence,
                row.revision.created_at_ms,
                previous.is_none() && material.is_some() && !row.restored,
            );
            if let (Some((prior, Some(before))), Some(after)) = (&previous, &material) {
                let change = transition(before, after, row.restored);
                burst.extend(&Burst::from_metadata(prior), &change);
                if !matches!(change, Transition::Identical) {
                    let loss = Recovery::between(before, after);
                    if substantial_loss(before, after, &loss) {
                        record_loss(&transaction, &prior.revision.id, &loss, &change)?;
                    }
                }
            }
            burst.persist(&transaction, &row.revision.id)?;
            row.origin = burst.origin;
            row.burst = Some(burst.id);
            row.scope = burst.scope;
            row.start_ms = Some(burst.start);
            row.last_ms = Some(burst.last);
        }
        previous = Some((row, material));
    }
    transaction.commit()?;
    Ok(true)
}

fn order(revision: &RevisionRecord) -> (u64, i64) {
    (revision.created_at_ms, revision.sequence)
}

fn visible_history(
    connection: &Connection,
    document: &str,
    before: Option<HistoryCursor>,
    limit: usize,
) -> AppResult<(Vec<RevisionRecord>, HashMap<String, HistoryGroup>)> {
    let rows = metadata(connection)?;
    let mut groups = HashMap::new();
    let mut visible = Vec::new();
    let Some(head) = rows.first() else {
        return Ok((visible, groups));
    };
    let mut reader = MaterialReader::default();
    let baseline = revision_snapshot(connection, document, &head.revision.id)
        .ok()
        .and_then(|body| reader.read(&body).ok());
    let before = before.map(|cursor| (cursor.created_at_ms, cursor.sequence));
    let before_restores: HashSet<_> = rows
        .windows(2)
        .filter(|pair| {
            pair[0].restored && pair[1].revision.sequence + 1 == pair[0].revision.sequence
        })
        .map(|pair| pair[1].revision.id.as_str())
        .collect();
    for burst in rows.chunk_by(|a, b| a.burst.is_some() && a.burst == b.burst) {
        if before.is_some_and(|cursor| order(&burst[burst.len() - 1].revision) >= cursor) {
            continue;
        }
        let representative = if burst.len() == 1 {
            &burst[0]
        } else {
            baseline
                .as_ref()
                .and_then(|baseline| {
                    burst
                        .iter()
                        .filter_map(|row| {
                            let body =
                                revision_snapshot(connection, document, &row.revision.id).ok()?;
                            let material = reader.read(&body).ok()?;
                            let delta = Recovery::between(&material, baseline);
                            let loss = parse_loss(&row.loss).ok()?;
                            Some((
                                recovery_score(&delta, loss.as_ref(), &[baseline]),
                                order(&row.revision),
                                row,
                            ))
                        })
                        .max_by_key(|(score, order, _)| (*score, *order))
                        .map(|(_, _, row)| row)
                })
                .unwrap_or(&burst[0])
        };
        let latest_prose_loss = burst
            .iter()
            .find(|entry| entry.loss.is_some() && !entry.singleton_loss);
        let shown: Vec<_> = burst
            .iter()
            .filter(|entry| {
                entry.revision.id == representative.revision.id
                    || before_restores.contains(entry.revision.id.as_str())
                    || entry.singleton_loss
                    || latest_prose_loss.is_some_and(|loss| loss.revision.id == entry.revision.id)
            })
            .collect();
        let hidden_count = burst.len() - shown.len();
        for row in shown {
            if before.is_some_and(|cursor| order(&row.revision) >= cursor) {
                continue;
            }
            if row.revision.id == representative.revision.id && hidden_count > 0 {
                groups.insert(
                    row.revision.id.clone(),
                    HistoryGroup {
                        start_ms: burst[burst.len() - 1].revision.created_at_ms,
                        end_ms: burst[0].revision.created_at_ms,
                        hidden_count,
                    },
                );
            }
            visible.push(row.revision.clone());
            if visible.len() >= limit {
                return Ok((visible, groups));
            }
        }
    }
    Ok((visible, groups))
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum HistoryComparison {
    Initial,
    Unavailable,
    Compared { changes: Vec<HistoryChange> },
}

fn list(
    connection: &Connection,
    before: Option<HistoryCursor>,
    limit: usize,
) -> AppResult<Vec<RevisionRecord>> {
    let (sql, arguments) = match before {
        Some(cursor) => (
            "SELECT id, created_at_ms, sequence FROM revision_index
             WHERE (created_at_ms, sequence) < (?2, ?3)
             ORDER BY created_at_ms DESC, sequence DESC LIMIT ?1",
            vec![limit as i64, cursor.created_at_ms as i64, cursor.sequence],
        ),
        None => (
            "SELECT id, created_at_ms, sequence FROM revision_index
             ORDER BY created_at_ms DESC, sequence DESC LIMIT ?1",
            vec![limit as i64],
        ),
    };
    let mut statement = connection.prepare_cached(sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(arguments), |row| {
        Ok(RevisionRecord {
            id: row.get(0)?,
            created_at_ms: row.get(1)?,
            sequence: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(super) fn recent(connection: &Connection) -> AppResult<Vec<RevisionRecord>> {
    list(connection, None, PAGE_SIZE)
}

pub(super) fn head(connection: &Connection) -> AppResult<Option<RevisionRecord>> {
    Ok(list(connection, None, 1)?.pop())
}

fn open_history(path: &Path) -> AppResult<Connection> {
    validate_fable_path(path)?;
    let mut connection = open_connection(path)?;
    run_migrations(&mut connection)?;
    Ok(connection)
}

fn open_timeline_reader(path: &Path) -> AppResult<Connection> {
    validate_fable_path(path)?;
    let (connection, version) =
        super::open_version_checked_connection(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if version == super::CURRENT_DOCUMENT_SCHEMA_VERSION {
        return Ok(connection);
    }
    drop(connection);
    open_history(path)
}

fn check_document(connection: &Connection, expected: &str) -> AppResult<()> {
    super::check_version(connection)?;
    if document_id(connection)? != expected {
        return Err(AppError::conflict(
            "document_mismatch",
            "The document at this path has changed.",
        ));
    }
    Ok(())
}

fn revision_snapshot(
    connection: &Connection,
    document: &str,
    id: &str,
) -> AppResult<EditableDocumentSnapshot> {
    let body: String = connection
        .query_row(
            "SELECT snapshot FROM revisions WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            AppError::not_found(
                "history_revision_expired",
                "This snapshot is no longer retained.",
            )
        })?;
    let unavailable = || {
        AppError::invalid_input(
            "history_revision_unavailable",
            "This snapshot could not be read.",
        )
    };
    let mut snapshot: EditableDocumentSnapshot =
        serde_json::from_str(&body).map_err(|_| unavailable())?;
    validate_snapshot(&snapshot, document).map_err(|_| unavailable())?;
    for content in &snapshot.contents {
        let document: serde_json::Value =
            serde_json::from_str(&content.content_json).map_err(|_| unavailable())?;
        if document.get("type").and_then(|kind| kind.as_str()) != Some("doc") {
            return Err(unavailable());
        }
    }
    passage_anchors::normalize(&snapshot.cards, &mut snapshot.contents);
    if let Some(prose) = &mut snapshot.manuscript {
        manuscript::repair(prose, &snapshot.cards).map_err(|_| unavailable())?;
        manuscript::validate(prose, &snapshot.cards).map_err(|_| unavailable())?;
    }
    snapshot.base_revision_id = None;
    snapshot.manuscript_aware = true;
    Ok(snapshot)
}

fn canonical_editable(mut snapshot: EditableDocumentSnapshot) -> serde_json::Value {
    snapshot.cards = sorted_cards(&snapshot.cards);
    snapshot.contents = sorted_contents(&snapshot.contents);
    let mut value = serde_json::json!(snapshot);
    for content in value["contents"]
        .as_array_mut()
        .expect("serialized card contents")
    {
        normalize_json_field(content, "contentJson");
    }
    if let Some(prose) = value.get_mut("manuscript") {
        normalize_json_field(prose, "contentJson");
    }
    value
}

fn normalize_json_field(value: &mut serde_json::Value, key: &str) {
    if let Some(decoded) = value[key]
        .as_str()
        .and_then(|text| serde_json::from_str(text).ok())
    {
        value[key] = decoded;
    }
}

impl DocumentRepository {
    pub fn request_history_preparation(
        path: PathBuf,
        document: String,
    ) -> Result<(), AppErrorPayload> {
        let connection = open_history(&path)?;
        check_document(&connection, &document)?;
        queue_preparation(path, document);
        Ok(())
    }

    pub fn prepared_history_page(
        path: PathBuf,
        document: String,
        before: Option<HistoryCursor>,
        selected: Option<String>,
        known: Option<HistoryVersion>,
    ) -> Result<HistoryPage, AppErrorPayload> {
        let mut connection = open_timeline_reader(&path)?;
        let transaction = connection.transaction().map_err(AppError::from)?;
        check_document(&transaction, &document)?;
        let page = stable::read_page(&transaction, before, selected, known)?;
        if page.preparing {
            queue_preparation(path, document);
        }
        Ok(page)
    }

    #[cfg(test)]
    fn history_page(
        path: PathBuf,
        document: String,
        before: Option<HistoryCursor>,
        selected: Option<String>,
    ) -> Result<HistoryPage, AppErrorPayload> {
        Self::history_view(path, document, before, selected, true, None)
    }

    pub fn history_view(
        path: PathBuf,
        document: String,
        before: Option<HistoryCursor>,
        selected: Option<String>,
        expanded: bool,
        known: Option<HistoryVersion>,
    ) -> Result<HistoryPage, AppErrorPayload> {
        let mut connection = open_history(&path)?;
        check_document(&connection, &document)?;
        if !expanded {
            initialize_metadata(&mut connection)?;
        }
        let transaction = connection.transaction().map_err(AppError::from)?;
        check_document(&transaction, &document)?;
        let head_id = head(&transaction)?.map(|entry| entry.id);
        let maintenance_at_ms = maintenance_state(&transaction)?.map(|(_, completed)| completed);
        let selected_retained = match selected {
            Some(id) => transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM revisions WHERE id = ?1)",
                    [id],
                    |row| row.get(0),
                )
                .map_err(AppError::from)?,
            None => true,
        };
        let unchanged = before.is_none()
            && known.is_some_and(|known| {
                known.head_id == head_id && known.maintenance_at_ms == maintenance_at_ms
            });
        let (mut entries, groups) = if unchanged {
            (Vec::new(), HashMap::new())
        } else if expanded {
            (list(&transaction, before, PAGE_SIZE + 1)?, HashMap::new())
        } else {
            visible_history(&transaction, &document, before, PAGE_SIZE + 1)?
        };
        let previous_visible = if expanded {
            HashMap::new()
        } else {
            entries
                .iter()
                .take(PAGE_SIZE)
                .enumerate()
                .map(|(index, entry)| {
                    (
                        entry.id.clone(),
                        entries.get(index + 1).map(|older| older.id.clone()),
                    )
                })
                .collect()
        };
        let has_more = entries.len() > PAGE_SIZE;
        entries.truncate(PAGE_SIZE);
        Ok(HistoryPage {
            entries,
            has_more,
            head_id,
            selected_retained,
            maintenance_at_ms,
            groups,
            previous_visible,
            comparisons: HashMap::new(),
            preparing: false,
        })
    }

    #[cfg(test)]
    fn history_comparisons(
        path: PathBuf,
        document: String,
        ids: Vec<String>,
    ) -> Result<HashMap<String, HistoryComparison>, AppErrorPayload> {
        Self::compare_history(path, document, ids, HashMap::new(), false)
    }

    pub fn compare_history(
        path: PathBuf,
        document: String,
        ids: Vec<String>,
        baselines: HashMap<String, Option<String>>,
        newer: bool,
    ) -> Result<HashMap<String, HistoryComparison>, AppErrorPayload> {
        if ids.len() > PAGE_SIZE {
            return Err(AppError::invalid_input(
                "history_page_too_large",
                "Compare one page of History at a time.",
            )
            .into());
        }
        let mut connection = open_history(&path)?;
        let transaction = connection.transaction().map_err(AppError::from)?;
        check_document(&transaction, &document)?;
        let mut results = HashMap::new();
        let mut cached = None;
        for id in ids {
            let cursor = transaction
                .query_row(
                    "SELECT created_at_ms, sequence FROM revision_index WHERE id = ?1",
                    [&id],
                    |row| {
                        Ok(HistoryCursor {
                            created_at_ms: row.get(0)?,
                            sequence: row.get(1)?,
                        })
                    },
                )
                .optional()
                .map_err(AppError::from)?;
            let comparison = if let Some(cursor) = cursor {
                let after = match cached.take() {
                    Some((cached_id, body)) if cached_id == id => body,
                    _ => revision_snapshot(&transaction, &document, &id).ok(),
                };
                let baseline = if newer {
                    transaction.query_row(
                        "SELECT id FROM revision_index WHERE (created_at_ms, sequence) > (?1, ?2)
                         ORDER BY created_at_ms ASC, sequence ASC LIMIT 1",
                        params![cursor.created_at_ms as i64, cursor.sequence], |row| row.get(0),
                    ).optional().map_err(AppError::from)?
                } else if let Some(id) = baselines.get(&id) {
                    id.clone()
                } else {
                    list(&transaction, Some(cursor), 1)?
                        .pop()
                        .map(|previous| previous.id)
                };
                match (after, baseline) {
                    (Some(after), Some(previous)) => {
                        let before = revision_snapshot(&transaction, &document, &previous).ok();
                        let result = match &before {
                            Some(before) => HistoryComparison::Compared {
                                changes: changes_between(before, &after),
                            },
                            None => HistoryComparison::Unavailable,
                        };
                        cached = Some((previous, before));
                        result
                    }
                    (Some(_), None) => HistoryComparison::Initial,
                    _ => HistoryComparison::Unavailable,
                }
            } else {
                HistoryComparison::Unavailable
            };
            results.insert(id, comparison);
        }
        Ok(results)
    }

    pub fn historical_snapshot(
        path: PathBuf,
        document: String,
        id: String,
    ) -> Result<EditableDocumentSnapshot, AppErrorPayload> {
        let mut connection = open_history(&path)?;
        let transaction = connection.transaction().map_err(AppError::from)?;
        check_document(&transaction, &document)?;
        Ok(revision_snapshot(&transaction, &document, &id)?)
    }

    pub fn restore_revision(
        path: PathBuf,
        document: String,
        id: String,
        expected_head: Option<String>,
    ) -> Result<DocumentSnapshot, AppErrorPayload> {
        let mut connection = open_history(&path)?;
        check_document(&connection, &document)?;
        ensure_timeline(&mut connection, &document)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        check_document(&transaction, &document)?;
        let mut selected = revision_snapshot(&transaction, &document, &id)?;
        let current = build_document_snapshot(&transaction, &path)?;
        let editable = EditableDocumentSnapshot::from(&current);
        if editable.base_revision_id != expected_head {
            return Err(AppError::conflict(
                "stale_document_revision",
                "Current changed. Review the latest save before restoring.",
            )
            .into());
        }
        if canonical_editable(selected.clone()) == canonical_editable(editable) {
            return Err(AppError::conflict(
                "history_already_current",
                "This snapshot already matches Current.",
            )
            .into());
        }
        selected.base_revision_id = expected_head;
        Self::write_revision(&transaction, selected, true)?;
        let restored = build_document_snapshot(&transaction, &path)?;
        transaction.commit().map_err(AppError::from)?;
        // A restore appends a revision without thinning the history it came from.
        Ok(restored)
    }
}

fn maintenance_state(connection: &Connection) -> AppResult<Option<(String, u64)>> {
    Ok(connection
        .query_row(
            "SELECT timezone, completed_at_ms FROM revision_maintenance WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

fn due(state: &Option<(String, u64)>, reference: u64) -> bool {
    !state
        .as_ref()
        .is_some_and(|(_, last)| reference.saturating_sub(*last) < MAINTENANCE_INTERVAL_MS)
}

fn plan_history(
    connection: &Connection,
    rows: &[HistoryMetadata],
    reference: u64,
    zone: Tz,
) -> AppResult<HashMap<String, super::adaptive_history::RetentionReason>> {
    let document = document_id(connection)?;
    let mut reader = MaterialReader::default();
    let mut archive = Vec::with_capacity(rows.len());
    let visible = stable::timeline_ids(connection)?;
    for row in rows {
        if visible
            .as_ref()
            .is_some_and(|ids| !ids.contains(&row.revision.id))
        {
            continue;
        }
        let body = revision_snapshot(connection, &document, &row.revision.id)?;
        archive.push(ArchiveEntry {
            revision: row.revision.clone(),
            material: reader.read(&body)?,
            loss: parse_loss(&row.loss)?,
            bucket: retention_bucket(row.revision.created_at_ms, reference, zone)?,
        });
    }
    Ok(retention_plan(&archive))
}

fn maintain(connection: &mut Connection, reference: u64) -> AppResult<()> {
    if !due(&maintenance_state(connection)?, reference) {
        return Ok(());
    }
    initialize_metadata(connection)?;
    let state = maintenance_state(connection)?;
    if !due(&state, reference) {
        return Ok(());
    }
    if let Some((_, last)) = &state {
        let mut crossed_boundary = false;
        for age in [RECENT_GRACE_MS, HOUR_MS, DAY_MS, WEEK_MS, MONTH_MS] {
            crossed_boundary |= connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM revision_index WHERE created_at_ms >= ?1 AND created_at_ms < ?2)",
                params![last.saturating_sub(age), reference.saturating_sub(age)],
                |row| row.get::<_, bool>(0),
            )?;
        }
        if !crossed_boundary {
            return Ok(());
        }
    }
    let zone = match state {
        Some((saved, _)) => saved.parse::<Tz>().map_err(|_| {
            AppError::invalid_input(
                "invalid_revision_timezone",
                "The saved history time zone is unsupported.",
            )
        })?,
        None => iana_time_zone::get_timezone()
            .ok()
            .and_then(|name| name.parse().ok())
            .unwrap_or(chrono_tz::UTC),
    };
    // Revision bodies are immutable. Do the comparison work without holding a
    // read lock that could prevent a concurrent save from committing.
    let rows = metadata(connection)?;
    let mut delete = Vec::new();
    if rows
        .iter()
        .any(|row| reference.saturating_sub(row.revision.created_at_ms) > RECENT_GRACE_MS)
    {
        let survivors = plan_history(connection, &rows, reference, zone)?;
        let visible = stable::timeline_ids(connection)?;
        delete.extend(
            rows.iter()
                .filter(|row| !survivors.contains_key(&row.revision.id))
                .filter(|row| {
                    visible
                        .as_ref()
                        .is_none_or(|ids| ids.contains(&row.revision.id))
                        || reference.saturating_sub(row.revision.created_at_ms) > HOUR_MS
                })
                .map(|row| &row.revision.id),
        );
    }

    let comparison_updates = stable::pruned_comparisons(connection, &delete)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    super::check_version(&transaction)?;
    if !due(&maintenance_state(&transaction)?, reference) {
        return Ok(());
    }
    if !same_archive(&transaction, &rows)? {
        // Another writer advanced the document while scoring. The later save or open can retry.
        return Ok(());
    }
    {
        let mut remove = transaction.prepare_cached("DELETE FROM revisions WHERE id = ?1")?;
        for id in delete {
            remove.execute([id])?;
        }
    }
    stable::write_comparisons(&transaction, comparison_updates)?;
    transaction.execute(
        "INSERT INTO revision_maintenance (singleton, timezone, completed_at_ms) VALUES (1, ?1, ?2)
         ON CONFLICT(singleton) DO UPDATE SET completed_at_ms = excluded.completed_at_ms",
        params![zone.name(), reference],
    )?;
    transaction.commit()?;
    Ok(())
}

fn same_archive(connection: &Connection, planned: &[HistoryMetadata]) -> AppResult<bool> {
    let current = list(connection, None, planned.len() + 1)?;
    Ok(current.len() == planned.len()
        && current
            .iter()
            .zip(planned)
            .all(|(live, old)| live.id == old.revision.id && order(live) == order(&old.revision)))
}

// Coalesce requests for the same document. A commit during preparation requests one more pass.
type PreparationKey = (PathBuf, String);
static PREPARING: LazyLock<Mutex<HashMap<PreparationKey, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn queue_preparation(path: PathBuf, document: String) {
    if cfg!(test) {
        return; // Repository tests drive preparation explicitly on disposable documents.
    }
    let path = path.canonicalize().unwrap_or(path);
    let key = (path, document);
    {
        let mut jobs = PREPARING.lock().unwrap();
        if let Some(again) = jobs.get_mut(&key) {
            *again = true;
            return;
        }
        jobs.insert(key.clone(), false);
    }
    std::thread::spawn(move || loop {
        if let Err(error) = prepare_history(&key.0, &key.1) {
            eprintln!("Fablecraft history preparation failed: {error}");
        }
        let mut jobs = PREPARING.lock().unwrap();
        if !std::mem::take(jobs.get_mut(&key).unwrap()) {
            jobs.remove(&key);
            break;
        }
    });
}

fn read_prepared(connection: &Connection) -> AppResult<Option<HistoryPage>> {
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM prepared_history WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(payload.and_then(|payload| serde_json::from_str(&payload).ok()))
}

fn prepare_history(path: &Path, document: &str) -> AppResult<()> {
    let mut connection = open_history(path)?;
    check_document(&connection, document)?;
    ensure_timeline(&mut connection, document)?;
    maintain(&mut connection, now_ms()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{load_cards, load_contents};
    use chrono::DateTime;
    const WEEK_MS: u64 = 7 * DAY_MS;
    use crate::storage::migrations::MIGRATIONS;
    use crate::storage::{seed_document, CardContentRecord, CardRecord};
    use uuid::Uuid;

    struct DisposableDocument(PathBuf);

    impl DisposableDocument {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("history-{}.fable", Uuid::new_v4())))
        }
    }

    impl Drop for DisposableDocument {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn timestamp(iso: &str) -> u64 {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .timestamp_millis() as u64
    }

    fn insert_revision(connection: &Connection, id: &str, at: u64) {
        insert_prose_revision(connection, id, at, "");
    }

    fn prose_json(prose: &str) -> String {
        serde_json::json!({
            "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": prose }] }]
        }).to_string()
    }

    fn insert_prose_revision(connection: &Connection, id: &str, at: u64, prose: &str) {
        let document = document_id(connection).unwrap();
        let mut snapshot = EditableDocumentSnapshot {
            cards: load_cards(connection, &document).unwrap(),
            contents: load_contents(connection).unwrap(),
            document_id: document,
            base_revision_id: None,
            manuscript_aware: true,
            manuscript: None,
        };
        if !prose.is_empty() {
            snapshot.contents[0].content_json = prose_json(prose);
        }
        connection
            .execute(
                "INSERT INTO revisions (id, snapshot, created_at_ms) VALUES (?1, ?2, ?3)",
                params![id, serde_json::to_string(&snapshot).unwrap(), at],
            )
            .unwrap();
    }

    fn retained(connection: &Connection) -> Vec<String> {
        list(connection, None, 1000)
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect()
    }

    #[test]
    fn retention_classifies_cutoffs_before_grouping_and_keeps_sparse_days_and_latest_ties() {
        let mut connection = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS {
            connection.execute_batch(migration).unwrap();
        }
        seed_document(&mut connection).unwrap();
        let reference = timestamp("2026-01-08T12:34:00Z");
        connection
            .execute("INSERT INTO revision_maintenance VALUES (1, 'UTC', 0)", [])
            .unwrap();
        for (id, at) in [
            ("at-24h", reference - DAY_MS),
            ("inside-24h", reference - DAY_MS + 1),
            ("z-older-tie", reference - DAY_MS - 1),
            ("a-newer-tie", reference - DAY_MS - 1),
            ("same-hour", reference - DAY_MS - 2),
            ("prior-hour", timestamp("2026-01-07T11:55:00Z")),
            ("at-7d", reference - WEEK_MS),
            ("outside-7d", reference - WEEK_MS - 1),
            ("same-day", timestamp("2026-01-01T10:00:00Z")),
            ("sparse-day", timestamp("2001-07-02T04:00:00Z")),
        ] {
            insert_revision(&connection, id, at);
        }

        maintain(&mut connection, reference).unwrap();
        let expected = [
            "inside-24h",
            "a-newer-tie",
            "prior-hour",
            "at-7d",
            "outside-7d",
            "sparse-day",
        ];
        assert_eq!(retained(&connection), expected);
        connection
            .execute("UPDATE revision_maintenance SET completed_at_ms = 0", [])
            .unwrap();
        maintain(&mut connection, reference).unwrap();
        assert_eq!(retained(&connection), expected);
    }

    #[test]
    fn a_repeated_local_hour_shares_a_window_and_maintenance_persists_its_schedule() {
        let mut connection = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS {
            connection.execute_batch(migration).unwrap();
        }
        seed_document(&mut connection).unwrap();
        let reference = timestamp("2025-10-28T12:00:00Z");
        connection
            .execute(
                "INSERT INTO revision_maintenance VALUES (1, 'Europe/Paris', ?1)",
                [0],
            )
            .unwrap();
        for (id, iso) in [
            ("summer-early", "2025-10-26T00:10:00Z"),
            ("summer-late", "2025-10-26T00:55:00Z"),
            ("winter-early", "2025-10-26T01:05:00Z"),
            ("winter-late", "2025-10-26T01:40:00Z"),
        ] {
            insert_revision(&connection, id, timestamp(iso));
        }

        maintain(&mut connection, reference).unwrap();
        assert_eq!(retained(&connection), ["winter-late"]);
        maintain(&mut connection, reference + 1).unwrap();
        assert_eq!(
            maintenance_state(&connection).unwrap(),
            Some(("Europe/Paris".into(), reference))
        );
    }

    #[test]
    fn writable_open_migrates_insertion_order_and_prunes_duplicate_legacy_revisions() {
        let file = DisposableDocument::new();
        let mut legacy = Connection::open(&file.0).unwrap();
        for migration in &MIGRATIONS[..3] {
            legacy.execute_batch(migration).unwrap();
        }
        legacy.pragma_update(None, "user_version", 3).unwrap();
        seed_document(&mut legacy).unwrap();
        let at = timestamp("2000-01-01T12:34:56Z");
        for index in 0..600 {
            insert_revision(&legacy, &format!("legacy-{:03}", 599 - index), at);
        }
        drop(legacy);

        let doc = DocumentRepository::open(file.0.clone()).unwrap();
        prepare_history(&file.0, &doc.document_id).unwrap();
        let mut live = DocumentRepository::load(file.0.clone()).unwrap();
        assert_eq!(live.revisions.len(), 1);
        assert_eq!(live.revisions[0].id, "legacy-000");
        assert_eq!(live.revisions[0].sequence, 600);
        assert!(maintenance_state(&open_connection(&file.0).unwrap())
            .unwrap()
            .is_some());
        assert!(DocumentRepository::historical_snapshot(
            file.0.clone(),
            doc.document_id,
            "legacy-000".into()
        )
        .is_ok());

        let saved = DocumentRepository::save(file.0.clone(), EditableDocumentSnapshot::from(&live))
            .unwrap();
        live = DocumentRepository::load(file.0.clone()).unwrap();
        assert_eq!(live.revisions[0].id, saved.revision_id);
    }

    #[test]
    fn maintenance_failure_is_atomic_and_can_retry_with_the_same_reference_time() {
        let mut connection = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS {
            connection.execute_batch(migration).unwrap();
        }
        seed_document(&mut connection).unwrap();
        let at = timestamp("2000-01-01T12:34:56Z");
        let reference = timestamp("2026-01-08T12:34:00Z");
        insert_revision(&connection, "a", at);
        insert_revision(&connection, "b", at);
        connection.execute_batch(
            "CREATE TRIGGER fail_pruning BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'test'); END;"
        ).unwrap();

        assert!(maintain(&mut connection, reference).is_err());
        assert_eq!(retained(&connection), ["b", "a"]);
        assert!(maintenance_state(&connection).unwrap().is_none());
        connection.execute("DROP TRIGGER fail_pruning", []).unwrap();
        maintain(&mut connection, reference).unwrap();
        assert_eq!(retained(&connection), ["b"]);
    }

    #[test]
    fn a_save_and_due_maintenance_keep_the_same_head_under_concurrency() {
        let file = DisposableDocument::new();
        DocumentRepository::create(file.0.clone()).unwrap();
        let connection = open_connection(&file.0).unwrap();
        let reference = now_ms().unwrap();
        let old = timestamp("2000-01-01T12:34:56Z");
        insert_revision(&connection, "z-older", old);
        insert_revision(&connection, "a-head", old);
        let editable =
            EditableDocumentSnapshot::from(&DocumentRepository::load(file.0.clone()).unwrap());
        assert_eq!(editable.base_revision_id.as_deref(), Some("a-head"));

        let barrier = std::sync::Barrier::new(2);
        let result = std::thread::scope(|threads| {
            let prune = threads.spawn(|| {
                let mut connection = open_connection(&file.0).unwrap();
                barrier.wait();
                maintain(&mut connection, reference)
            });
            barrier.wait();
            let saved = DocumentRepository::save(file.0.clone(), editable).unwrap();
            prune.join().unwrap().unwrap();
            saved
        });
        maintain(&mut open_connection(&file.0).unwrap(), reference).unwrap();
        assert_eq!(retained(&connection), [result.revision_id, "a-head".into()]);
    }

    #[test]
    fn dry_run_prefers_distinct_recoverable_drafts_and_apply_matches_the_plan() {
        use crate::storage::adaptive_history::RetentionReason;

        let file = DisposableDocument::new();
        DocumentRepository::create(file.0.clone()).unwrap();
        let mut connection = open_connection(&file.0).unwrap();
        let at = timestamp("2026-01-06T14:00:00Z");
        let reference = timestamp("2026-01-08T13:00:00Z");
        connection
            .execute("INSERT INTO revision_maintenance VALUES (1, 'UTC', 0)", [])
            .unwrap();
        let first = (0..24)
            .map(|index| format!("first{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let second = (0..16)
            .map(|index| format!("second{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        for (index, (id, prose)) in [
            ("first-copy", format!("base {first}")),
            ("first", format!("base {first}")),
            ("second", format!("base {second}")),
            ("shorter", "base".into()),
            ("landmark", "base".into()),
        ]
        .into_iter()
        .enumerate()
        {
            insert_prose_revision(&connection, id, at + index as u64 * 1000, &prose);
        }
        insert_prose_revision(&connection, "head", reference - 1000, "base");
        initialize_metadata(&mut connection).unwrap();
        let before = retained(&connection);
        let plan = plan_history(
            &connection,
            &metadata(&connection).unwrap(),
            reference,
            chrono_tz::UTC,
        )
        .unwrap();
        assert_eq!(retained(&connection), before);
        assert_eq!(plan["head"], RetentionReason::Recent);
        assert_eq!(plan["landmark"], RetentionReason::Landmark);
        assert_eq!(plan["first"], RetentionReason::Recovery(44));
        assert!(!plan.contains_key("second"));
        assert!(!plan.contains_key("first-copy"));
        assert!(!plan.contains_key("shorter"));
        let mut report = plan.iter().collect::<Vec<_>>();
        report.sort_by_key(|(id, _)| *id);
        println!("Adaptive History dry run: {report:?}");

        maintain(&mut connection, reference).unwrap();
        assert_eq!(retained(&connection), ["head", "landmark", "first"]);
        let after = plan_history(
            &connection,
            &metadata(&connection).unwrap(),
            reference,
            chrono_tz::UTC,
        )
        .unwrap();
        assert_eq!(after, plan);
    }

    #[test]
    fn every_timeline_page_reads_saved_diffs_without_snapshot_bodies() {
        let file = DisposableDocument::new();
        let document = DocumentRepository::create(file.0.clone())
            .unwrap()
            .document_id;
        let mut connection = open_connection(&file.0).unwrap();
        let start = now_ms().unwrap() - 50 * 60_000;
        for index in 0..23 {
            insert_prose_revision(
                &connection,
                &format!("save-{index}"),
                start + index * 120_000,
                &format!("Draft {index}"),
            );
        }
        ensure_timeline(&mut connection, &document).unwrap();
        connection
            .execute("UPDATE revisions SET snapshot = '{}'", [])
            .unwrap();

        let first = DocumentRepository::prepared_history_page(
            file.0.clone(),
            document.clone(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(first.entries.len(), 10);
        assert_eq!(
            first.previous_visible["save-22"].as_deref(),
            Some("save-21")
        );
        assert_eq!(first.comparisons["save-22"]["status"], "compared");
        assert!(first.has_more && !first.preparing);
        let cursor = first.entries.last().map(HistoryCursor::from);
        let second = DocumentRepository::prepared_history_page(
            file.0.clone(),
            document.clone(),
            cursor,
            None,
            None,
        )
        .unwrap();
        assert_eq!(second.entries.len(), 10);
        assert!(second.has_more);
        let tail = &second.entries.last().unwrap().id;
        assert_eq!(second.previous_visible[tail].as_deref(), Some("save-1"));
        assert_eq!(second.comparisons[tail]["status"], "compared");
        let third = DocumentRepository::prepared_history_page(
            file.0.clone(),
            document,
            second.entries.last().map(HistoryCursor::from),
            None,
            None,
        )
        .unwrap();
        assert_eq!(third.entries.len(), 2);
        assert_eq!(third.comparisons["save-1"]["status"], "compared");
        assert!(!third.has_more);
    }

    #[test]
    fn saving_classifies_only_the_previous_head_and_preserves_a_large_loss() {
        let file = DisposableDocument::new();
        let document = DocumentRepository::create(file.0.clone())
            .unwrap()
            .document_id;
        let save = |text: &str| {
            let mut draft =
                EditableDocumentSnapshot::from(&DocumentRepository::load(file.0.clone()).unwrap());
            draft.contents[0].content_json = prose_json(text);
            DocumentRepository::save(file.0.clone(), draft)
                .unwrap()
                .revision_id
        };
        let draft = save(&format!("Base {}", "discarded ".repeat(21)));
        let low_value = save("Base");
        let newest = save("Base rewritten");
        let connection = open_connection(&file.0).unwrap();
        assert_eq!(retained(&connection), [newest.as_str(), draft.as_str()]);
        let page = DocumentRepository::prepared_history_page(
            file.0.clone(),
            document.clone(),
            None,
            Some(low_value.clone()),
            None,
        )
        .unwrap();
        assert_eq!(page.entries[0].id, draft);
        assert_eq!(
            page.previous_visible[&newest].as_deref(),
            Some(draft.as_str())
        );
        assert!(!page.selected_retained);
        let later = save("A different draft");
        let page =
            DocumentRepository::prepared_history_page(file.0.clone(), document, None, None, None)
                .unwrap();
        assert_eq!(retained(&connection), [later.as_str(), draft.as_str()]);
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].id, draft);
        assert_eq!(
            page.previous_visible[&later].as_deref(),
            Some(draft.as_str())
        );
    }

    #[test]
    fn a_hidden_legacy_save_never_enters_the_frozen_timeline() {
        let file = DisposableDocument::new();
        let document = DocumentRepository::create(file.0.clone())
            .unwrap()
            .document_id;
        let mut connection = open_connection(&file.0).unwrap();
        let start = now_ms().unwrap() - 30_000;
        insert_prose_revision(&connection, "first", start, "Base");
        insert_prose_revision(&connection, "hidden", start + 10_000, "Base appended");
        insert_prose_revision(&connection, "head", start + 20_000, "Base appended twice");
        ensure_timeline(&mut connection, &document).unwrap();
        let mut draft =
            EditableDocumentSnapshot::from(&DocumentRepository::load(file.0.clone()).unwrap());
        draft.contents[0].content_json = prose_json("Base");
        DocumentRepository::save(file.0.clone(), draft).unwrap();

        let page = DocumentRepository::prepared_history_page(
            file.0.clone(),
            document,
            None,
            Some("hidden".into()),
            None,
        )
        .unwrap();
        assert!(!page.selected_retained);
        assert!(page.entries.is_empty());
        assert!(retained(&connection).contains(&"hidden".to_string()));
    }

    #[test]
    fn scheduled_pruning_updates_the_changed_edge_without_promoting_hidden_saves() {
        let file = DisposableDocument::new();
        let document = DocumentRepository::create(file.0.clone())
            .unwrap()
            .document_id;
        let mut connection = open_connection(&file.0).unwrap();
        let at = timestamp("2026-01-01T06:00:00Z");
        for (id, offset, prose) in [
            ("first", 0, "First"),
            ("middle", 2, "Middle"),
            ("last", 4, "Last"),
            ("head", 10, "Head"),
        ] {
            insert_prose_revision(&connection, id, at + offset * 60_000, prose);
        }
        ensure_timeline(&mut connection, &document).unwrap();
        let before = DocumentRepository::prepared_history_page(
            file.0.clone(),
            document.clone(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(before.previous_visible["last"].as_deref(), Some("middle"));
        maintain(&mut connection, at + 16 * 60_000).unwrap();
        let after = DocumentRepository::prepared_history_page(
            file.0.clone(),
            document,
            None,
            Some("middle".into()),
            None,
        )
        .unwrap();
        assert_eq!(after.entries.len(), 1);
        assert_eq!(after.entries[0].id, "last");
        assert_eq!(after.previous_visible["last"], None);
        assert_eq!(after.comparisons["last"]["status"], "initial");
        assert!(!after.selected_retained);
    }

    #[test]
    fn older_age_bands_reduce_hourly_landmarks_to_six_hour_and_daily_landmarks() {
        let file = DisposableDocument::new();
        DocumentRepository::create(file.0.clone()).unwrap();
        let mut connection = open_connection(&file.0).unwrap();
        let first = timestamp("2026-01-01T06:00:00Z");
        for series in 0..2 {
            for hour in 0..3 {
                insert_revision(
                    &connection,
                    &format!("{series}-{hour}"),
                    first + (6 * series + hour) * HOUR_MS,
                );
            }
        }
        connection
            .execute("INSERT INTO revision_maintenance VALUES (1, 'UTC', 0)", [])
            .unwrap();
        maintain(&mut connection, first + 16 * HOUR_MS).unwrap();
        assert_eq!(retained(&connection).len(), 6);
        maintain(&mut connection, first + 48 * HOUR_MS).unwrap();
        assert_eq!(retained(&connection), ["1-2", "0-2"]);
        maintain(&mut connection, first + 8 * DAY_MS).unwrap();
        assert_eq!(retained(&connection), ["1-2"]);
    }

    #[test]
    fn history_repairs_both_version_five_schemas_without_rewriting_revisions() {
        for already_has_origin in [false, true] {
            let file = DisposableDocument::new();
            let mut connection = Connection::open(&file.0).unwrap();
            for migration in &MIGRATIONS[..5] {
                connection.execute_batch(migration).unwrap();
            }
            if already_has_origin {
                connection.execute_batch(MIGRATIONS[5]).unwrap();
            }
            connection.pragma_update(None, "user_version", 5).unwrap();
            seed_document(&mut connection).unwrap();
            let document = document_id(&connection).unwrap();
            insert_prose_revision(&connection, "first", 1000, "First");
            insert_prose_revision(&connection, "next", 2000, "First draft");
            let body = |db: &Connection| {
                db.query_row(
                    "SELECT snapshot FROM revisions WHERE id = 'next'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
            };
            let original = body(&connection);

            let grouped = DocumentRepository::history_view(
                file.0.clone(),
                document.clone(),
                None,
                None,
                false,
                None,
            )
            .unwrap();
            assert_eq!(grouped.entries.len(), 1);
            assert_eq!(grouped.entries[0].id, "next");
            assert_eq!(grouped.groups["next"].hidden_count, 1);
            assert_eq!(super::super::check_version(&connection).unwrap(), 8);
            assert_eq!(retained(&connection), ["next", "first"]);
            assert_eq!(body(&connection), original);

            DocumentRepository::history_view(file.0.clone(), document, None, None, false, None)
                .unwrap();
        }
    }

    #[test]
    fn groups_thirty_saves_and_pages_the_originals_without_deleting_them() {
        let file = DisposableDocument::new();
        let document = DocumentRepository::create(file.0.clone())
            .unwrap()
            .document_id;
        let connection = open_connection(&file.0).unwrap();
        let start = 1_000_000;
        for index in 0..30 {
            insert_prose_revision(
                &connection,
                &format!("save-{index}"),
                start + index * 10_000,
                &"word ".repeat(index as usize + 1),
            );
        }
        let grouped = DocumentRepository::history_view(
            file.0.clone(),
            document.clone(),
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert_eq!(grouped.entries.len(), 1);
        assert_eq!(grouped.entries[0].id, "save-29");
        assert_eq!(grouped.groups["save-29"].hidden_count, 29);
        assert_eq!(grouped.previous_visible["save-29"], None);
        let expanded =
            DocumentRepository::history_view(file.0.clone(), document, None, None, true, None)
                .unwrap();
        assert_eq!(expanded.entries.len(), 20);
        assert!(expanded.has_more);
        assert_eq!(retained(&connection).len(), 30);
    }

    #[test]
    fn newer_comparison_counts_changes_relative_to_the_next_save() {
        let file = DisposableDocument::new();
        let document = DocumentRepository::create(file.0.clone())
            .unwrap()
            .document_id;
        let connection = open_connection(&file.0).unwrap();
        insert_prose_revision(&connection, "early", 1_000, "old");
        insert_prose_revision(&connection, "later", 2_000, "old text");
        let comparisons = DocumentRepository::compare_history(
            file.0.clone(),
            document,
            vec!["early".into()],
            HashMap::new(),
            true,
        )
        .unwrap();
        let changes = serde_json::to_value(&comparisons["early"]).unwrap();
        assert_eq!(
            changes["changes"][0]["characters"],
            serde_json::json!({ "added": 0, "removed": 5 })
        );
    }

    #[test]
    fn includes_the_gap_and_span_boundaries_in_a_burst() {
        let file = DisposableDocument::new();
        let document = DocumentRepository::create(file.0.clone())
            .unwrap()
            .document_id;
        let connection = open_connection(&file.0).unwrap();
        let start = 1_000_000;
        for index in 0..=11 {
            insert_prose_revision(
                &connection,
                &format!("save-{index}"),
                start + index * BURST_GAP_MS,
                &"word ".repeat(index as usize + 1),
            );
        }
        insert_prose_revision(
            &connection,
            "after-gap",
            start + 12 * BURST_GAP_MS + 1,
            &"word ".repeat(13),
        );
        let grouped =
            DocumentRepository::history_view(file.0.clone(), document, None, None, false, None)
                .unwrap();
        assert_eq!(
            grouped
                .entries
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["after-gap", "save-11", "save-10"]
        );
        assert_eq!(grouped.groups["save-10"].hidden_count, 10);
    }

    #[test]
    fn preserves_pre_loss_and_restore_boundaries_and_defers_pruning_unreadable_archives() {
        let file = DisposableDocument::new();
        let document = DocumentRepository::create(file.0.clone())
            .unwrap()
            .document_id;
        let mut connection = open_connection(&file.0).unwrap();
        let start = timestamp("2026-01-01T13:00:00Z");
        insert_prose_revision(&connection, "draft", start, "begin");
        insert_prose_revision(
            &connection,
            "expanded",
            start + 10_000,
            &format!("begin {}", "alternative ".repeat(21)),
        );
        insert_prose_revision(&connection, "shortened", start + 20_000, "begin");
        insert_prose_revision(&connection, "restore", start + 30_000, "begin");
        connection
            .execute(
                "UPDATE revision_index SET history_restore = 1 WHERE id = 'restore'",
                [],
            )
            .unwrap();
        let grouped = DocumentRepository::history_view(
            file.0.clone(),
            document.clone(),
            None,
            None,
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            grouped
                .entries
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["restore", "shortened", "expanded"]
        );
        assert_eq!(
            grouped.previous_visible["restore"].as_deref(),
            Some("shortened")
        );
        assert_eq!(
            grouped.previous_visible["shortened"].as_deref(),
            Some("expanded")
        );

        connection
            .execute(
                "UPDATE revisions SET snapshot = '{}' WHERE id = 'draft'",
                [],
            )
            .unwrap();
        assert!(maintain(&mut connection, start + 2 * DAY_MS).is_err());
        assert_eq!(retained(&connection).len(), 4);
        assert!(maintenance_state(&connection).unwrap().is_none());
        let page = DocumentRepository::history_page(file.0.clone(), document, None, None).unwrap();
        assert_eq!(page.entries.len(), 4);
    }

    #[test]
    fn pages_metadata_and_restores_deleted_content_and_manuscript_under_a_new_head() {
        let file = DisposableDocument::new();
        let doc = DocumentRepository::create(file.0.clone()).unwrap();
        let empty =
            DocumentRepository::history_page(file.0.clone(), doc.document_id.clone(), None, None)
                .unwrap();
        assert!(empty.entries.is_empty());
        assert!(empty.head_id.is_none());

        let seed = DocumentRepository::load(file.0.clone()).unwrap();
        let mut older = EditableDocumentSnapshot::from(&seed);
        let child_id = Uuid::new_v4().to_string();
        let rich = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Earlier prose"}]}]}"#;
        older.cards.push(CardRecord {
            document_id: doc.document_id.clone(),
            id: child_id.clone(),
            order_index: 0,
            parent_id: Some(seed.cards[0].id.clone()),
            card_type: "card".into(),
        });
        older.contents.push(CardContentRecord {
            card_id: child_id.clone(),
            content_json: rich.into(),
        });
        older.manuscript = Some(manuscript::Manuscript {
            id: Uuid::new_v4().to_string(),
            content_json: rich.into(),
            passages: vec![manuscript::Passage {
                id: Uuid::new_v4().to_string(),
                from: 1,
                to: 7,
                target_card_ids: vec![child_id],
            }],
        });
        let first = DocumentRepository::save(file.0.clone(), older.clone()).unwrap();
        let mut base = first.revision_id.clone();
        for index in 0..21 {
            let mut newer = EditableDocumentSnapshot::from(&seed);
            if index > 0 {
                let prose = (0..24)
                    .map(|word| format!("draft{index}word{word}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                newer.contents[0].content_json = prose_json(&prose);
            }
            newer.base_revision_id = Some(base);
            base = DocumentRepository::save(file.0.clone(), newer)
                .unwrap()
                .revision_id;
        }
        let page =
            DocumentRepository::history_page(file.0.clone(), doc.document_id.clone(), None, None)
                .unwrap();
        assert_eq!(page.entries.len(), 20);
        assert!(page.has_more);
        assert_eq!(page.head_id.as_ref(), Some(&base));
        let tail = DocumentRepository::history_page(
            file.0.clone(),
            doc.document_id.clone(),
            page.entries.last().map(Into::into),
            Some(first.revision_id.clone()),
        )
        .unwrap();
        assert!(!tail.has_more);
        assert!(tail.selected_retained);
        assert_eq!(tail.entries.len(), 2);
        assert_eq!(tail.entries[1].id, first.revision_id);
        let comparisons = DocumentRepository::history_comparisons(
            file.0.clone(),
            doc.document_id.clone(),
            vec![tail.entries[0].id.clone(), first.revision_id.clone()],
        )
        .unwrap();
        assert!(
            matches!(comparisons[&tail.entries[0].id], HistoryComparison::Compared { ref changes } if changes.len() == 2)
        );
        assert!(matches!(
            comparisons[&first.revision_id],
            HistoryComparison::Initial
        ));

        let preview = DocumentRepository::historical_snapshot(
            file.0.clone(),
            doc.document_id.clone(),
            first.revision_id.clone(),
        )
        .unwrap();
        assert_eq!(
            canonical_editable(preview),
            canonical_editable(older.clone())
        );
        let stale = DocumentRepository::restore_revision(
            file.0.clone(),
            doc.document_id.clone(),
            first.revision_id.clone(),
            Some(first.revision_id.clone()),
        )
        .unwrap_err();
        assert_eq!(stale.code, "stale_document_revision");

        let connection = open_connection(&file.0).unwrap();
        connection.execute_batch(
            "CREATE TRIGGER fail_restore BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'test'); END;"
        ).unwrap();
        assert!(DocumentRepository::restore_revision(
            file.0.clone(),
            doc.document_id.clone(),
            first.revision_id.clone(),
            Some(base.clone()),
        )
        .is_err());
        assert_eq!(head(&connection).unwrap().unwrap().id, base);
        assert_eq!(
            DocumentRepository::load(file.0.clone())
                .unwrap()
                .cards
                .len(),
            1
        );
        connection.execute("DROP TRIGGER fail_restore", []).unwrap();

        let before_restore: Vec<_> = metadata(&connection)
            .unwrap()
            .into_iter()
            .map(|row| row.revision.id)
            .collect();
        let restored = DocumentRepository::restore_revision(
            file.0.clone(),
            doc.document_id.clone(),
            first.revision_id.clone(),
            Some(base.clone()),
        )
        .unwrap();
        let after_restore: Vec<_> = metadata(&connection)
            .unwrap()
            .into_iter()
            .map(|row| row.revision.id)
            .collect();
        assert_eq!(&after_restore[1..], before_restore.as_slice());
        let reopened = DocumentRepository::load(file.0.clone()).unwrap();
        assert_ne!(restored.revisions[0].id, base);
        assert_ne!(restored.revisions[0].id, first.revision_id);
        assert_eq!(restored.revisions[0].id, reopened.revisions[0].id);
        assert_eq!(restored.summary.document_id, doc.document_id);
        assert_eq!(
            canonical_editable(EditableDocumentSnapshot::from(&reopened)),
            canonical_editable(older)
        );
        assert_eq!(
            DocumentRepository::restore_revision(
                file.0.clone(),
                doc.document_id.clone(),
                first.revision_id.clone(),
                Some(restored.revisions[0].id.clone()),
            )
            .unwrap_err()
            .code,
            "history_already_current"
        );
        connection
            .execute("DELETE FROM revisions WHERE id = ?1", [&first.revision_id])
            .unwrap();
        assert_eq!(
            DocumentRepository::restore_revision(
                file.0.clone(),
                doc.document_id,
                first.revision_id,
                Some(restored.revisions[0].id.clone()),
            )
            .unwrap_err()
            .code,
            "history_revision_expired"
        );
    }
}
