export async function writeSubtreeToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Some embedded webviews only expose the system clipboard through a copy event.
    const focused = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.className = "sr-only";
    textarea.value = text;
    document.body.append(textarea);
    textarea.select();
    try {
      if (!document.execCommand("copy")) throw new Error("Copy failed.");
    } finally {
      textarea.remove();
      if (focused instanceof HTMLElement) focused.focus();
    }
  }
}
