// Original, dependency-free markdown document surface. No stored HTML is executed.
import { renderMarkdown, domToMarkdown } from '../memory/rich.mjs';

export function bindDocumentEditor(document, form) {
  const root = document.getElementById('document-rich');
  const panel = document.getElementById('document-editor');
  const source = document.getElementById('document-source');
  const toggle = document.getElementById('document-source-toggle');
  const count = document.getElementById('document-length');
  let active = false, sourceMode = false, dirty = false;
  const flush = () => {
    if (!active) return;
    if (sourceMode) form.elements.body.value = source.value;
    else if (dirty) form.elements.body.value = domToMarkdown(root);
    if (count) {
      const size = form.elements.body.value.length;
      count.hidden = size <= 8000;
      count.textContent = `正文 ${size} / 8000 字符，超出上限时不能保存。`;
    }
  };
  const updateMode = () => {
    if (root) root.hidden = sourceMode;
    if (source) source.hidden = !sourceMode;
    if (toggle) toggle.setAttribute('aria-pressed', String(sourceMode));
    for (const button of document.querySelectorAll('[data-doc-format]')) button.disabled = sourceMode;
  };
  if (root) {
    root.addEventListener('input', () => { dirty = true; flush(); });
    root.addEventListener('paste', event => {
      const text = event.clipboardData && event.clipboardData.getData('text/plain');
      if (text == null) return;
      event.preventDefault();
      document.execCommand('insertText', false, text);
    });
  }
  if (source) source.addEventListener('input', flush);
  if (toggle) toggle.addEventListener('click', () => {
    flush();
    sourceMode = !sourceMode;
    if (sourceMode) source.value = form.elements.body.value;
    else { renderMarkdown(document, root, form.elements.body.value); dirty = false; }
    updateMode();
    (sourceMode ? source : root).focus();
  });
  for (const button of document.querySelectorAll('[data-doc-format]')) {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      if (!active || sourceMode || !root) return;
      root.focus();
      const selection = document.getSelection();
      if (!selection || !root.contains(selection.anchorNode)) return;
      const kind = button.dataset.docFormat;
      const command = {undo: 'undo', redo: 'redo', bold: 'bold', italic: 'italic', strike: 'strikeThrough',
        ul: 'insertUnorderedList', ol: 'insertOrderedList', hr: 'insertHorizontalRule'}[kind];
      if (command) document.execCommand(command, false, null);
      else {
        const tag = {h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', code: 'pre'}[kind];
        if (tag) document.execCommand('formatBlock', false,
          String(document.queryCommandValue('formatBlock')).toLowerCase() === tag ? 'p' : tag);
      }
      dirty = true; flush();
    });
  }
  return {
    flush,
    load(markdown, enabled) {
      active = enabled; dirty = false; sourceMode = false;
      if (panel) panel.hidden = !enabled;
      if (!enabled || !root || !source) return;
      renderMarkdown(document, root, markdown);
      source.value = markdown;
      if (count) count.hidden = true;
      updateMode();
    },
  };
}
