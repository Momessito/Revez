export function matchesSearch(value, query) {
  const normalize = (text) => String(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
  return normalize(value).includes(normalize(query.trim()));
}

export function filterThreads(threads, query) {
  return threads.filter(({ title, branch }) => matchesSearch(`${title} ${branch}`, query));
}

export function createDrafts() {
  const drafts = new Map();
  return {
    save(id, text) { if (id) { if (text) drafts.set(id, text); else drafts.delete(id); } },
    get(id) { return drafts.get(id) || ''; },
    clear() { drafts.clear(); },
  };
}

export function safeLink(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
