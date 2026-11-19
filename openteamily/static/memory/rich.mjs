// Markdown <-> rich-text bridge for the memory page editor.
// The page body is still stored as markdown through the existing save API;
// this module only renders it into safe DOM (createElement + textContent, never
// innerHTML) and serialises the edited DOM back. Self-written, no upstream.

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;
const ESCAPABLE = '\\`*_~[]#>-+.!';

export function safeHref(url) {
  const value = String(url || '').trim();
  return SAFE_HREF.test(value) ? value : '';
}

// ---- markdown -> blocks -------------------------------------------------
export function markdownToBlocks(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const fence = /^```\s*([\w-]{0,20})\s*$/.exec(line.trim());
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== '```') { body.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({type: 'code', text: body.join('\n')});
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({type: 'h' + heading[1].length, text: heading[2].trim()}); i += 1; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push({type: 'hr'}); i += 1; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocks.push({type: 'quote', text: body.join('\n')});
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const number = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || number.test(line)) {
      const ordered = !bullet.test(line);
      const pattern = ordered ? number : bullet;
      const items = [];
      while (i < lines.length && pattern.test(lines[i])) { items.push(pattern.exec(lines[i])[1]); i += 1; }
      blocks.push({type: ordered ? 'ol' : 'ul', items});
      continue;
    }
    const body = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s|^```|^\s*>|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])) {
      body.push(lines[i]); i += 1;
    }
    blocks.push({type: 'p', text: body.join('\n')});
  }
  return blocks;
}

// ---- inline markdown -> token tree -------------------------------------
const MARKS = [
  {mark: '**', type: 'b'},
  {mark: '~~', type: 's'},
  {mark: '*', type: 'i'},
  {mark: '_', type: 'i', word: true},
];

function isWord(ch) { return Boolean(ch) && /[\p{L}\p{N}]/u.test(ch); }

export function inlineTokens(text) {
  const src = String(text || '');
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({type: 'text', text: buf}); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (ch === '\n') { flush(); out.push({type: 'br'}); i += 1; continue; }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({type: 'code', text: src.slice(i + 1, end)}); i = end + 1; continue; }
    }
    if (ch === '[' && src[i + 1] !== '[') {
      const close = src.indexOf('](', i + 1);
      const end = close > i ? src.indexOf(')', close + 2) : -1;
      if (close > i && end > close && !src.slice(i + 1, close).includes('\n')) {
        const href = safeHref(src.slice(close + 2, end));
        if (href) {
          flush();
          out.push({type: 'link', href, children: inlineTokens(src.slice(i + 1, close))});
          i = end + 1;
          continue;
        }
      }
    }
    let matched = false;
    for (const {mark, type, word} of MARKS) {
      if (!src.startsWith(mark, i)) continue;
      const after = src[i + mark.length];
      if (!after || /\s/.test(after)) continue;
      if (word && isWord(src[i - 1])) continue;
      let end = src.indexOf(mark, i + mark.length);
      while (end > -1 && (/\s/.test(src[end - 1]) || (word && isWord(src[end + mark.length])) || src[end - 1] === '\\')) {
        end = src.indexOf(mark, end + 1);
      }
      if (end <= i + mark.length - 1 || end === -1) continue;
      const inner = src.slice(i + mark.length, end);
      if (!inner || inner.includes('\n\n')) continue;
      flush();
      out.push({type, children: inlineTokens(inner)});
      i = end + mark.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// ---- render into DOM ----------------------------------------------------
const INLINE_TAG = {b: 'strong', i: 'em', s: 's', code: 'code'};

function appendInline(document, parent, tokens) {
  for (const token of tokens) {
    if (token.type === 'text') parent.appendChild(document.createTextNode(token.text));
    else if (token.type === 'br') parent.appendChild(document.createElement('br'));
    else if (token.type === 'code') { const el = document.createElement('code'); el.textContent = token.text; parent.appendChild(el); }
    else if (token.type === 'link') {
      const el = document.createElement('a');
      el.setAttribute('href', token.href);
      el.setAttribute('rel', 'noreferrer');
      appendInline(document, el, token.children);
      parent.appendChild(el);
    } else {
      const el = document.createElement(INLINE_TAG[token.type]);
      appendInline(document, el, token.children);
      parent.appendChild(el);
    }
  }
}

export function renderMarkdown(document, root, source) {
  if (!root) return;
  while (root.firstChild) root.removeChild(root.firstChild);
  for (const block of markdownToBlocks(source)) {
    let el;
    if (block.type === 'hr') el = document.createElement('hr');
    else if (block.type === 'code') {
      el = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.text;
      el.appendChild(code);
    } else if (block.type === 'ul' || block.type === 'ol') {
      el = document.createElement(block.type);
      for (const item of block.items) {
        const li = document.createElement('li');
        appendInline(document, li, inlineTokens(item));
        el.appendChild(li);
      }
    } else {
      el = document.createElement(block.type === 'quote' ? 'blockquote' : block.type);
      appendInline(document, el, inlineTokens(block.text));
    }
    root.appendChild(el);
  }
  if (!root.firstChild) root.appendChild(document.createElement('p')).appendChild(document.createElement('br'));
}

// ---- DOM -> markdown ----------------------------------------------------
function escapeText(text) {
  return String(text).replace(/\u00a0/g, ' ').replace(/([\\`*]|~~)/g, '\\$1');
}

function tagOf(node) { return node && node.nodeType === 1 ? String(node.tagName || node.nodeName).toLowerCase() : ''; }

function inlineMarkdown(node) {
  let out = '';
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType === 3) { out += escapeText(child.nodeValue || ''); continue; }
    if (child.nodeType !== 1) continue;
    const tag = tagOf(child);
    if (tag === 'br') { out += '\n'; continue; }
    if (tag === 'code') { out += '`' + String(child.textContent || '').replace(/`/g, '') + '`'; continue; }
    const inner = inlineMarkdown(child);
    if (!inner.trim()) { out += inner; continue; }
    const lead = inner.match(/^\s*/)[0], trail = inner.match(/\s*$/)[0], core = inner.trim();
    if (tag === 'b' || tag === 'strong') out += lead + '**' + core + '**' + trail;
    else if (tag === 'i' || tag === 'em') out += lead + '_' + core + '_' + trail;
    else if (tag === 's' || tag === 'strike' || tag === 'del') out += lead + '~~' + core + '~~' + trail;
    else if (tag === 'a') {
      const href = safeHref(child.getAttribute && child.getAttribute('href'));
      out += href ? lead + '[' + core + '](' + href + ')' + trail : inner;
    } else out += inner;
  }
  return out;
}

function guardLineStart(text) {
  return text.split('\n').map(line => line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s|```)/, '$1\\$2')).join('\n');
}

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'hr']);

function blockMarkdown(node) {
  const tag = tagOf(node);
  if (tag === 'hr') return '---';
  if (tag === 'pre') return '```\n' + String(node.textContent || '').replace(/\n$/, '') + '\n```';
  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(3, Number(tag[1]));
    const text = inlineMarkdown(node).replace(/\n+/g, ' ').trim();
    return text ? '#'.repeat(level) + ' ' + text : '';
  }
  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(node.childNodes || []).filter(child => tagOf(child) === 'li');
    return items.map((li, index) => (tag === 'ol' ? (index + 1) + '. ' : '- ') + inlineMarkdown(li).replace(/\n+/g, ' ').trim()).join('\n');
  }
  if (tag === 'blockquote') {
    const nested = Array.from(node.childNodes || []).some(child => BLOCK_TAGS.has(tagOf(child)));
    const text = nested ? childrenMarkdown(node) : inlineMarkdown(node).trim();
    return text ? text.split('\n').map(line => '> ' + line).join('\n') : '';
  }
  const text = inlineMarkdown(node).replace(/^\n+|\n+$/g, '');
  return text.trim() ? guardLineStart(text) : '';
}

function childrenMarkdown(root) {
  const parts = [];
  let inline = null;
  const flushInline = () => {
    if (inline) {
      const text = inlineMarkdown(inline).replace(/^\n+|\n+$/g, '');
      if (text.trim()) parts.push(guardLineStart(text));
      inline = null;
    }
  };
  for (const child of Array.from(root.childNodes || [])) {
    const tag = tagOf(child);
    if (BLOCK_TAGS.has(tag)) {
      flushInline();
      if ((tag === 'div' || tag === 'p') && Array.from(child.childNodes || []).some(item => BLOCK_TAGS.has(tagOf(item)))) {
        const nested = childrenMarkdown(child);
        if (nested) parts.push(nested);
      } else {
        const text = blockMarkdown(child);
        if (text) parts.push(text);
      }
      continue;
    }
    if (!inline) inline = {childNodes: []};
    inline.childNodes.push(child);
  }
  flushInline();
  return parts.join('\n\n');
}

export function domToMarkdown(root) {
  return root ? childrenMarkdown(root) : '';
}
