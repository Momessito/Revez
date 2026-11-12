import { button, element, emptyState, statusIndicator } from './ui.js';
import { matchesSearch } from '../lib/workspace-state.js';

const $ = (id) => document.getElementById(id);
const media = (width) => window.matchMedia(`(max-width: ${width}px)`).matches;
const tabs = ['context', 'execution', 'activity'];
const tabIds = ['tabContext', 'tabExecution', 'tabActivity'];

export function createWorkspaceUI({ getState, selectThread, refresh, renderContext }) {
  let view = 'workspace';
  let tab = 'context';
  let overviewKey;
  let panelKey;
  let connection = 'connecting';
  let commands = [];
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem('revez.interface') || '{}') || {}; } catch { /* Defaults work without storage. */ }
  function save() {
    try { localStorage.setItem('revez.interface', JSON.stringify(preferences)); } catch { /* Private mode can deny storage. */ }
  }
  for (const name of ['threads', 'context']) $('shell').classList.toggle(`hide-${name}`, preferences[name] === false);

  function syncToggles() {
    for (const name of ['threads', 'context']) {
      const mobile = media(name === 'threads' ? 600 : 900);
      const expanded = mobile ? $('shell').classList.contains(`show-${name}`) : !$('shell').classList.contains(`hide-${name}`);
      $(name === 'threads' ? 'toggleThreads' : 'toggleContext').setAttribute('aria-expanded', String(expanded && (name !== 'context' || view === 'workspace')));
    }
  }
  function closeOverlays() {
    const name = $('shell').classList.contains('show-context') ? 'context' : $('shell').classList.contains('show-threads') ? 'threads' : null;
    const focused = document.activeElement;
    $('shell').classList.remove('show-threads', 'show-context');
    if (name && $(name === 'threads' ? 'projectSidebar' : 'contextPanel').contains(focused)) $(name === 'threads' ? 'toggleThreads' : 'toggleContext').focus();
    syncToggles();
  }
  function togglePanel(name, value) {
    if (name === 'context' && view !== 'workspace') setView('workspace');
    const mobile = media(name === 'threads' ? 600 : 900);
    if (mobile) {
      const show = value ?? !$('shell').classList.contains(`show-${name}`);
      closeOverlays();
      $('shell').classList.toggle(`show-${name}`, show);
      if (show) $(name === 'threads' ? 'searchThreads' : tabIds[tabs.indexOf(tab)]).focus();
    } else {
      const show = value ?? $('shell').classList.contains(`hide-${name}`);
      $('shell').classList.toggle(`hide-${name}`, !show);
      preferences[name] = show; save();
    }
    syncToggles();
  }
  function setView(next) {
    view = next;
    $('agentWorkspace').hidden = view !== 'workspace';
    $('overview').hidden = view !== 'overview';
    $('shell').classList.toggle('view-overview', view === 'overview');
    $('showOverview').setAttribute('aria-current', view === 'overview' ? 'page' : 'false');
    $('showWorkspace').setAttribute('aria-current', view === 'workspace' ? 'page' : 'false');
    closeOverlays();
    if (view === 'overview') renderOverview();
    syncToggles();
  }
  function setConnection(state) {
    connection = state;
    const label = { connected: 'Atualizações conectadas', connecting: 'Conectando atualizações…', reconnecting: 'Reconectando · atualização periódica ativa', offline: 'Sem conexão com a rede' }[state];
    $('syncStatus').replaceChildren(statusIndicator(label, state === 'offline' ? 'error' : state));
  }
  function section(title, value) {
    const node = element('section', 'context-group');
    node.append(element('h3', 'eyebrow', title), element('p', '', value));
    return node;
  }
  function renderOverview() {
    const { workspace } = getState();
    if (!workspace) return;
    const key = JSON.stringify(workspace);
    if (overviewKey === key) return;
    overviewKey = key;
    const head = element('header', 'overview-header');
    const title = element('div');
    title.append(element('div', 'eyebrow', 'Workspace'), element('h1', '', workspace.project), element('p', 'muted', workspace.repository));
    head.append(title, button('＋ Nova conversa', { variant: 'primary', onClick: () => $('newThread').click() }));
    const stats = element('div', 'overview-stats');
    for (const [count, label] of [[workspace.threads.length, 'Conversas'], [workspace.devices.filter((device) => device.online).length, 'Seus computadores conectados'], [workspace.members.length, 'Membros cadastrados']]) {
      const stat = element('div', 'muted'); stat.append(element('strong', '', String(count)), document.createTextNode(label)); stats.append(stat);
    }
    const sessions = element('section', 'overview-section');
    sessions.append(element('h2', '', 'Conversas do projeto'));
    for (const row of workspace.threads) {
      const item = button('', { onClick: () => selectThread(row.id) });
      item.className = 'overview-session';
      item.append(element('span', '', row.title), element('small', '', row.branch)); sessions.append(item);
    }
    if (!workspace.threads.length) sessions.append(emptyState('Nenhuma conversa ainda', 'Crie uma conversa para reunir a equipe e o contexto do projeto.'));
    const people = element('section', 'overview-section');
    people.append(element('h2', '', 'Equipe do workspace'), element('p', 'muted small', workspace.members.map(({ name }) => name).join(' · ')));
    $('overview').replaceChildren(head, stats, sessions, people);
  }
  function renderPanel(sharedContext) {
    const { workspace, thread } = getState();
    if (!workspace || !thread) return;
    const key = JSON.stringify([tab, workspace.devices, thread, $('recipient').value, $('deviceSelect').value]);
    if (panelKey === key) return;
    panelKey = key;
    $('editContext').hidden = tab !== 'context' || !thread.id;
    if (tab === 'context') { sharedContext(); return; }
    const nodes = [];
    const person = (id) => workspace.members.find((member) => member.id === id)?.name || 'Equipe';
    if (tab === 'execution') {
      nodes.push(section('Execuções desta conversa', thread.pending.length ? 'Rodadas solicitadas pela equipe.' : 'Nenhuma rodada em andamento.'));
      for (const job of thread.pending) {
        const node = section(job.device || 'Agente', `Iniciada por ${person(job.author)}`);
        node.append(statusIndicator(job.status === 'running' ? 'Em execução' : 'Aguardando agente', job.status === 'running' ? 'running' : 'waiting'));
        nodes.push(node);
      }
      nodes.push(section('Seus agentes locais', 'Disponibilidade dos computadores vinculados à sua conta.'));
      for (const device of workspace.devices) {
        const node = section(device.name, device.model || 'Modelo disponível após a conexão');
        node.append(statusIndicator(device.online ? (device.busy ? 'Em uso' : 'Disponível') : 'Offline', device.online ? (device.busy ? 'running' : 'connected') : 'idle'));
        if (device.git) node.append(element('p', 'mono', `${device.git.branch} · ${device.git.commit.slice(0, 8)}`));
        nodes.push(node);
      }
      if (!workspace.devices.length) nodes.push(button('Conectar computador', { onClick: () => $('openConnection').click() }));
      nodes.push(section('Leitura do projeto', 'O runner atual opera em modo de leitura. Arquivos, diffs, ferramentas e cancelamento ainda não possuem contrato nesta interface.'));
    } else {
      nodes.push(section('Atividade desta conversa', 'Autoria e resultados publicados no histórico compartilhado.'));
      const messages = thread.messages.filter(({ kind }) => ['update', 'agent', 'error'].includes(kind)).slice(-20).reverse();
      for (const entry of messages) {
        const label = entry.kind === 'update' ? `Publicou contexto v${entry.v}` : entry.kind === 'error' ? 'Rodada com erro' : 'Resposta do agente';
        const node = section(person(entry.author), label);
        node.append(element('p', 'mono', new Date(entry.created).toLocaleString('pt-BR'))); nodes.push(node);
      }
      if (!messages.length) nodes.push(section('Sem atividade de agentes', 'As publicações de contexto e respostas aparecerão aqui.'));
    }
    $('contextBody').replaceChildren(...nodes);
  }
  function selectTab(next, focus = false) {
    tab = next;
    tabs.forEach((name, index) => {
      const node = $(tabIds[index]); node.setAttribute('aria-selected', String(name === tab)); node.tabIndex = name === tab ? 0 : -1;
    });
    $('contextBody').setAttribute('aria-labelledby', tabIds[tabs.indexOf(tab)]);
    renderContext();
    if (focus) $(tabIds[tabs.indexOf(tab)]).focus();
  }
  for (const node of document.querySelectorAll('[data-panel-tab]')) {
    node.addEventListener('click', () => selectTab(node.dataset.panelTab));
    node.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      const next = { ArrowRight: (index + 1) % 3, ArrowLeft: (index + 2) % 3, Home: 0, End: 2 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); selectTab(tabs[next], true);
    });
  }

  function renderCommands() {
    const { workspace } = getState();
    if (!workspace) return;
    commands = [
      { label: 'Nova conversa', run: () => $('newThread').click() },
      { label: 'Visão geral do workspace', run: () => setView('overview') },
      { label: 'Abrir Agent Workspace', run: () => setView('workspace') },
      { label: 'Meus computadores', run: () => $('openConnection').click() },
      { label: 'Configurações', run: () => $('openSettings').click() },
      { label: 'Alternar sidebar', run: () => togglePanel('threads') },
      { label: 'Alternar painel de detalhes', run: () => togglePanel('context') },
      ...(workspace.chatgpt?.available ? [{ label: 'Conectar ou gerenciar ChatGPT', run: () => $('openChatGPT').click() }] : []),
      ...(workspace.user.role === 'owner' ? [{ label: 'Convidar colega', run: () => $('invite').click() }] : []),
      ...workspace.threads.map(({ id, title }) => ({ label: `Conversa: ${title}`, run: () => selectThread(id) })),
    ].filter(({ label }) => matchesSearch(label, $('commandSearch').value));
    $('commandResults').replaceChildren(...commands.map(({ label, run }) => button(label, { onClick: () => { $('commandDialog').close(); run(); } })));
    if (!commands.length) $('commandResults').append(element('p', 'muted small', 'Nenhum comando encontrado.'));
  }
  function openCommands() {
    if (!getState().workspace) return;
    $('commandSearch').value = ''; renderCommands(); $('commandDialog').showModal(); $('commandSearch').focus();
  }
  $('commandSearch').addEventListener('input', renderCommands);
  $('commandDialog').addEventListener('keydown', (event) => {
    const items = [...$('commandResults').querySelectorAll('button')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Enter' && document.activeElement === $('commandSearch')) {
      event.preventDefault(); items[0]?.click();
    }
  });
  $('openCommands').addEventListener('click', openCommands);
  $('showOverview').addEventListener('click', () => setView('overview'));
  $('showWorkspace').addEventListener('click', () => setView('workspace'));
  $('panelScrim').addEventListener('click', closeOverlays);
  $('openSettings').addEventListener('click', () => {
    const { workspace } = getState();
    if (!workspace) return;
    $('settingsBody').replaceChildren(
      section('Perfil', `${workspace.user.name} · ${workspace.user.role === 'owner' ? 'Proprietário' : 'Membro'}`),
      section('Projeto do workspace', `${workspace.project}\n${workspace.repository}`),
      section('Membros e permissões', `${workspace.members.length} membros cadastrados. O proprietário pode gerar convites; cada pessoa administra os próprios computadores e provedores.`),
      section('Interface', 'Tema escuro. A visibilidade e a largura dos painéis são salvas neste navegador.'),
      button('Gerenciar computadores e OpenCode', { onClick: () => { $('settingsDialog').close(); $('openConnection').click(); } }),
      ...(workspace.chatgpt?.available ? [button('Gerenciar ChatGPT e modelos', { onClick: () => { $('settingsDialog').close(); $('openChatGPT').click(); } })] : []),
    );
    $('settingsDialog').showModal();
  });
  $('settingsLogout').addEventListener('click', () => $('logout').click());

  function resize(width, persist = false) {
    const maximum = Math.max(260, Math.min(480, innerWidth - ($('shell').classList.contains('hide-threads') ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'))) - 364));
    const next = Math.round(Math.max(260, Math.min(maximum, width)));
    document.documentElement.style.setProperty('--panel-width', `${next}px`);
    $('panelResizer').setAttribute('aria-valuenow', String(next));
    $('panelResizer').setAttribute('aria-valuemax', String(maximum));
    if (persist) { preferences.panelWidth = next; save(); }
  }
  resize(Number.isFinite(preferences.panelWidth) ? preferences.panelWidth : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-width')));
  const divider = $('panelResizer');
  divider.addEventListener('pointerdown', (event) => { if (event.button === 0) { divider.setPointerCapture(event.pointerId); event.preventDefault(); } });
  divider.addEventListener('pointermove', (event) => { if (divider.hasPointerCapture(event.pointerId)) resize(innerWidth - event.clientX); });
  divider.addEventListener('pointerup', (event) => { if (divider.hasPointerCapture(event.pointerId)) { divider.releasePointerCapture(event.pointerId); resize(innerWidth - event.clientX, true); } });
  divider.addEventListener('keydown', (event) => {
    const width = Number(divider.getAttribute('aria-valuenow'));
    const next = { ArrowLeft: width + 16, ArrowRight: width - 16, Home: 260, End: 480 }[event.key];
    if (next !== undefined) { event.preventDefault(); resize(next, true); }
  });
  document.addEventListener('keydown', (event) => {
    if (!getState().workspace) return;
    const dialog = document.querySelector('dialog[open]');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); if (dialog === $('commandDialog')) dialog.close(); else if (!dialog) openCommands();
    } else if (!dialog && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault(); togglePanel('threads');
    } else if (!dialog && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
      event.preventDefault(); $('newThread').click();
    } else if (!dialog && event.key === 'Escape') closeOverlays();
    // Modal-like mobile panels keep keyboard focus inside until Escape or scrim closes them.
    if (!dialog && event.key === 'Tab') {
      const overlay = $('shell').classList.contains('show-context') ? $('contextPanel') : $('shell').classList.contains('show-threads') ? $('projectSidebar') : null;
      if (!overlay) return;
      const focusable = [...overlay.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')].filter((node) => node.getClientRects().length);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  });
  window.addEventListener('offline', () => setConnection('offline'));
  window.addEventListener('online', () => { setConnection('reconnecting'); refresh(); });
  window.addEventListener('resize', () => { closeOverlays(); if (!media(900)) resize(Number(divider.getAttribute('aria-valuenow'))); });
  syncToggles(); setConnection(connection);

  return {
    togglePanel, closeOverlays, setView, setConnection, renderPanel,
    update() { if (view === 'overview') renderOverview(); },
    reset() { overviewKey = undefined; panelKey = undefined; $('searchThreads').value = ''; $('threads').dataset.key = ''; setView('workspace'); setConnection('connecting'); },
  };
}
