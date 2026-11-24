import { markdownToBlocks, renderMarkdown, renderMarkdownBlocks } from '../shell/markdown.mjs';
import { readMarkdownTable, renderMarkdownTable } from '../shell/markdown-table.mjs';
import { renderChatCodeBlock } from './code-block.mjs';

let flowchartModule;
const streamingBlocks = new WeakMap();

export function hasExplicitRichContent(source) {
  if (!/[|]|\x60{3}|~{3}/.test(source)) return false;
  return markdownToBlocks(source, {readTable:readMarkdownTable}).some(block =>
    block.type === 'table' || (block.type === 'code' && (block.closed || block.language === 'mermaid')));
}

function renderCode(document, block) {
  const code = renderChatCodeBlock(document, block);
  const english = document.documentElement?.lang === 'en';
  const label = english ? 'Code' : '代码';
  code.dataset.summary = block.language ? `${label} · ${block.language}` : label;
  if (block.language !== 'mermaid' || !block.closed) return code;

  const container = document.createElement('div');
  container.className = 'chat-diagram';
  container.dataset.summary = english ? 'Mermaid diagram' : 'Mermaid 图表';
  container.append(code);
  queueMicrotask(() => {
    if (!container.isConnected) return;
    const fold = container.closest('details:not([open])');
    if (!fold) void showFlowchart(document, container, code, block.text);
    else fold.addEventListener('toggle', function onOpen() {
      if (!fold.open) return;
      fold.removeEventListener('toggle', onOpen);
      void showFlowchart(document, container, code, block.text);
    });
  });
  return container;
}

async function showFlowchart(document, container, code, text) {
  flowchartModule ??= import('../shell/flowchart.mjs').catch(() => {
    flowchartModule = undefined;
    return null;
  });
  try {
    const module = await flowchartModule;
    await module?.replaceMermaidSource(document, container, code, text);
  } catch {
    // Leave the original code visible if the chart renderer fails.
  }
}

const markdownOptions = {readTable:readMarkdownTable, renderTable:renderMarkdownTable, renderCode};

export function renderChatMarkdown(document, node, source) {
  node.className = 'chat-markdown';
  renderMarkdown(document, node, source, markdownOptions);
}

function renderStreamingCode(document, block) {
  if (block.language !== 'mermaid' || block.closed) return renderCode(document, block);
  const pending = document.createElement('p');
  pending.className = 'chat-diagram-pending';
  pending.textContent = document.documentElement?.lang === 'en' ? 'Writing diagram…' : '正在生成图表…';
  return pending;
}

export function renderStreamingMarkdown(document, node, source, {complete = false} = {}) {
  const blocks = markdownToBlocks(source, markdownOptions);
  const previous = streamingBlocks.get(node) || [];
  const signatures = blocks.map(block => !complete && block.type === 'code' && block.language === 'mermaid' && !block.closed
    ? 'pending diagram' : JSON.stringify(block));
  let unchanged = 0;
  while (unchanged < signatures.length && previous[unchanged] === signatures[unchanged]) unchanged += 1;

  const tail = node.children[unchanged];
  const table = blocks[unchanged]?.type === 'table' && tail?.classList.contains('chat-markdown-table-scroll') ? tail : null;
  const keep = table ? unchanged + 1 : unchanged;
  while (node.children.length > keep) node.children[node.children.length - 1].remove();
  if (table) {
    const replacement = document.createElement('div');
    renderMarkdownBlocks(document, replacement, [blocks[unchanged]], markdownOptions);
    const left = table.scrollLeft;
    table.replaceChildren(...replacement.firstChild.children);
    table.scrollLeft = left;
  }
  renderMarkdownBlocks(document, node, blocks.slice(keep), complete ? markdownOptions : {...markdownOptions, renderCode:renderStreamingCode});
  streamingBlocks.set(node, signatures);
}
