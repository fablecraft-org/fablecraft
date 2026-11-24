use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::CardRecord;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manuscript {
    pub id: String,
    pub content_json: String,
    pub passages: Vec<Passage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub id: String,
    pub from: usize,
    pub to: usize,
    pub target_card_ids: Vec<String>,
}

fn invalid(message: &str) -> AppError {
    AppError::invalid_input("invalid_manuscript", message)
}

fn kind(node: &Value) -> &str {
    node["type"].as_str().unwrap_or("")
}

fn children(node: &Value) -> &[Value] {
    node["content"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn block(node: &Value) -> bool {
    matches!(
        kind(node),
        "paragraph"
            | "heading"
            | "blockquote"
            | "bulletList"
            | "orderedList"
            | "codeBlock"
            | "horizontalRule"
    )
}

fn inline(node: &Value) -> bool {
    matches!(kind(node), "text" | "hardBreak")
}

fn valid_node(node: &Value) -> bool {
    let content = children(node);
    if node.get("content").is_some_and(|value| !value.is_array()) {
        return false;
    }
    let marks_ok = node.get("marks").is_none_or(|marks| {
        marks.as_array().is_some_and(|marks| {
            if !marks.is_empty() && !inline(node) {
                return false;
            }
            let mut names = HashSet::new();
            marks.iter().all(|mark| {
                names.insert(kind(mark))
                    && match kind(mark) {
                        "bold" | "italic" | "strike" | "underline" => true,
                        "code" => marks.len() == 1,
                        "link" => mark["attrs"]["href"].as_str().is_some(),
                        _ => false,
                    }
            })
        })
    });
    let structure_ok = match kind(node) {
        "doc" | "blockquote" => !content.is_empty() && content.iter().all(block),
        "heading" => {
            node["attrs"]["level"]
                .as_u64()
                .is_some_and(|level| (1..=6).contains(&level))
                && content.iter().all(inline)
        }
        "paragraph" => content.iter().all(inline),
        "orderedList" | "bulletList" => {
            !content.is_empty() && content.iter().all(|child| kind(child) == "listItem")
        }
        "listItem" => {
            content
                .first()
                .is_some_and(|child| kind(child) == "paragraph")
                && content.iter().all(block)
        }
        "codeBlock" => content.iter().all(|child| {
            kind(child) == "text"
                && child
                    .get("marks")
                    .is_none_or(|marks| marks.as_array().is_some_and(Vec::is_empty))
        }),
        "horizontalRule" | "hardBreak" => content.is_empty(),
        "text" => content.is_empty() && node["text"].as_str().is_some_and(|text| !text.is_empty()),
        _ => false,
    };
    structure_ok && marks_ok && content.iter().all(valid_node)
}

fn document(prose: &Manuscript) -> AppResult<Value> {
    if Uuid::parse_str(&prose.id).is_err() {
        return Err(invalid("The manuscript identity is invalid."));
    }
    let doc: Value = serde_json::from_str(&prose.content_json)
        .map_err(|_| invalid("Manuscript prose is invalid JSON."))?;
    if kind(&doc) != "doc" || !valid_node(&doc) {
        return Err(invalid(
            "Manuscript prose does not match the rich-text schema.",
        ));
    }
    Ok(doc)
}

pub(super) fn size(node: &Value) -> usize {
    match kind(node) {
        "text" => node["text"].as_str().unwrap_or("").encode_utf16().count(),
        "horizontalRule" | "hardBreak" | "cardLink" => 1,
        _ => 2 + children(node).iter().map(size).sum::<usize>(),
    }
}

// Record UTF-16 positions at scalar boundaries and the non-whitespace text runs
// used for validating half-open ranges. Container boundaries occupy one position.
fn coordinates(
    node: &Value,
    start: usize,
    boundaries: &mut HashSet<usize>,
    text: &mut Vec<(usize, usize)>,
) {
    boundaries.insert(start);
    if kind(node) == "text" {
        let mut pos = start;
        for ch in node["text"].as_str().unwrap_or("").chars() {
            let next = pos + ch.len_utf16();
            if !(ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}')) {
                text.push((pos, next));
            }
            pos = next;
            boundaries.insert(pos);
        }
        return;
    }
    let mut pos = start + 1;
    for child in children(node) {
        coordinates(child, pos, boundaries, text);
        pos += size(child);
    }
    boundaries.insert(pos);
    boundaries.insert(start + size(node));
}

fn valid_range(
    passage: &Passage,
    doc_size: usize,
    boundaries: &HashSet<usize>,
    text: &[(usize, usize)],
) -> bool {
    passage.from < passage.to
        && passage.to <= doc_size
        && boundaries.contains(&(passage.from + 1))
        && boundaries.contains(&(passage.to + 1))
        && text
            .get(text.partition_point(|&(_, to)| to <= passage.from + 1))
            .is_some_and(|&(from, _)| from < passage.to + 1)
}

pub fn retain_targets(prose: &mut Manuscript, cards: &[CardRecord]) {
    let card_ids: HashSet<_> = cards.iter().map(|card| card.id.as_str()).collect();
    prose.passages.retain_mut(|passage| {
        let Some(target) = passage.target_card_ids.pop() else {
            return false;
        };
        passage.target_card_ids.clear();
        if !card_ids.contains(target.as_str()) {
            return false;
        }
        passage.target_card_ids.push(target);
        true
    });
}

fn ranges_overlap(passages: &[Passage]) -> bool {
    let mut ordered: Vec<_> = passages.iter().map(|p| (p.from, p.to)).collect();
    ordered.sort_unstable();
    ordered.windows(2).any(|pair| pair[0].1 > pair[1].0)
}

fn split_id(source: &str, from: usize, to: usize) -> String {
    // Keep legacy repairs stable across reads before the next save persists them.
    let id = Uuid::parse_str(source)
        .expect("validated passage ID")
        .as_u128();
    let positions = ((from as u128) << 64) | to as u128;
    let mut bytes = (id ^ positions.wrapping_mul(0x9e37_79b9_7f4a_7c15)).to_be_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn resolve_overlaps(
    passages: &mut Vec<Passage>,
    doc_size: usize,
    boundaries: &HashSet<usize>,
    text: &[(usize, usize)],
) {
    if !ranges_overlap(passages) {
        return;
    }
    let mut resolved = Vec::<Passage>::new();
    for next in std::mem::take(passages) {
        let mut remaining = Vec::new();
        for mut prior in resolved {
            if prior.to <= next.from || prior.from >= next.to {
                remaining.push(prior);
                continue;
            }
            let mut left = prior.clone();
            left.to = left.to.min(next.from);
            let keep_left = valid_range(&left, doc_size, boundaries, text);
            prior.from = prior.from.max(next.to);
            if valid_range(&prior, doc_size, boundaries, text) {
                if keep_left {
                    prior.id = split_id(&prior.id, prior.from, prior.to);
                }
                remaining.push(prior);
            }
            if keep_left {
                remaining.push(left);
            }
        }
        remaining.push(next);
        resolved = remaining;
    }
    *passages = resolved;
}

pub fn validate(prose: &Manuscript, cards: &[CardRecord]) -> AppResult<()> {
    let doc = document(prose)?;
    let card_ids: HashSet<_> = cards.iter().map(|card| card.id.as_str()).collect();
    let mut ids = HashSet::new();
    let mut boundaries = HashSet::new();
    let mut text = Vec::new();
    coordinates(&doc, 0, &mut boundaries, &mut text);
    let doc_size = size(&doc) - 2;
    for passage in &prose.passages {
        if Uuid::parse_str(&passage.id).is_err()
            || !ids.insert(&passage.id)
            || !valid_range(passage, doc_size, &boundaries, &text)
            || passage.target_card_ids.len() != 1
            || !card_ids.contains(passage.target_card_ids[0].as_str())
        {
            return Err(invalid(
                "A manuscript passage has an invalid range, identity or target.",
            ));
        }
    }
    if ranges_overlap(&prose.passages) {
        return Err(invalid("Manuscript passages cannot overlap."));
    }
    Ok(())
}

pub fn load(connection: &Connection, cards: &[CardRecord]) -> AppResult<Option<Manuscript>> {
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT id, content_json, passages_json FROM manuscript WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((id, content_json, passages_json)) = row else {
        return Ok(None);
    };
    let items: Vec<Value> = serde_json::from_str(&passages_json).unwrap_or_default();
    let mut prose = Manuscript {
        id,
        content_json,
        passages: items
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect(),
    };
    repair(&mut prose, cards)?;
    Ok(Some(prose))
}

pub(super) fn repair(prose: &mut Manuscript, cards: &[CardRecord]) -> AppResult<()> {
    let doc = document(prose)?;
    let mut ids = HashSet::new();
    let mut boundaries = HashSet::new();
    let mut text = Vec::new();
    coordinates(&doc, 0, &mut boundaries, &mut text);
    let doc_size = size(&doc) - 2;
    prose.passages.retain(|passage| {
        valid_range(passage, doc_size, &boundaries, &text)
            && Uuid::parse_str(&passage.id).is_ok()
            && ids.insert(passage.id.clone())
    });
    resolve_overlaps(&mut prose.passages, doc_size, &boundaries, &text);
    retain_targets(prose, cards);
    Ok(())
}

fn inline_segment(nodes: &[Value], start: usize, end: usize) -> AppResult<Vec<Value>> {
    let mut segment = Vec::new();
    let mut pos = 0;
    for node in nodes {
        let next = pos + size(node);
        let from = start.max(pos);
        let to = end.min(next);
        if from < to {
            let mut piece = node.clone();
            if kind(node) == "text" && (from != pos || to != next) {
                let units: Vec<_> = node["text"].as_str().unwrap_or("").encode_utf16().collect();
                piece["text"] = json!(String::from_utf16(&units[from - pos..to - pos])
                    .map_err(|_| invalid("An edit endpoint splits a UTF-16 surrogate pair."))?);
            }
            segment.push(piece);
        }
        pos = next;
    }
    Ok(segment)
}

// Fit a closed rich fragment at sibling boundaries, or splice inline content
// inside a single textblock. Reject edits requiring implicit schema fitting.
fn replace(
    node: &mut Value,
    start: usize,
    from: usize,
    to: usize,
    insert: &[Value],
) -> AppResult<bool> {
    let content = children(node);
    let end = start + content.iter().map(size).sum::<usize>();
    if start > from || to > end {
        return Ok(false);
    }
    if matches!(kind(node), "paragraph" | "heading" | "codeBlock") && insert.iter().all(inline) {
        let mut next = inline_segment(content, 0, from - start)?;
        next.extend_from_slice(insert);
        next.extend(inline_segment(content, to - start, end - start)?);
        node["content"] = json!(next);
        return Ok(true);
    }
    let mut offsets = vec![start];
    for child in content {
        offsets.push(offsets.last().unwrap() + size(child));
    }
    if let (Ok(first), Ok(last)) = (offsets.binary_search(&from), offsets.binary_search(&to)) {
        if insert.iter().all(|child| !inline(child)) {
            let content = node["content"].as_array_mut().expect("container content");
            content.splice(first..last, insert.iter().cloned());
            if kind(node) == "doc" && children(node).is_empty() {
                node["content"] = json!([{"type": "paragraph"}]);
            }
            return Ok(true);
        }
    }
    for (index, window) in offsets.windows(2).enumerate() {
        if window[0] < from && to < window[1] && !inline(&content[index]) {
            return replace(&mut node["content"][index], window[0] + 1, from, to, insert);
        }
    }
    Ok(false)
}

pub fn edit(prose: &mut Manuscript, from: usize, to: usize, insert: &[Value]) -> AppResult<()> {
    let mut doc = document(prose)?;
    if from > to
        || to > size(&doc) - 2
        || !insert.iter().all(valid_node)
        || !replace(&mut doc, 0, from, to, insert)?
        || !valid_node(&doc)
    {
        return Err(invalid(
            "Choose one textblock or a range aligned to sibling block boundaries.",
        ));
    }
    let inserted = insert.iter().map(size).sum::<usize>();
    let map = |pos: usize, is_start: bool| {
        if pos < from {
            return pos;
        }
        if pos > to {
            return pos - (to - from) + inserted;
        }
        // Match StepMap association at insertions, and preserve which side
        // of an existing replacement the exact boundaries belong to.
        let after = if from == to {
            is_start
        } else if pos == from {
            false
        } else if pos == to {
            true
        } else {
            is_start
        };
        from + if after { inserted } else { 0 }
    };
    let mut boundaries = HashSet::new();
    let mut text = Vec::new();
    coordinates(&doc, 0, &mut boundaries, &mut text);
    let doc_size = size(&doc) - 2;
    prose.passages.retain_mut(|passage| {
        if from < to && from <= passage.from && passage.to <= to && inserted > 0 {
            passage.from = from;
            passage.to = from + inserted;
        } else {
            passage.from = map(passage.from, true);
            passage.to = map(passage.to, false);
        }
        valid_range(passage, doc_size, &boundaries, &text)
    });
    resolve_overlaps(&mut prose.passages, doc_size, &boundaries, &text);
    prose.content_json = doc.to_string();
    Ok(())
}
