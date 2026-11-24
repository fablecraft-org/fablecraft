use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use similar::{capture_diff_slices, Algorithm};
use unicode_segmentation::UnicodeSegmentation;

use super::{manuscript, sorted_cards, CardRecord, EditableDocumentSnapshot};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryChange {
    description: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    card: Option<ChangedCard>,
    #[serde(skip_serializing_if = "Option::is_none")]
    characters: Option<CharacterChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    card_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    passage: Option<Passage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    card_range: Option<Passage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    added_ranges: Vec<Passage>,
}

#[derive(Serialize)]
struct ChangedCard {
    id: String,
    label: String,
}

#[derive(Serialize, Default)]
struct CharacterChange {
    added: usize,
    removed: usize,
    #[serde(skip)]
    added_ranges: Vec<Passage>,
}

struct TextRun {
    bytes: std::ops::Range<usize>,
    position: usize,
}

fn visible_text(node: &Value, position: usize, output: &mut String, runs: &mut Vec<TextRun>) {
    match node["type"].as_str() {
        Some("text" | "hardBreak") => {
            let start = output.len();
            if node["type"] == "hardBreak" {
                output.push('\n');
            } else {
                output.push_str(node["text"].as_str().unwrap_or_default());
            }
            if start < output.len() {
                runs.push(TextRun {
                    bytes: start..output.len(),
                    position,
                });
            }
        }
        _ => {
            let mut position = position + usize::from(node["type"] != "doc");
            for child in children(node) {
                visible_text(child, position, output, runs);
                position += manuscript::size(child);
            }
        }
    }
}

fn character_change(before: &Value, after: &Value) -> CharacterChange {
    let (mut old, mut new) = (String::new(), String::new());
    let mut runs = Vec::new();
    visible_text(before, 0, &mut old, &mut Vec::new());
    visible_text(after, 0, &mut new, &mut runs);
    let offsets = new
        .grapheme_indices(true)
        .map(|(index, _)| index)
        .chain(std::iter::once(new.len()))
        .collect::<Vec<_>>();
    let (old_graphemes, new_graphemes) = (
        old.graphemes(true).collect::<Vec<_>>(),
        new.graphemes(true).collect::<Vec<_>>(),
    );
    let mut result = CharacterChange::default();
    for operation in capture_diff_slices(Algorithm::Myers, &old_graphemes, &new_graphemes) {
        if operation.tag() != similar::DiffTag::Equal {
            result.added += operation.new_range().len();
            result.removed += operation.old_range().len();
            let range = operation.new_range();
            if range.is_empty() {
                continue;
            }
            let (start, end) = (offsets[range.start], offsets[range.end]);
            let first = runs.partition_point(|run| run.bytes.end <= start);
            for run in runs[first..].iter().take_while(|run| run.bytes.start < end) {
                let from = start.max(run.bytes.start);
                let to = end.min(run.bytes.end);
                let position = run.position + new[run.bytes.start..from].encode_utf16().count();
                result.added_ranges.push(Passage {
                    from: position,
                    to: position + new[from..to].encode_utf16().count(),
                });
            }
        }
    }
    result
}

fn parse_prose(json: &str) -> Value {
    serde_json::from_str(json).unwrap_or_default()
}

#[derive(Serialize)]
struct Passage {
    from: usize,
    to: usize,
}

struct Tree<'a> {
    cards: Vec<CardRecord>,
    numbers: HashMap<String, String>,
    parents: HashMap<String, Option<String>>,
    contents: HashMap<&'a str, &'a str>,
}

impl<'a> Tree<'a> {
    fn new(snapshot: &'a EditableDocumentSnapshot) -> Self {
        let cards = sorted_cards(&snapshot.cards);
        let mut depths = HashMap::new();
        let mut counts = HashMap::new();
        let mut numbers = HashMap::new();
        let mut parents = HashMap::new();
        for card in &cards {
            let depth = card
                .parent_id
                .as_ref()
                .and_then(|parent| depths.get(parent))
                .map_or(0, |depth| depth + 1);
            depths.insert(card.id.clone(), depth);
            let column = usize::min(depth, 25);
            let count = counts.entry(depth).or_insert(0);
            *count += 1;
            let letter = char::from(b'A' + column as u8);
            numbers.insert(card.id.clone(), format!("{letter}{count:02}"));
            parents.insert(card.id.clone(), card.parent_id.clone());
        }
        let contents = snapshot
            .contents
            .iter()
            .map(|entry| (entry.card_id.as_str(), entry.content_json.as_str()))
            .collect();
        Self {
            cards,
            numbers,
            parents,
            contents,
        }
    }

    fn contains(&self, id: &str) -> bool {
        self.parents.contains_key(id)
    }

    fn surviving_order(&self, other: &Self) -> HashMap<&str, usize> {
        let mut counts = HashMap::new();
        let mut order = HashMap::new();
        for card in &self.cards {
            if other.parents.get(&card.id) == Some(&card.parent_id) {
                let count = counts.entry(card.parent_id.as_deref()).or_insert(0);
                order.insert(card.id.as_str(), *count);
                *count += 1;
            }
        }
        order
    }

    fn deletion_target(&self, deleted: &CardRecord, next: &Self) -> Option<String> {
        let mut parent = deleted.parent_id.as_deref();
        while let Some(id) = parent {
            if next.contains(id) {
                return Some(id.to_string());
            }
            parent = self.parents.get(id).and_then(|id| id.as_deref());
        }
        self.cards
            .iter()
            .filter(|card| card.parent_id == deleted.parent_id && next.contains(&card.id))
            .min_by_key(|card| card.order_index.abs_diff(deleted.order_index))
            .or_else(|| next.cards.first())
            .map(|card| card.id.clone())
    }
}

fn children(node: &Value) -> &[Value] {
    node["content"].as_array().map_or(&[], Vec::as_slice)
}

fn text_span(before: &str, after: &str) -> (usize, usize, usize) {
    let prefix: usize = before
        .chars()
        .zip(after.chars())
        .take_while(|(a, b)| a == b)
        .map(|(ch, _)| ch.len_utf8())
        .sum();
    let suffix: usize = before[prefix..]
        .chars()
        .rev()
        .zip(after[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(ch, _)| ch.len_utf8())
        .sum();
    (prefix, before.len() - suffix, after.len() - suffix)
}

fn text_description(change: &CharacterChange, area: &str) -> String {
    match (change.removed > 0, change.added > 0) {
        (false, true) => format!("Text added to {area}"),
        (true, false) => format!("Text deleted from {area}"),
        (true, true) => format!("Text edited in {area}"),
        _ => format!("Formatting or links changed in {area}"),
    }
}

fn ignore_card_labels(value: &mut Value) {
    if value["type"] == "cardLink" {
        if let Some(attrs) = value.get_mut("attrs").and_then(Value::as_object_mut) {
            attrs.remove("label");
        }
    }
    if let Some(children) = value.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            ignore_card_labels(child);
        }
    }
}

fn moved_passage(old: &[manuscript::Passage], new: &[manuscript::Passage]) -> usize {
    new.iter()
        .find(|passage| {
            !old.iter().any(|prior| {
                prior.id == passage.id
                    && prior.from == passage.from
                    && prior.to == passage.to
                    && prior.target_card_ids == passage.target_card_ids
            })
        })
        .or_else(|| {
            old.iter()
                .find(|passage| !new.iter().any(|next| next.id == passage.id))
        })
        .map_or(0, |passage| passage.from)
}

fn first_changed_passage(old: &Value, new: &Value, at: usize) -> Passage {
    if let (Some(old_text), Some(new_text)) = (old["text"].as_str(), new["text"].as_str()) {
        let (from, _, to) = text_span(old_text, new_text);
        if from == to && old_text == new_text {
            return Passage {
                from: at,
                to: at + new_text.encode_utf16().count(),
            };
        }
        return Passage {
            from: at + new_text[..from].encode_utf16().count(),
            to: at + new_text[..to].encode_utf16().count(),
        };
    }
    let (old_children, new_children) = (children(old), children(new));
    let can_descend = old["type"] == new["type"] && old["attrs"] == new["attrs"];
    if can_descend && (!old_children.is_empty() || !new_children.is_empty()) {
        let mut pos = at + usize::from(new["type"] != "doc");
        for (index, child) in new_children.iter().enumerate() {
            if let Some(prior) = old_children.get(index) {
                if prior != child {
                    return first_changed_passage(prior, child, pos);
                }
            } else {
                return Passage {
                    from: pos,
                    to: pos + manuscript::size(child),
                };
            }
            pos += manuscript::size(child);
        }
        return Passage { from: pos, to: pos };
    }
    Passage {
        from: at,
        to: at + manuscript::size(new),
    }
}

pub(super) fn changes_between(
    before: &EditableDocumentSnapshot,
    after: &EditableDocumentSnapshot,
) -> Vec<HistoryChange> {
    let (old, new) = (Tree::new(before), Tree::new(after));
    let (old_order, new_order) = (old.surviving_order(&new), new.surviving_order(&old));
    let mut changes = Vec::new();
    for card in &new.cards {
        let id = card.id.as_str();
        let number = &new.numbers[id];
        let mut add = |description, card_range, kind, mut characters: Option<CharacterChange>| {
            let added_ranges = characters
                .as_mut()
                .map_or_else(Vec::new, |change| std::mem::take(&mut change.added_ranges));
            changes.push(HistoryChange {
                description,
                kind,
                card: Some(ChangedCard {
                    id: card.id.clone(),
                    label: number.clone(),
                }),
                characters,
                card_id: Some(card.id.clone()),
                passage: None,
                card_range,
                added_ranges,
            })
        };
        if !old.contains(id) {
            add(
                format!("{number} card added"),
                None,
                "cardAdded",
                Some(character_change(
                    &Value::Null,
                    &parse_prose(new.contents[id]),
                )),
            );
            continue;
        }
        if old.parents[id] != card.parent_id {
            let prior = &old.numbers[id];
            let description = if prior == number {
                format!("{number} card moved")
            } else {
                format!("{prior} card moved to {number}")
            };
            add(description, None, "cardMoved", None);
        } else if old_order.get(id) != new_order.get(id) {
            add(format!("{number} card reordered"), None, "cardMoved", None);
        }
        if old.contents.get(id) != new.contents.get(id) {
            let mut before: Value = serde_json::from_str(old.contents[id]).unwrap_or_default();
            let mut after: Value = serde_json::from_str(new.contents[id]).unwrap_or_default();
            ignore_card_labels(&mut before);
            ignore_card_labels(&mut after);
            if before != after {
                let characters = character_change(&before, &after);
                add(
                    text_description(&characters, number),
                    Some(first_changed_passage(&before, &after, 0)),
                    "cardEdited",
                    Some(characters),
                );
            }
        }
    }
    for card in &old.cards {
        if !new.contains(&card.id) {
            changes.push(HistoryChange {
                description: format!("{} card deleted", old.numbers[&card.id]),
                kind: "cardDeleted",
                card: Some(ChangedCard {
                    id: card.id.clone(),
                    label: old.numbers[&card.id].clone(),
                }),
                characters: Some(character_change(
                    &parse_prose(old.contents[card.id.as_str()]),
                    &Value::Null,
                )),
                card_id: old.deletion_target(card, &new),
                passage: None,
                card_range: None,
                added_ranges: Vec::new(),
            });
        }
    }

    let manuscript_documents = [&before.manuscript, &after.manuscript].map(|prose| {
        prose
            .as_ref()
            .map_or(Value::Null, |item| parse_prose(&item.content_json))
    });
    let mut manuscript_characters = if manuscript_documents[0] == manuscript_documents[1] {
        CharacterChange::default()
    } else {
        character_change(&manuscript_documents[0], &manuscript_documents[1])
    };
    let manuscript_change = match (&before.manuscript, &after.manuscript) {
        (None, None) => None,
        (None, Some(_)) => Some(("Manuscript added".into(), Passage { from: 0, to: 0 })),
        (Some(_), None) => Some(("Manuscript deleted".into(), Passage { from: 0, to: 0 })),
        (Some(old), Some(new)) => {
            let [before, after] = &manuscript_documents;
            let end = manuscript::size(after).saturating_sub(2);
            if before != after {
                let passage = first_changed_passage(before, after, 0);
                Some((
                    text_description(&manuscript_characters, "the manuscript"),
                    Passage {
                        from: passage.from.min(end),
                        to: passage.to.min(end),
                    },
                ))
            } else if old.passages != new.passages {
                let position = moved_passage(&old.passages, &new.passages).min(end);
                Some((
                    "Passage links changed in the manuscript".into(),
                    Passage {
                        from: position,
                        to: position,
                    },
                ))
            } else if old.id != new.id {
                Some(("Manuscript replaced".into(), Passage { from: 0, to: 0 }))
            } else {
                None
            }
        }
    };
    if let Some((description, passage)) = manuscript_change {
        let added_ranges = std::mem::take(&mut manuscript_characters.added_ranges);
        changes.push(HistoryChange {
            description,
            kind: "manuscript",
            card: None,
            characters: Some(manuscript_characters),
            card_id: None,
            passage: Some(passage),
            card_range: None,
            added_ranges,
        });
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::CardContentRecord;
    use serde_json::json;

    fn contents(text: &str) -> String {
        json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }]
        })
        .to_string()
    }

    fn tree(
        records: &[(&str, Option<&str>, usize, &str)],
        prose: Option<&str>,
    ) -> EditableDocumentSnapshot {
        EditableDocumentSnapshot {
            cards: records
                .iter()
                .map(|(id, parent, order, _)| CardRecord {
                    document_id: "doc".into(),
                    id: id.to_string(),
                    order_index: *order,
                    parent_id: parent.map(String::from),
                    card_type: "card".into(),
                })
                .collect(),
            contents: records
                .iter()
                .map(|(id, _, _, text)| CardContentRecord {
                    card_id: id.to_string(),
                    content_json: contents(text),
                })
                .collect(),
            document_id: "doc".into(),
            base_revision_id: None,
            manuscript_aware: true,
            manuscript: prose.map(|text| manuscript::Manuscript {
                id: "manuscript".into(),
                content_json: contents(text),
                passages: Vec::new(),
            }),
        }
    }

    #[test]
    fn counts_multiple_noncontiguous_edits_and_unicode_graphemes() {
        let counts = character_change(
            &parse_prose(&contents("a👩‍💻b c")),
            &parse_prose(&contents("a!b c?")),
        );
        assert_eq!(counts.added, 2);
        assert_eq!(counts.removed, 1);
        assert_eq!(
            counts
                .added_ranges
                .iter()
                .map(|range| (range.from, range.to))
                .collect::<Vec<_>>(),
            vec![(2, 3), (6, 7)]
        );
    }

    #[test]
    fn reports_card_text_and_deletion_without_reporting_order_shifts_and_targets_manuscript_utf16()
    {
        let before = tree(
            &[
                ("root", None, 0, "Root"),
                ("removed", Some("root"), 0, "An older card"),
                ("kept", Some("root"), 1, "Notes"),
                ("removed-child", Some("removed"), 0, "A deleted child"),
            ],
            Some("😀 end"),
        );
        let after = tree(
            &[
                ("root", None, 0, "Root"),
                ("kept", Some("root"), 0, "Notes revised"),
            ],
            Some("😀 new end"),
        );
        let changes = serde_json::to_value(changes_between(&before, &after)).unwrap();
        assert_eq!(
            changes,
            json!([
                { "description": "Text added to B01", "kind": "cardEdited", "card": {"id": "kept", "label": "B01"}, "cardId": "kept", "characters": {"added": 8, "removed": 0}, "cardRange": { "from": 6, "to": 14 }, "addedRanges": [{ "from": 6, "to": 14 }] },
                { "description": "B01 card deleted", "card": {"id": "removed", "label": "B01"}, "cardId": "root", "kind": "cardDeleted", "characters": {"added": 0, "removed": 13} },
                { "description": "C01 card deleted", "card": {"id": "removed-child", "label": "C01"}, "cardId": "root", "kind": "cardDeleted", "characters": {"added": 0, "removed": 15} },
                { "description": "Text added to the manuscript", "kind": "manuscript", "characters": {"added": 4, "removed": 0}, "passage": { "from": 4, "to": 8 }, "addedRanges": [{ "from": 4, "to": 8 }] }
            ])
        );
    }

    #[test]
    fn uses_destination_labels_for_swaps_and_new_cards() {
        let before = tree(&[("a", None, 0, "A"), ("b", None, 1, "B")], None);
        let after = tree(
            &[
                ("b", None, 0, "B"),
                ("a", None, 1, "A"),
                ("new", Some("a"), 0, "New"),
            ],
            None,
        );
        assert_eq!(
            serde_json::to_value(changes_between(&before, &after)).unwrap(),
            json!([
                { "description": "A01 card reordered", "kind": "cardMoved", "card": {"id": "b", "label": "A01"}, "cardId": "b" },
                { "description": "A02 card reordered", "kind": "cardMoved", "card": {"id": "a", "label": "A02"}, "cardId": "a" },
                { "description": "B01 card added", "kind": "cardAdded", "card": {"id": "new", "label": "B01"}, "cardId": "new", "characters": {"added": 3, "removed": 0}, "addedRanges": [{ "from": 1, "to": 4 }] }
            ]),
        );
    }

    #[test]
    fn distinguishes_moved_cards_and_formatting_from_text_edits() {
        let before = tree(
            &[
                ("root", None, 0, "Root"),
                ("left", Some("root"), 0, "Left"),
                ("right", Some("root"), 1, "Right"),
            ],
            None,
        );
        let mut after = before.clone();
        after.cards[2].parent_id = Some("left".into());
        after.cards[2].order_index = 0;
        after.contents[2].content_json = json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{
                "type": "text", "text": "Right", "marks": [{ "type": "italic" }]
            }] }]
        })
        .to_string();
        let changes = serde_json::to_value(changes_between(&before, &after)).unwrap();
        assert_eq!(
            changes,
            json!([
                { "description": "B02 card moved to C01", "card": {"id": "right", "label": "C01"}, "cardId": "right", "kind": "cardMoved" },
                { "description": "Formatting or links changed in C01", "kind": "cardEdited", "card": {"id": "right", "label": "C01"}, "cardId": "right", "characters": {"added": 0, "removed": 0}, "cardRange": { "from": 1, "to": 6 } }
            ])
        );
    }
}
