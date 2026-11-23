/**
 * The web view's own right-click menu («Назад», «Обновить», «Сохранить как», «Печать») means nothing in this program and
 * lets a page be reloaded in the middle of a call. It stays only where it helps: in a text field (cut, copy, paste)
 * and over selected text (copy). Menus of our own call preventDefault themselves and are not touched.
 */
export function keepsBrowserMenu(target: EventTarget | null, selection: string): boolean {
  if (selection.trim() !== "") return true;
  if (!(target instanceof Element)) return false;
  const field = target.closest("input, textarea, [contenteditable='true'], [contenteditable='']");
  if (!field) return false;
  if (field instanceof HTMLInputElement) {
    // Text-like inputs only: a checkbox or a range has nothing to copy.
    return ["text", "search", "url", "email", "password", "number", "tel", ""].includes(field.type);
  }
  return true;
}

export function installContextMenuGuard(doc: Document = document): () => void {
  const onMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (!keepsBrowserMenu(event.target, doc.getSelection()?.toString() ?? "")) event.preventDefault();
  };
  doc.addEventListener("contextmenu", onMenu);
  return () => doc.removeEventListener("contextmenu", onMenu);
}
