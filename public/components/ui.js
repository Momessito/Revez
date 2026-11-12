import { safeLink } from '../lib/workspace-state.js';

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label, { variant = 'quiet', onClick, disabled = false } = {}) {
  const node = element('button', `button ${variant}`, label);
  node.type = 'button';
  node.disabled = disabled;
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function emptyState(title, description, action) {
  const node = element('section', 'empty-state');
  node.append(element('span', 'empty-icon mono', '↬'), element('h2', '', title), element('p', 'muted', description));
  if (action) node.append(action);
  return node;
}

export function statusIndicator(label, state = 'idle') {
  const node = element('span', `status-indicator status-${state}`);
  node.append(element('span', 'dot'), element('span', '', label));
  return node;
}

export function codeBlock(source, language = '') {
  const node = element('div', 'code-block');
  const head = element('div', 'code-head');
  const copy = button('Copiar', { onClick: async () => {
    try { await navigator.clipboard.writeText(source); copy.textContent = 'Copiado'; }
    catch { copy.textContent = 'Selecione para copiar'; }
  } });
  copy.setAttribute('aria-label', 'Copiar bloco de código');
  head.append(element('span', 'mono', language || 'código'), copy);
  const pre = element('pre');
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', `Código ${language}`.trim());
  pre.append(element('code', '', source));
  node.append(head, pre);
  return node;
}

function inline(text, parent) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    const value = match[0];
    if (value.startsWith('`')) parent.append(element('code', 'inline-code', value.slice(1, -1)));
    else if (value.startsWith('**')) parent.append(element('strong', '', value.slice(2, -2)));
    else if (value.startsWith('*')) parent.append(element('em', '', value.slice(1, -1)));
    else {
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(value);
      const href = safeLink(link[2]);
      if (href) {
        const anchor = element('a', '', link[1]);
        Object.assign(anchor, { href, target: '_blank', rel: 'noopener noreferrer' });
        parent.append(anchor);
      } else parent.append(document.createTextNode(value));
    }
    start = match.index + value.length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}

export function markdown(text) {
  const node = element('div', 'markdown');
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const p = element('p'); inline(paragraph.join('\n'), p); node.append(p); paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```([\w.+-]*)\s*$/.exec(lines[i]);
    if (fence) {
      flush(); const code = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
      node.append(codeBlock(code.join('\n'), fence[1])); continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(lines[i]);
    const list = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(lines[i]);
    const quote = /^>\s?(.*)$/.exec(lines[i]);
    if (!lines[i].trim()) flush();
    else if (heading || quote) {
      flush(); const block = element(heading ? `h${heading[1].length + 2}` : 'blockquote');
      inline(heading ? heading[2] : quote[1], block); node.append(block);
    } else if (list) {
      flush(); const tag = /^\d/.test(lines[i]) ? 'ol' : 'ul';
      let group = node.lastElementChild;
      if (group?.localName !== tag) { group = element(tag); node.append(group); }
      const item = element('li'); inline(list[1], item); group.append(item);
    } else paragraph.push(lines[i]);
  }
  flush();
  return node;
}
