const MAX_COLUMNS = 24;
const MAX_ROWS = 120;
const MAX_LINE_LENGTH = 16_384;
const SEPARATOR = /^:?-+:?$/;
const BLOCK_START = /^(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|~~~)/;

// Match equal backtick runs in one pass. An unmatched run is ordinary text.
function codeClosers(line) {
  const runs = Array.from(line.matchAll(/`+/g));
  const byLength = new Map();
  const closers = new Map();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    const length = run[0].length;
    const next = byLength.get(length);
    if (next !== undefined) closers.set(run.index, next + length);
    byLength.set(length, run.index);
  }
  return closers;
}

function pipeRow(source, {separator = false} = {}) {
  if (!source || source.length > MAX_LINE_LENGTH || !source.includes('|')) return null;
  const line = source.trim();
  if (!separator && BLOCK_START.test(line)) return null;
  const closers = codeClosers(line);
  if (line.startsWith('```') && !closers.has(0)) return null;
  const cells = [];
  let field = '';
  let firstPipe = -1;
  let lastPipe = -1;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      const escaped = line[i + 1];
      field += escaped === '|' ? '|' : char + escaped;
      i += 1;
      continue;
    }
    const codeEnd = closers.get(i);
    if (codeEnd !== undefined) {
      field += line.slice(i, codeEnd).replace(/\\\|/g, '|');
      i = codeEnd - 1;
      continue;
    }
    if (char === '|') {
      if (firstPipe === -1) firstPipe = i;
      lastPipe = i;
      cells.push(field.trim());
      if (cells.length > MAX_COLUMNS + 1) return null;
      field = '';
    } else field += char;
  }
  if (firstPipe === -1) return null;
  cells.push(field.trim());
  if (firstPipe === 0) cells.shift();
  if (lastPipe === line.length - 1) cells.pop();
  return cells.length && cells.length <= MAX_COLUMNS ? cells : null;
}

export function readMarkdownTable(lines, index) {
  if (!lines[index + 1]?.includes('-')) return null;
  const header = pipeRow(lines[index]);
  const separator = header && pipeRow(lines[index + 1], {separator:true});
  if (!separator || header.length !== separator.length || !separator.every(cell => SEPARATOR.test(cell))) return null;

  const alignments = separator.map(cell => {
    if (cell.startsWith(':')) return cell.endsWith(':') ? 'center' : 'left';
    return cell.endsWith(':') ? 'right' : null;
  });
  const rows = [];
  let next = index + 2;
  while (next < lines.length && rows.length < MAX_ROWS) {
    const row = pipeRow(lines[next]);
    if (!row) break;
    rows.push(header.map((_, column) => row[column] ?? ''));
    next += 1;
  }
  return {next, block: {type:'table', alignments, header, rows}};
}

export function renderMarkdownTable(document, block, appendCell) {
  const scroll = document.createElement('div');
  scroll.className = 'chat-markdown-table-scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', document.documentElement?.lang?.startsWith('zh') ? '表格' : 'Table');
  const table = document.createElement('table');
  table.className = 'chat-markdown-table';
  const head = document.createElement('thead');
  const body = document.createElement('tbody');

  function addRow(section, contents, cellTag) {
    const row = document.createElement('tr');
    contents.forEach((text, column) => {
      const cell = document.createElement(cellTag);
      if (cellTag === 'th') cell.setAttribute('scope', 'col');
      if (block.alignments[column]) cell.setAttribute('data-align', block.alignments[column]);
      appendCell(cell, text);
      row.append(cell);
    });
    section.append(row);
  }

  addRow(head, block.header, 'th');
  for (const row of block.rows) addRow(body, row, 'td');
  table.append(head, body);
  scroll.append(table);
  return scroll;
}
