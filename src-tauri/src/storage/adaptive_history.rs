use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;

use chrono::{DateTime, Datelike, NaiveDate, Timelike};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use similar::{capture_diff_slices, Algorithm, DiffTag};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

use super::{manuscript, sorted_cards, EditableDocumentSnapshot, RevisionRecord};
use crate::error::{AppError, AppResult};

// Versioned with the schema that stores burst and loss evidence.
pub(super) const BURST_GAP_MS: u64 = 60_000;
pub(super) const BURST_SPAN_MS: u64 = 10 * BURST_GAP_MS;
pub(super) const DAY_MS: u64 = 24 * 60 * 60 * 1000;
pub(super) const HOUR_MS: u64 = 60 * 60 * 1000;
pub(super) const RECENT_GRACE_MS: u64 = 10 * 60_000;
pub(super) const WEEK_MS: u64 = 7 * DAY_MS;
pub(super) const MONTH_MS: u64 = 30 * DAY_MS;
const LANDMARK_HOURS: u32 = 6;
const MOVED_PROSE_TOKENS: usize = 8;
const LOSS_TOKENS: usize = 20;
const LOSS_CARDS: usize = 3;
const TOKEN_POINTS: usize = 1;
const RUN_CAP: usize = 40;
const PROSE_CAP: usize = 120;
const PLACEMENT_POINTS: usize = 24;
const PLACEMENT_CAP: usize = 120;
const FORMAT_POINTS: usize = 8;
const FORMAT_CAP: usize = 40;
const LINK_POINTS: usize = 12;
const LINK_CAP: usize = 60;
const LOSS_BONUS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
struct Link {
    source: String,
    target: String,
    prose: Option<Vec<String>>,
}

#[derive(Debug, PartialEq, Eq)]
struct Text {
    fingerprint: u64,
    tokens: Vec<String>,
    styles: Vec<Arc<str>>,
    links: HashSet<Link>,
    selection_runs: Vec<(usize, String)>,
}

#[derive(Default)]
pub(super) struct Material {
    surfaces: HashMap<String, Arc<Text>>,
    parents: HashMap<String, Option<String>>,
    siblings: HashMap<Option<String>, Vec<String>>,
    links: HashSet<Link>,
    manuscript_id: Option<String>,
}

const MANUSCRIPT: &str = ""; // A valid card ID is nonempty.

fn children(node: &Value) -> &[Value] {
    node["content"].as_array().map_or(&[], Vec::as_slice)
}

fn token_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut word = None;
    for (index, ch) in text.char_indices() {
        if ch.is_alphanumeric() || is_combining_mark(ch) {
            word.get_or_insert(index);
        } else {
            if let Some(start) = word.take() {
                ranges.push((start, index));
            }
            if !ch.is_whitespace() {
                ranges.push((index, index + ch.len_utf8()));
            }
        }
    }
    if let Some(start) = word {
        ranges.push((start, text.len()));
    }
    ranges
}

fn tokens(text: &str) -> Vec<String> {
    token_ranges(text)
        .into_iter()
        .map(|(from, to)| text[from..to].nfc().collect())
        .collect()
}

#[derive(Default)]
struct TextReader {
    plain: String,
    styled: Vec<(usize, usize, String)>,
    links: HashSet<Link>,
    anchored: Vec<(String, usize, usize)>,
    selection_runs: Vec<(usize, String)>,
}

impl TextReader {
    fn read(&mut self, node: &Value, source: &str, pos: usize, path: &mut Vec<Value>) {
        let kind = node["type"].as_str().unwrap_or_default();
        if kind == "cardLink" {
            if let Some(target) = node["attrs"]["targetCardId"].as_str() {
                self.links.insert(Link {
                    source: source.into(),
                    target: target.into(),
                    prose: None,
                });
            }
            self.plain.push(' ');
            return;
        }
        if kind == "hardBreak" {
            self.plain.push(' ');
            return;
        }
        if kind == "text" {
            let text = node["text"].as_str().unwrap_or_default();
            let start = self.plain.len();
            self.plain.push_str(text);
            let end = self.plain.len();
            let marks = node["marks"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            let styles: Vec<_> = marks
                .iter()
                .filter(|mark| mark["type"] != "passageAnchor")
                .collect();
            self.styled
                .push((start, end, serde_json::json!([path, styles]).to_string()));
            for target in marks
                .iter()
                .filter_map(|mark| mark["attrs"]["childCardId"].as_str())
            {
                if let Some(last) = self
                    .anchored
                    .last_mut()
                    .filter(|last| last.0 == target && last.2 == start)
                {
                    last.2 = end;
                } else {
                    self.anchored.push((target.into(), start, end));
                }
            }
            if source == MANUSCRIPT {
                self.selection_runs.push((pos, text.to_string()));
            }
            return;
        }
        path.push(serde_json::json!([kind, node["attrs"]]));
        let mut child_position = pos + usize::from(kind != "doc");
        for child in children(node) {
            self.read(child, source, child_position, path);
            child_position += manuscript::size(child);
        }
        path.pop();
        if matches!(kind, "paragraph" | "heading" | "codeBlock") {
            self.plain.push(' ');
        }
    }

    fn finish(
        mut self,
        source: &str,
        fingerprint: u64,
        style_pool: &mut HashSet<Arc<str>>,
    ) -> Text {
        for (target, from, to) in self.anchored {
            self.links.insert(Link {
                source: source.into(),
                target,
                prose: Some(tokens(&self.plain[from..to])),
            });
        }
        let mut styles = Vec::new();
        let mut words = Vec::new();
        let mut start = 0;
        for (from, to) in token_ranges(&self.plain) {
            while self.styled.get(start).is_some_and(|span| span.1 <= from) {
                start += 1;
            }
            let mut segments = Vec::new();
            for (left, right, style) in self.styled[start..].iter().take_while(|span| span.0 < to) {
                let length = self.plain[(*left).max(from)..(*right).min(to)]
                    .nfc()
                    .count();
                if let Some((previous_length, _)) = segments
                    .last_mut()
                    .filter(|(_, previous)| *previous == style)
                {
                    *previous_length += length;
                } else {
                    segments.push((length, style));
                }
            }
            let encoded = serde_json::to_string(&segments).expect("formatting is serializable");
            let style = style_pool
                .get(encoded.as_str())
                .cloned()
                .unwrap_or_else(|| {
                    let style: Arc<str> = Arc::from(encoded);
                    style_pool.insert(style.clone());
                    style
                });
            styles.push(style);
            words.push(self.plain[from..to].nfc().collect());
        }
        Text {
            fingerprint,
            tokens: words,
            styles,
            links: self.links,
            selection_runs: self.selection_runs,
        }
    }
}

fn hash_node(node: &Value, state: &mut impl Hasher) {
    if node["type"] == "cardLink" {
        node["type"].hash(state);
        node["attrs"]["targetCardId"].hash(state);
        return;
    }
    if let Some(fields) = node.as_object() {
        for (key, value) in fields {
            key.hash(state);
            if key == "content" {
                children(node).len().hash(state);
                children(node)
                    .iter()
                    .for_each(|child| hash_node(child, state));
            } else {
                value.hash(state);
            }
        }
    } else {
        node.hash(state);
    }
}

fn selected_text(text: &Text, from: usize, to: usize) -> Vec<String> {
    let mut selected = String::new();
    let mut last_end = None;
    for (position, prose) in &text.selection_runs {
        if last_end.is_some_and(|end| end < *position) && !selected.is_empty() {
            selected.push(' ');
        }
        let mut at = *position;
        for ch in prose.chars() {
            if at >= from && at < to {
                selected.push(ch);
            }
            at += ch.len_utf16();
        }
        last_end = Some(at);
    }
    tokens(&selected)
}

// Share unchanged surfaces across neighboring full snapshots without retaining their raw bodies.
#[derive(Default)]
pub(super) struct MaterialReader {
    previous: HashMap<String, (String, Arc<Text>)>,
    style_pool: HashSet<Arc<str>>,
}

impl MaterialReader {
    pub(super) fn read(&mut self, snapshot: &EditableDocumentSnapshot) -> AppResult<Material> {
        let mut material = Material::default();
        let sources = snapshot
            .contents
            .iter()
            .map(|content| (content.card_id.as_str(), content.content_json.as_str()))
            .chain(
                snapshot
                    .manuscript
                    .iter()
                    .map(|prose| (MANUSCRIPT, prose.content_json.as_str())),
            );
        let mut next = HashMap::new();
        for (source, json) in sources {
            let entry = match self.previous.remove(source) {
                Some(entry) if entry.0 == json => entry,
                _ => {
                    let node: Value = serde_json::from_str(json).map_err(|_| {
                        AppError::invalid_input(
                            "history_revision_unavailable",
                            "Could not read prose for History.",
                        )
                    })?;
                    let mut reader = TextReader::default();
                    reader.read(&node, source, 0, &mut Vec::new());
                    let mut hasher = DefaultHasher::new();
                    hash_node(&node, &mut hasher);
                    (
                        json.to_string(),
                        Arc::new(reader.finish(source, hasher.finish(), &mut self.style_pool)),
                    )
                }
            };
            material.links.extend(entry.1.links.iter().cloned());
            material.surfaces.insert(source.into(), entry.1.clone());
            next.insert(source.into(), entry);
        }
        self.previous = next;
        for card in sorted_cards(&snapshot.cards) {
            material
                .parents
                .insert(card.id.clone(), card.parent_id.clone());
            material
                .siblings
                .entry(card.parent_id)
                .or_default()
                .push(card.id);
        }
        if let Some(prose) = &snapshot.manuscript {
            material.manuscript_id = Some(prose.id.clone());
            let text = &material.surfaces[MANUSCRIPT];
            for passage in &prose.passages {
                for target in &passage.target_card_ids {
                    material.links.insert(Link {
                        source: MANUSCRIPT.into(),
                        target: target.clone(),
                        prose: Some(selected_text(text, passage.from, passage.to)),
                    });
                }
            }
        }
        Ok(material)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct ProseItem {
    source: String,
    tokens: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Formatting {
    source: String,
    tokens: Vec<String>,
    styles: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Placement {
    card: String,
    parent: Option<String>,
    earlier: Vec<String>,
    later: Vec<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Recovery {
    prose: Vec<ProseItem>,
    formatting: Vec<Formatting>,
    placements: Vec<Placement>,
    links: Vec<Link>,
}

fn occurrences<'a>(text: &'a [String], phrase: &'a [String]) -> impl Iterator<Item = usize> + 'a {
    text.windows(phrase.len())
        .enumerate()
        .filter_map(move |(index, window)| (window == phrase).then_some(index))
}

impl Placement {
    fn covered(&self, survivor: &Material) -> bool {
        if survivor.parents.get(&self.card) != Some(&self.parent) {
            return false;
        }
        let siblings = &survivor.siblings[&self.parent];
        let Some(index) = siblings.iter().position(|id| id == &self.card) else {
            return false;
        };
        self.earlier.iter().all(|id| siblings[..index].contains(id))
            && self
                .later
                .iter()
                .all(|id| siblings[index + 1..].contains(id))
    }
}

impl Recovery {
    pub(super) fn between(candidate: &Material, head: &Material) -> Self {
        let mut result = Self::default();
        for (source, historical) in &candidate.surfaces {
            let current = head.surfaces.get(source);
            if current.is_some_and(|current| Arc::ptr_eq(historical, current)) {
                continue;
            }
            let comparison = current.map_or(&[][..], |text| text.tokens.as_slice());
            for operation in capture_diff_slices(Algorithm::Myers, &historical.tokens, comparison) {
                let old = operation.old_range();
                if old.is_empty() {
                    continue;
                }
                if operation.tag() == DiffTag::Equal {
                    if let Some(current) = current {
                        let new = operation.new_range();
                        let format_changes = historical.styles[old.clone()]
                            .iter()
                            .zip(&current.styles[new])
                            .any(|(a, b)| a != b);
                        if format_changes {
                            result.formatting.push(Formatting {
                                source: source.clone(),
                                tokens: historical.tokens[old.clone()].to_vec(),
                                styles: historical.styles[old]
                                    .iter()
                                    .map(ToString::to_string)
                                    .collect(),
                            });
                        }
                    }
                } else {
                    result.prose.push(ProseItem {
                        source: source.clone(),
                        tokens: historical.tokens[old].to_vec(),
                    });
                }
            }
        }
        for (parent, siblings) in &candidate.siblings {
            let shared: Vec<_> = siblings
                .iter()
                .filter(|id| head.parents.get(*id) == Some(parent))
                .collect();
            let head_shared: Vec<_> = head
                .siblings
                .get(parent)
                .into_iter()
                .flatten()
                .filter(|id| candidate.parents.get(*id) == Some(parent))
                .collect();
            let changed_order = shared != head_shared;
            for (index, card) in siblings.iter().enumerate() {
                let reordered = changed_order
                    && shared.iter().position(|id| *id == card)
                        != head_shared.iter().position(|id| *id == card);
                if head.parents.get(card) != Some(parent) || reordered {
                    let shared_at_parent = |id: &&String| head.parents.get(*id) == Some(parent);
                    result.placements.push(Placement {
                        card: card.clone(),
                        parent: parent.clone(),
                        earlier: siblings[..index]
                            .iter()
                            .filter(shared_at_parent)
                            .cloned()
                            .collect(),
                        later: siblings[index + 1..]
                            .iter()
                            .filter(shared_at_parent)
                            .cloned()
                            .collect(),
                    });
                }
            }
        }
        result
            .links
            .extend(candidate.links.difference(&head.links).cloned());
        result
    }

    fn cover(&mut self, document: &Material) {
        self.prose.retain(|item| {
            let matches = |text: &Text| occurrences(&text.tokens, &item.tokens).next().is_some();
            !(document
                .surfaces
                .get(&item.source)
                .is_some_and(|text| matches(text))
                || (item.tokens.len() >= MOVED_PROSE_TOKENS
                    && document.surfaces.values().any(|text| matches(text))))
        });
        self.formatting.retain(|item| {
            !document.surfaces.get(&item.source).is_some_and(|text| {
                occurrences(&text.tokens, &item.tokens).any(|index| {
                    text.styles[index..index + item.styles.len()]
                        .iter()
                        .zip(&item.styles)
                        .all(|(a, b)| a.as_ref() == b)
                })
            })
        });
        self.placements.retain(|item| !item.covered(document));
        self.links.retain(|item| !document.links.contains(item));
    }

    fn score(&self) -> usize {
        let prose = self
            .prose
            .iter()
            .map(|item| (item.tokens.len() * TOKEN_POINTS).min(RUN_CAP))
            .sum::<usize>();
        let formatting = self
            .formatting
            .iter()
            .map(|item| &item.source)
            .collect::<HashSet<_>>()
            .len();
        prose.min(PROSE_CAP)
            + (formatting * FORMAT_POINTS).min(FORMAT_CAP)
            + (self.placements.len() * PLACEMENT_POINTS).min(PLACEMENT_CAP)
            + (self.links.len() * LINK_POINTS).min(LINK_CAP)
    }
}

fn score_with_loss(recovery: &Recovery, loss: Option<&Recovery>) -> usize {
    let score = recovery.score();
    let bonus = score > 0 && loss.is_some_and(|loss| loss.score() > 0);
    score + if bonus { LOSS_BONUS } else { 0 }
}

pub(super) fn recovery_score(
    recovery: &Recovery,
    loss: Option<&Recovery>,
    coverage: &[&Material],
) -> usize {
    let mut recovery = recovery.clone();
    let mut loss = loss.cloned();
    for document in coverage {
        recovery.cover(document);
        if let Some(loss) = &mut loss {
            loss.cover(document);
        }
    }
    score_with_loss(&recovery, loss.as_ref())
}

pub(super) fn substantial_loss(before: &Material, after: &Material, recovery: &Recovery) -> bool {
    let mut removed_by_surface = HashMap::new();
    for item in &recovery.prose {
        *removed_by_surface.entry(&item.source).or_insert(0) += item.tokens.len();
    }
    removed_by_surface
        .values()
        .any(|count| *count >= LOSS_TOKENS)
        || before
            .parents
            .keys()
            .filter(|id| !after.parents.contains_key(*id))
            .count()
            >= LOSS_CARDS
        || (before.manuscript_id.is_some() && after.manuscript_id.is_none())
}

pub(super) enum Transition {
    Identical,
    Prose(String),
    Boundary,
}

pub(super) fn transition(before: &Material, after: &Material, restored: bool) -> Transition {
    if restored
        || before.parents != after.parents
        || before.siblings != after.siblings
        || before.links != after.links
        || before.manuscript_id != after.manuscript_id
    {
        return Transition::Boundary;
    }
    let mut changed = after.surfaces.iter().filter(|(source, text)| {
        before
            .surfaces
            .get(*source)
            .is_none_or(|old| old.fingerprint != text.fingerprint)
    });
    match (changed.next(), changed.next()) {
        (None, _) => Transition::Identical,
        (Some((source, _)), None) => Transition::Prose(source.clone()),
        _ => Transition::Boundary,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(super) enum Bucket {
    RecentWindow(NaiveDate, u32, u32),
    Hour(NaiveDate, u32),
    Window(NaiveDate, u32),
    Day(NaiveDate),
    Week(i32, u32),
}

impl Bucket {
    fn recovery_policy(self) -> (usize, usize) {
        match self {
            Self::RecentWindow(..) => (3, 12),
            Self::Hour(..) => (3, 12),
            Self::Window(..) => (1, 24),
            Self::Day(..) => (1, 40),
            Self::Week(..) => (1, 60),
        }
    }
}

pub(super) fn retention_bucket(
    created: u64,
    reference: u64,
    zone: Tz,
) -> AppResult<Option<Bucket>> {
    let age = reference.saturating_sub(created);
    if age <= RECENT_GRACE_MS {
        return Ok(None);
    }
    let date = DateTime::from_timestamp_millis(created as i64)
        .ok_or_else(|| {
            AppError::invalid_input(
                "invalid_revision_time",
                "A revision has an invalid save time.",
            )
        })?
        .with_timezone(&zone);
    let bucket = if age <= HOUR_MS {
        Bucket::RecentWindow(date.date_naive(), date.hour(), date.minute() / 10)
    } else if age <= DAY_MS {
        Bucket::Hour(date.date_naive(), date.hour())
    } else if age <= WEEK_MS {
        Bucket::Window(date.date_naive(), date.hour() / LANDMARK_HOURS)
    } else if age <= MONTH_MS {
        Bucket::Day(date.date_naive())
    } else {
        let week = date.iso_week();
        Bucket::Week(week.year(), week.week())
    };
    Ok(Some(bucket))
}

pub(super) struct ArchiveEntry {
    pub revision: RevisionRecord,
    pub material: Material,
    pub loss: Option<Recovery>,
    pub bucket: Option<Bucket>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RetentionReason {
    Recent,
    Landmark,
    Recovery(usize),
}

// Entries are in canonical newest-first order. Only the scored plan mutates the survivor set.
pub(super) fn retention_plan(entries: &[ArchiveEntry]) -> HashMap<String, RetentionReason> {
    let mut retained = HashMap::new();
    let mut landmarks = HashSet::new();
    let mut coverage = Vec::new();
    let mut candidates = Vec::new();
    let Some(head) = entries.first() else {
        return retained;
    };
    for (index, entry) in entries.iter().enumerate() {
        let reason = match entry.bucket {
            None => Some(RetentionReason::Recent),
            Some(Bucket::RecentWindow(..)) if entry.loss.is_some() => Some(RetentionReason::Recent),
            Some(bucket) if landmarks.insert(bucket) => Some(RetentionReason::Landmark),
            Some(_) if index == 0 => Some(RetentionReason::Landmark),
            Some(bucket) => {
                candidates.push((
                    entry,
                    bucket,
                    Recovery::between(&entry.material, &head.material),
                    entry.loss.clone(),
                ));
                None
            }
        };
        if let Some(reason) = reason {
            retained.insert(entry.revision.id.clone(), reason);
            coverage.push(&entry.material);
        }
    }
    for (_, _, recovery, loss) in &mut candidates {
        for document in &coverage {
            recovery.cover(document);
            if let Some(loss) = loss {
                loss.cover(document);
            }
        }
    }
    let mut used = HashMap::new();
    loop {
        let mut best = None;
        let mut best_score = 0;
        for (index, (entry, bucket, recovery, loss)) in candidates.iter().enumerate() {
            let (extras, minimum) = bucket.recovery_policy();
            if retained.contains_key(&entry.revision.id)
                || used.get(bucket).copied().unwrap_or(0) >= extras
            {
                continue;
            }
            let score = score_with_loss(recovery, loss.as_ref());
            if score >= minimum && score > best_score {
                best = Some(index);
                best_score = score;
            }
        }
        let Some(index) = best else { break };
        let (entry, bucket, _, _) = &candidates[index];
        retained.insert(
            entry.revision.id.clone(),
            RetentionReason::Recovery(best_score),
        );
        *used.entry(*bucket).or_insert(0) += 1;
        let chosen = &entry.material;
        for (candidate, bucket, recovery, loss) in &mut candidates {
            if retained.contains_key(&candidate.revision.id)
                || used.get(bucket).copied().unwrap_or(0) >= bucket.recovery_policy().0
            {
                continue;
            }
            recovery.cover(chosen);
            if let Some(loss) = loss {
                loss.cover(chosen);
            }
        }
    }
    retained
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{CardContentRecord, CardRecord};
    use serde_json::json;

    fn surface(id: &str, prose: &str, bold: bool) -> CardContentRecord {
        let mut text = json!({ "type": "text", "text": prose });
        if bold {
            text["marks"] = json!([{ "type": "bold" }]);
        }
        let contents = if prose.is_empty() {
            Vec::new()
        } else {
            vec![text]
        };
        CardContentRecord {
            card_id: id.into(),
            content_json: json!({
                "type": "doc",
                "content": [{ "type": "paragraph", "content": contents }],
            })
            .to_string(),
        }
    }

    fn snapshot(contents: Vec<CardContentRecord>) -> EditableDocumentSnapshot {
        let cards = contents
            .iter()
            .enumerate()
            .map(|(index, card)| CardRecord {
                document_id: "doc".into(),
                id: card.card_id.clone(),
                order_index: index,
                parent_id: None,
                card_type: "card".into(),
            })
            .collect();
        EditableDocumentSnapshot {
            cards,
            contents,
            document_id: "doc".into(),
            base_revision_id: None,
            manuscript_aware: true,
            manuscript: None,
        }
    }

    #[test]
    fn moved_prose_is_covered_and_nfc_equivalence_does_not_add_points() {
        let phrase = "one two three four five six seven eight";
        let mut reader = MaterialReader::default();
        let earlier = reader
            .read(&snapshot(vec![
                surface("a", phrase, false),
                surface("b", "Cafe\u{301}", false),
            ]))
            .unwrap();
        let head = reader
            .read(&snapshot(vec![
                surface("a", "", false),
                surface("b", &format!("Café {phrase}"), false),
            ]))
            .unwrap();
        assert_eq!(
            recovery_score(&Recovery::between(&earlier, &head), None, &[&head]),
            0
        );
    }

    #[test]
    fn formatting_and_empty_card_placement_have_independent_recovery_value() {
        let mut reader = MaterialReader::default();
        let earlier = reader
            .read(&snapshot(vec![
                surface("a", "Prose", true),
                surface("b", "", false),
            ]))
            .unwrap();
        let head = reader
            .read(&snapshot(vec![surface("a", "Prose", false)]))
            .unwrap();
        let delta = Recovery::between(&earlier, &head);
        assert_eq!(
            recovery_score(&delta, None, &[&head]),
            FORMAT_POINTS + PLACEMENT_POINTS
        );
        let formatting_kept = reader
            .read(&snapshot(vec![surface("a", "Prose", true)]))
            .unwrap();
        assert_eq!(
            recovery_score(&delta, None, &[&head, &formatting_kept]),
            PLACEMENT_POINTS
        );
    }
}
