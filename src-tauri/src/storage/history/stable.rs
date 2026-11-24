use super::*;

const BURST_KEEP_SCORE: usize = 12;

pub(super) struct TimelineComparison {
    id: String,
    baseline: Option<String>,
    json: String,
}

fn initialized(connection: &Connection) -> AppResult<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM history_timeline_state)",
        [],
        |row| row.get(0),
    )?)
}

fn compare(
    before: Option<&EditableDocumentSnapshot>,
    after: Option<&EditableDocumentSnapshot>,
    has_baseline: bool,
) -> HistoryComparison {
    match (before, after) {
        (Some(before), Some(after)) => HistoryComparison::Compared {
            changes: changes_between(before, after),
        },
        (_, Some(_)) if !has_baseline => HistoryComparison::Initial,
        _ => HistoryComparison::Unavailable,
    }
}

fn comparison_json(comparison: HistoryComparison) -> String {
    serde_json::to_string(&comparison).expect("history comparison is serializable")
}

pub(super) fn write_comparisons(
    connection: &Connection,
    comparisons: Vec<TimelineComparison>,
) -> AppResult<()> {
    let mut statement = connection.prepare_cached(
        "INSERT INTO history_timeline (id, baseline_id, comparison) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET baseline_id = excluded.baseline_id, comparison = excluded.comparison",
    )?;
    for row in comparisons {
        statement.execute(params![row.id, row.baseline, row.json])?;
    }
    Ok(())
}

pub(in crate::storage) fn ensure_timeline(
    connection: &mut Connection,
    document: &str,
) -> AppResult<()> {
    while !initialized(connection)? {
        initialize_metadata(connection)?;
        let archive = metadata(connection)?;
        let (mut visible, _) = visible_history(connection, document, None, usize::MAX)?;
        let legacy = read_prepared(connection)?;
        if let Some(page) = &legacy {
            if let Some(oldest) = page.entries.last() {
                // Keep the rows the writer could see in the last prepared pages.
                visible.retain(|row| order(row) < order(oldest));
                let retained: HashSet<_> =
                    archive.iter().map(|row| row.revision.id.as_str()).collect();
                visible.extend(
                    page.entries
                        .iter()
                        .filter(|row| retained.contains(row.id.as_str()))
                        .cloned(),
                );
                if let Some(former_head) = archive
                    .iter()
                    .find(|row| Some(&row.revision.id) == page.head_id.as_ref())
                {
                    visible.push(former_head.revision.clone());
                }
            }
        }
        if let Some(head) = archive.first() {
            visible.push(head.revision.clone());
        }
        visible.sort_by_key(|row| std::cmp::Reverse(order(row)));
        visible.dedup_by(|a, b| a.id == b.id);

        let mut comparisons = Vec::with_capacity(visible.len());
        let mut after = visible
            .first()
            .and_then(|row| revision_snapshot(connection, document, &row.id).ok());
        for (index, row) in visible.iter().enumerate() {
            let baseline = visible.get(index + 1).map(|older| older.id.clone());
            let before = baseline
                .as_ref()
                .and_then(|id| revision_snapshot(connection, document, id).ok());
            let cached = legacy.as_ref().and_then(|page| {
                if page.previous_visible.get(&row.id) == Some(&baseline) {
                    page.comparisons.get(&row.id)
                } else {
                    None
                }
            });
            let json = cached.map_or_else(
                || comparison_json(compare(before.as_ref(), after.as_ref(), baseline.is_some())),
                ToString::to_string,
            );
            comparisons.push(TimelineComparison {
                id: row.id.clone(),
                baseline,
                json,
            });
            after = before;
        }

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        check_document(&transaction, document)?;
        if !initialized(&transaction)? && same_archive(&transaction, &archive)? {
            write_comparisons(&transaction, comparisons)?;
            transaction.execute("INSERT INTO history_timeline_state VALUES (1)", [])?;
            transaction.execute("DELETE FROM prepared_history", [])?;
        }
        transaction.commit()?;
    }
    Ok(())
}

pub(in crate::storage) fn record_save(
    connection: &Connection,
    id: &str,
    timestamp: u64,
    snapshot: &EditableDocumentSnapshot,
    prior: Option<&RevisionRecord>,
    restored: bool,
) -> AppResult<()> {
    let sequence = connection.query_row(
        "SELECT sequence FROM revision_index WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?;
    let mut next = Burst::new(sequence, timestamp, prior.is_none());
    let mut baseline = prior.map(|row| row.id.clone());
    let mut before =
        prior.and_then(|row| revision_snapshot(connection, &snapshot.document_id, &row.id).ok());
    if let (Some(prior), Some(previous)) = (prior, &before) {
        let (burst, protected) = connection.query_row(
            "SELECT history_burst, history_scope, history_start_ms, history_last_ms, history_origin,
                    history_restore OR history_loss IS NOT NULL
             FROM revision_index WHERE id = ?1",
            [&prior.id],
            |row| Ok((Burst {
                id: row.get::<_, Option<_>>(0)?.unwrap_or(prior.sequence),
                scope: row.get(1)?,
                start: row.get::<_, Option<_>>(2)?.unwrap_or(prior.created_at_ms),
                last: row.get::<_, Option<_>>(3)?.unwrap_or(prior.created_at_ms),
                origin: row.get(4)?,
            }, row.get::<_, bool>(5)?)),
        )?;
        let mut reader = MaterialReader::default();
        if let (Ok(previous_material), Ok(current_material)) =
            (reader.read(previous), reader.read(snapshot))
        {
            let change = transition(&previous_material, &current_material, restored);
            next.extend(&burst, &change);
            let loss = Recovery::between(&previous_material, &current_material);
            let substantial = substantial_loss(&previous_material, &current_material, &loss);
            if substantial {
                record_loss(connection, &prior.id, &loss, &change)?;
            }
            if !restored
                && !protected
                && !substantial
                && burst.id == next.id
                && timestamp.saturating_sub(prior.created_at_ms) <= BURST_GAP_MS
                && recovery_score(&loss, None, &[&current_material]) < BURST_KEEP_SCORE
            {
                baseline = connection.query_row(
                    "SELECT baseline_id FROM history_timeline WHERE id = ?1",
                    [&prior.id],
                    |row| row.get(0),
                )?;
                before = baseline.as_ref().and_then(|older| {
                    revision_snapshot(connection, &snapshot.document_id, older).ok()
                });
                connection.execute("DELETE FROM revisions WHERE id = ?1", [&prior.id])?;
            }
        }
    }

    next.persist(connection, id)?;
    let json = comparison_json(compare(before.as_ref(), Some(snapshot), baseline.is_some()));
    write_comparisons(
        connection,
        vec![TimelineComparison {
            id: id.into(),
            baseline,
            json,
        }],
    )
}

pub(super) fn read_page(
    connection: &Connection,
    before: Option<HistoryCursor>,
    selected: Option<String>,
    known: Option<HistoryVersion>,
) -> AppResult<HistoryPage> {
    let head = head(connection)?;
    let maintenance_at_ms = maintenance_state(connection)?.map(|(_, completed)| completed);
    let selected_retained = match selected {
        Some(id) => connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM history_timeline WHERE id = ?1)
                OR (NOT EXISTS(SELECT 1 FROM history_timeline_state)
                    AND EXISTS(SELECT 1 FROM revision_index WHERE id = ?1))",
            [id],
            |row| row.get(0),
        )?,
        None => true,
    };
    let first_page = before.is_none();
    let mut page = HistoryPage {
        entries: Vec::new(),
        comparisons: HashMap::new(),
        previous_visible: HashMap::new(),
        groups: HashMap::new(),
        has_more: false,
        head_id: head.as_ref().map(|row| row.id.clone()),
        selected_retained,
        maintenance_at_ms,
        preparing: !initialized(connection)? && head.is_some(),
    };
    if page.preparing {
        return Ok(page);
    }
    if first_page
        && known.is_some_and(|known| {
            known.head_id == page.head_id && known.maintenance_at_ms == maintenance_at_ms
        })
    {
        return Ok(page);
    }
    let Some(cursor) = before.or(head.as_ref().map(HistoryCursor::from)) else {
        return Ok(page);
    };
    let mut statement = connection.prepare_cached(
        "SELECT r.id, r.created_at_ms, r.sequence, t.baseline_id, t.comparison
         FROM revision_index r JOIN history_timeline t ON t.id = r.id
         WHERE (r.created_at_ms, r.sequence) < (?1, ?2)
         ORDER BY r.created_at_ms DESC, r.sequence DESC LIMIT ?3",
    )?;
    let mut rows = statement.query(params![
        cursor.created_at_ms,
        cursor.sequence,
        PREPARED_PAGE_SIZE + 1
    ])?;
    while let Some(row) = rows.next()? {
        if page.entries.len() == PREPARED_PAGE_SIZE {
            page.has_more = true;
            break;
        }
        let entry = RevisionRecord {
            id: row.get(0)?,
            created_at_ms: row.get(1)?,
            sequence: row.get(2)?,
        };
        insert_comparison(&mut page, entry.id.clone(), row.get(3)?, row.get(4)?);
        page.entries.push(entry);
    }
    if let Some(head) = head.filter(|_| first_page) {
        if let Some((baseline, json)) = connection
            .query_row(
                "SELECT baseline_id, comparison FROM history_timeline WHERE id = ?1",
                [&head.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
        {
            insert_comparison(&mut page, head.id, baseline, json);
        }
    }
    Ok(page)
}

fn insert_comparison(page: &mut HistoryPage, id: String, baseline: Option<String>, json: String) {
    if let Ok(value) = serde_json::from_str(&json) {
        page.comparisons.insert(id.clone(), value);
    }
    page.previous_visible.insert(id, baseline);
}

pub(super) fn pruned_comparisons(
    connection: &Connection,
    deleted: &[&String],
) -> AppResult<Vec<TimelineComparison>> {
    if deleted.is_empty() {
        return Ok(Vec::new());
    }
    let deleted: HashSet<_> = deleted.iter().map(|id| id.as_str()).collect();
    let mut statement = connection.prepare(
        "SELECT t.id, t.baseline_id FROM revision_index r JOIN history_timeline t ON t.id = r.id
         ORDER BY r.created_at_ms DESC, r.sequence DESC",
    )?;
    let survivors = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let document = document_id(connection)?;
    let mut older: Option<&str> = None;
    let mut updates = Vec::new();
    for (id, prior_baseline) in survivors.iter().rev() {
        if deleted.contains(id.as_str()) {
            continue;
        }
        if prior_baseline.as_deref() != older {
            let after = revision_snapshot(connection, &document, id).ok();
            let before = older.and_then(|id| revision_snapshot(connection, &document, id).ok());
            let json = comparison_json(compare(before.as_ref(), after.as_ref(), older.is_some()));
            updates.push(TimelineComparison {
                id: id.clone(),
                baseline: older.map(str::to_owned),
                json,
            });
        }
        older = Some(id);
    }
    Ok(updates)
}

pub(super) fn timeline_ids(connection: &Connection) -> AppResult<Option<HashSet<String>>> {
    if !initialized(connection)? {
        return Ok(None);
    }
    let mut statement = connection.prepare("SELECT id FROM history_timeline")?;
    let ids = statement.query_map([], |row| row.get(0))?;
    Ok(Some(ids.collect::<Result<_, _>>()?))
}
