export const EMPTY_EDITOR_DOCUMENT_JSON = JSON.stringify({
  content: [{ type: "paragraph" }],
  type: "doc",
});

export const NEW_CARD_EDITOR_DOCUMENT_JSON = JSON.stringify({
  content: [{ attrs: { level: 1 }, type: "heading" }],
  type: "doc",
});
