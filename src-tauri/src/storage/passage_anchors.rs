use std::collections::HashMap;

use serde_json::Value;

use super::{CardContentRecord, CardRecord};

/// The rich-text mark owns the association; only direct children are valid targets.
/// This also runs for MCP writes, which bypass frontend snapshot normalization.
pub(super) fn normalize(cards: &[CardRecord], contents: &mut [CardContentRecord]) {
    let parents: HashMap<&str, Option<&str>> = cards
        .iter()
        .map(|card| (card.id.as_str(), card.parent_id.as_deref()))
        .collect();
    for content in contents {
        if !content.content_json.contains("passageAnchor") {
            continue;
        }
        if let Ok(mut document) = serde_json::from_str::<Value>(&content.content_json) {
            if clean_node(&mut document, &content.card_id, &parents) {
                content.content_json = document.to_string();
            }
        }
    }
}

fn clean_node(node: &mut Value, source_id: &str, parents: &HashMap<&str, Option<&str>>) -> bool {
    let mut changed = false;
    if let Some(marks) = node.get_mut("marks").and_then(Value::as_array_mut) {
        let count = marks.len();
        marks.retain(|mark| {
            mark.get("type").and_then(Value::as_str) != Some("passageAnchor")
                || mark
                    .pointer("/attrs/childCardId")
                    .and_then(Value::as_str)
                    .and_then(|id| parents.get(id))
                    == Some(&Some(source_id))
        });
        changed = marks.len() != count;
        if marks.is_empty() && changed {
            node.as_object_mut().unwrap().remove("marks");
        }
    }
    if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            changed |= clean_node(child, source_id, parents);
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_direct_child_anchors_and_removes_deleted_or_reparented_targets() {
        let cards = vec![
            CardRecord {
                id: "parent".into(),
                document_id: "doc".into(),
                parent_id: None,
                order_index: 0,
                card_type: "card".into(),
            },
            CardRecord {
                id: "child".into(),
                document_id: "doc".into(),
                parent_id: Some("parent".into()),
                order_index: 0,
                card_type: "card".into(),
            },
        ];
        let content = json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text","text":"Passage","marks":[{"type":"bold"},{"type":"passageAnchor","attrs":{"childCardId":"child"}}]
        }]}]}).to_string();
        let mut contents = vec![CardContentRecord {
            card_id: "parent".into(),
            content_json: content.clone(),
        }];
        normalize(&cards, &mut contents);
        assert_eq!(contents[0].content_json, content);
        let mut moved = cards.clone();
        moved[1].parent_id = None;
        normalize(&moved, &mut contents);
        assert!(!contents[0].content_json.contains("passageAnchor"));
        assert!(contents[0].content_json.contains("bold"));
        contents[0].content_json = content;
        normalize(&cards[..1], &mut contents);
        assert!(!contents[0].content_json.contains("passageAnchor"));
    }
}
