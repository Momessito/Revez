import { api } from './lib/api.js';
import { element, emptyState, markdown } from './components/ui.js';
import { createWorkspaceUI } from './components/workspace.js';
import { createDrafts, filterThreads } from './lib/workspace-state.js';
const drafts = createDrafts();
let workspaceUI;
const $ = (id) => document.getElementById(id);
let gateMode = 'login';
let workspace;
let thread;
let activeId = sessionStorage.getItem('revez.thread');
let events;
let refreshPending = false;
let refreshing;
let feedKey;
let toastTimer;
let sending = false;
let authGeneration = 0;
let chatgptModels;
let catalogLoading;
let catalogError;
let askForPlanConsent = false;
function toast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4800);
}

function showGate(mode) {
  gateMode = mode;
  $('gate').hidden = false;
  $('shell').hidden = true;
  $('accountForm').hidden = false;
  $('switchGate').hidden = mode === 'setup';
  const labels = {
    setup: ['Criar workspace', 'Use o código de configuração exibido no terminal do Revez.', 'Código de configuração', 'Criar workspace', ''],
    login: ['Entrar no workspace', 'Use o e-mail e a senha da sua conta no Revez.', '', 'Entrar', 'Tenho um convite'],
    join: ['Aceitar convite', 'Informe o código que você recebeu e crie sua conta.', 'Código de convite', 'Aceitar convite', 'Já tenho uma conta'],
  };
  const [title, help, code, submit, toggle] = labels[mode];
  $('gateTitle').textContent = title;
  $('gateHelp').textContent = help;
  $('gateHelp').classList.remove('error-text');
  $('codeLabel').textContent = code;
  $('accountSubmit').textContent = submit;
  $('switchGate').textContent = toggle;
  $('accountForm').elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  for (const label of $('accountForm').querySelectorAll('[data-for]')) {
    const visible = label.dataset.for.split(' ').includes(mode);
    label.hidden = !visible;
    label.querySelector('input').disabled = !visible;
    label.querySelector('input').required = visible;
  }
}

function signOutLocally() {
  authGeneration += 1;
  events?.close();
  events = undefined;
  workspace = undefined;
  thread = undefined;
  feedKey = undefined;
  chatgptModels = undefined;
  catalogError = undefined;
  askForPlanConsent = false;
  drafts.clear();
  workspaceUI.reset();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('prompt').value = '';
  $('recipient').value = 'team';
  $('deviceSelect').value = '';
  showGate('login');
}

async function enter() {
  const { setupNeeded, signedIn } = await api('status');
  if (!signedIn) return showGate(setupNeeded ? 'setup' : 'login');
  $('gate').hidden = true;
  $('shell').hidden = false;
  await refresh();
  if (!workspace) return;
  const url = new URL(location.href);
  const result = url.searchParams.get('chatgpt');
  if (result) {
    askForPlanConsent = result === 'scope' || result === 'declined';
    url.searchParams.delete('chatgpt');
    history.replaceState(null, '', url);
    if (result === 'connected' && workspace.chatgpt?.connected) {
      $('recipient').value = 'chatgpt';
      renderComposer();
      void loadChatGPTModels();
      toast('Conta ChatGPT conectada.');
    } else {
      const message = {
        declined: 'A autorização foi cancelada.', expired: 'A autorização expirou. Inicie a conexão novamente.',
        scope: 'O uso do plano não foi autorizado. Confira as permissões no ChatGPT.', retry: 'O código do ChatGPT expirou. Inicie a conexão novamente.',
        wrong_account: 'Selecione a conta vinculada ou escolha Usar outra conta.',
      }[result] || 'A conexão com o ChatGPT não foi concluída.';
      openChatGPTDialog(message);
    }
  }
  if (!events) {
    events = new EventSource('/api/events');
    events.addEventListener('open', () => workspaceUI.setConnection('connected'));
    events.addEventListener('change', () => refresh().catch(showError));
    events.addEventListener('error', () => workspaceUI.setConnection('reconnecting'));
    workspaceUI.setConnection('connecting');
  }
}

function refresh() {
  refreshPending = true;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    while (refreshPending) {
      refreshPending = false;
      const generation = authGeneration;
      const data = await api('state');
      if (generation !== authGeneration) continue;
      if (!data.threads.some(({ id }) => id === activeId)) {
        drafts.save(activeId, $('prompt').value);
        activeId = data.threads[0]?.id;
        $('prompt').value = drafts.get(activeId);
      }
      const target = activeId;
      const conversation = target ? await api(`thread?id=${encodeURIComponent(target)}`) : { id: null, title: 'Comece uma conversa', branch: '', messages: [], revisions: [], pending: [] };
      if (activeId !== target || generation !== authGeneration) continue;
      workspace = data;
      thread = conversation;
      render();
      $('syncError').hidden = true;
      $('feed').setAttribute('aria-busy', 'false');
    }
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}

function showError(error) {
  if (error.status === 401) signOutLocally();
  if (!$('shell').hidden) {
    $('syncErrorText').textContent = error.message;
    $('syncError').hidden = false;
    $('feed').setAttribute('aria-busy', 'false');
  }
  toast(error.message);
}

const member = (id) => workspace.members.find((person) => person.id === id);
const name = (id) => member(id)?.name || 'Equipe';
const shortName = (id) => name(id).split(' ')[0];
const selectedDevice = () => workspace.devices.find(({ id }) => id === $('deviceSelect').value);
const shortCheckout = ({ branch, commit }) => `${branch} · ${commit.slice(0, 8)}`;
const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
function avatar(id, agent = false) {
  const initials = name(id).split(/\s+/u).slice(0, 2).map((word) => [...word][0]).join('').toUpperCase();
  const other = workspace.members.findIndex((entry) => entry.id === id) % 2 === 1;
  const icon = element('span', `avatar${agent ? ' agent' : other ? ' bruno' : ''}`, agent ? '✧' : initials);
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function describe(context) {
  return `Contexto v${context.v} · ${name(context.author)}\n\nDecisão\n${context.decision}\n\nPróximo passo\n${context.next}\n\nReferência Git\n${context.ref}`;
}

function message(entry) {
  const time = clock.format(entry.created);
  if (entry.kind === 'update') {
    const row = element('div', 'activity');
    row.append(element('span', 'dot'), element('span', '', `${shortName(entry.author)} publicou o contexto v${entry.v} · ${time}`));
    return row;
  }
  const isAgent = entry.kind === 'agent' || entry.kind === 'error';
  const article = element('article', 'message');
  const body = element('div', 'message-body');
  const meta = element('div', 'message-meta');
  meta.append(element('strong', '', isAgent ? `Agente de ${shortName(entry.author)}` : name(entry.author)), element('time', '', time));
  if (entry.model) meta.append(element('span', 'pill', `${entry.model}${entry.v ? ` · v${entry.v}` : ''}`));
  else if (entry.audience === 'agent') meta.append(element('span', 'sub', 'Agente local'));
  else if (entry.audience === 'chatgpt') meta.append(element('span', 'sub', 'ChatGPT'));
  if (entry.device) {
    const target = element('span', 'sub target-ref', [entry.device, entry.checkout && shortCheckout(entry.checkout)].filter(Boolean).join(' · '));
    if (entry.checkout) target.title = `${entry.checkout.branch} @ ${entry.checkout.commit}`;
    meta.append(target);
  }
  const content = markdown(entry.text);
  if (entry.kind === 'error') content.classList.add('error-text');
  body.append(meta, content);
  const used = isAgent && thread.revisions.find(({ v }) => v === entry.v);
  if (used) {
    const details = element('details');
    details.append(element('summary', '', `Ver contexto v${used.v} usado`), element('pre', '', describe(used)));
    body.append(details);
  }
  article.append(avatar(entry.author, isAgent), body);
  return article;
}

function renderFeed() {
  const key = JSON.stringify([thread.id, thread.messages, thread.pending, thread.revisions]);
  if (key === feedKey) return;
  const feed = $('feed');
  const scroll = $('messages').dataset.thread !== String(thread.id) || feed.scrollHeight - feed.clientHeight - feed.scrollTop < 48;
  $('messages').dataset.thread = thread.id;
  feedKey = key;
  const children = thread.messages.length
    ? [element('div', 'divider', 'Histórico compartilhado'), ...thread.messages.map(message)]
    : [emptyState('O próximo passo começa aqui.', 'Converse com a equipe ou escolha seu agente para trabalhar com o contexto compartilhado do projeto.')];
  for (const { author, status, device } of thread.pending) {
    const pending = element('div', 'activity pending');
    const label = device ? `${device} · ${shortName(author)}` : `Agente de ${shortName(author)}`;
    pending.append(element('span', 'dot'), element('span', '', `${label} ${status === 'running' ? 'está trabalhando…' : 'receberá a rodada em instantes…'}`));
    children.push(pending);
  }
  $('messages').replaceChildren(...children);
  if (scroll) feed.scrollTop = feed.scrollHeight;
}

function renderContext() { workspaceUI.renderPanel(renderSharedContext); }

function renderSharedContext() {
  const revision = thread.revisions[0];
  const status = element('div', 'state row');
  status.append(element('span', 'dot'), element('span', '', revision ? 'Disponível para os agentes' : 'Publique a primeira versão'), element('span', 'spacer'));
  const children = [status];
  if (revision) {
    status.append(element('span', 'pill version', `v${revision.v}`));
    for (const [label, value] of [['Decisão', revision.decision], ['Próximo passo', revision.next], ['Referência Git', revision.ref]]) {
      const section = element('section', 'context-group');
      section.append(element('h3', 'eyebrow', label), element(label === 'Referência Git' ? 'code' : 'p', '', value));
      children.push(section);
    }
    const history = element('section', 'context-group');
    const list = element('div', 'history');
    for (const row of thread.revisions) {
      const item = element('div', 'history-item');
      const info = element('div', '', name(row.author));
      info.append(element('small', '', row.ref));
      item.append(element('span', 'mono', `v${row.v}`), info);
      list.append(item);
    }
    history.append(element('h3', 'eyebrow', 'Histórico de versões'), list);
    children.push(history);
  }
  const own = $('recipient').value === 'agent' && selectedDevice();
  if (own?.git) {
    const checkout = element('section', 'context-group');
    checkout.append(element('h3', 'eyebrow', 'Clone do destino'), element('p', '', own.name), element('p', 'mono', shortCheckout(own.git)));
    children.push(checkout);
  }
  $('contextBody').replaceChildren(...children);
}

function renderDeviceSelect() {
  const select = $('deviceSelect');
  const { devices } = workspace;
  const options = devices.map(({ id, name, online }) => [id, online ? name : `${name} (offline)`]);
  const key = JSON.stringify(options);
  if (select.dataset.key !== key) {
    const previous = select.value;
    const placeholder = element('option', '', 'Escolha o computador');
    placeholder.value = '';
    placeholder.disabled = true;
    select.replaceChildren(placeholder, ...options.map(([id, label]) => {
      const option = element('option', '', label);
      option.value = id;
      return option;
    }));
    select.value = devices.some(({ id }) => id === previous) ? previous : '';
    select.dataset.key = key;
  }
  const online = devices.filter((device) => device.online);
  if (!select.value && (online.length === 1 || devices.length === 1)) select.value = (online[0] || devices[0]).id;
}

function renderComposer() {
  if (!workspace || !thread) { $('send').disabled = true; return; }
  const recipient = $('recipient').value;
  const agent = recipient === 'agent';
  const native = recipient === 'chatgpt';
  renderDeviceSelect();
  const own = selectedDevice();
  const connected = workspace.chatgpt?.connected;
  const rev = thread.revisions[0];
  $('deviceSelect').hidden = !agent || !workspace.devices.length;
  $('activeProvider').hidden = !agent || !own?.model;
  $('activeProvider').textContent = own?.model || '';
  $('chatgptModel').hidden = !native || !connected || !chatgptModels?.length;
  $('prompt').placeholder = native ? 'Peça ao ChatGPT para continuar…' : agent ? 'Peça ao seu agente para continuar…' : 'Escreva para a equipe…';
  let status = rev ? `Contexto v${rev.v} na próxima rodada` : 'Nenhum contexto publicado nesta conversa';
  if (native) {
    if (!connected) status = 'Conecte sua conta ChatGPT para enviar';
    else if (catalogError) status = catalogError;
    else if (!chatgptModels) status = 'Carregando modelos do seu plano…';
    else if (!chatgptModels.length) status = 'O ChatGPT não disponibilizou modelos para esta conta';
    else status = `Usando seu plano ChatGPT · ${status}`;
  } else if (agent && !workspace.devices.length) status = 'Pareie um computador para enviar';
  else if (agent && !own) status = 'Escolha em qual computador rodar';
  else if (agent && !own.online) status = 'Inicie o agente neste computador para enviar';
  else if (agent && own.busy) status = 'Este computador está ocupado com outra rodada';
  else if (agent && own.git) status = `${shortCheckout(own.git)} · ${status}`;
  else if (!agent) status = 'Mensagem visível para a equipe';
  $('composeStatus').textContent = status;
  $('retryModels').hidden = !native || !catalogError;
  $('send').textContent = sending ? '…' : '↑';
  $('composer').setAttribute('aria-busy', String(sending));
  $('send').disabled = sending || !thread?.id || thread.id !== activeId || (agent && (!own?.online || own.busy)) || (native && (!connected || !chatgptModels?.length));
}

function render() {
  $('project').textContent = workspace.project;
  $('topProject').textContent = workspace.project;
  $('repository').textContent = workspace.repository;
  $('identity').textContent = workspace.user.name;
  $('invite').hidden = workspace.user.role !== 'owner';
  $('taskTitle').textContent = thread.title;
  $('branch').textContent = thread.branch;
  const online = workspace.devices.filter((device) => device.online).length;
  $('openConnection').textContent = online ? `● Meus computadores (${online})` : '◇ Meus computadores';
  $('openChatGPT').hidden = !workspace.chatgpt?.available;
  $('nativeRecipient').hidden = !workspace.chatgpt?.available;
  $('openChatGPT').textContent = workspace.chatgpt?.connected ? '● ChatGPT conectado' : 'Conectar ChatGPT';
  if (!workspace.chatgpt?.connected) { chatgptModels = undefined; catalogError = undefined; }
  const membersKey = JSON.stringify(workspace.members);
  if ($('members').dataset.key !== membersKey) {
    $('members').dataset.key = membersKey;
    $('members').replaceChildren(...workspace.members.map((person) => {
      const badge = avatar(person.id);
      badge.title = person.name;
      badge.removeAttribute('aria-hidden');
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', person.name);
      return badge;
    }));
  }
  renderThreads();
  workspaceUI.update();
  renderFeed();
  renderComposer();
  renderContext();
  if ($('connectionDialog').open) renderDevices();
  if ($('recipient').value === 'chatgpt') void loadChatGPTModels();
}

function renderThreads() {
  const rows = filterThreads(workspace.threads, $('searchThreads').value);
  const key = JSON.stringify([rows, activeId]);
  if ($('threads').dataset.key === key) return;
  $('threads').dataset.key = key;
  $('threads').replaceChildren(...rows.map((row) => {
    const button = element('button', 'thread');
    button.setAttribute('aria-current', String(row.id === activeId));
    const icon = element('span', 'thread-icon', '▤');
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, element('span', 'thread-name', row.title));
    button.addEventListener('click', () => selectThread(row.id));
    return button;
  }));
  if (!rows.length) $('threads').append(element('p', 'small muted', 'Nenhuma conversa encontrada.'));
}

function togglePanel(name, value) { workspaceUI.togglePanel(name, value); }

async function selectThread(id) {
  if (activeId !== id) {
    drafts.save(activeId, $('prompt').value);
    activeId = id;
    $('prompt').value = drafts.get(id);
    $('taskTitle').textContent = 'Carregando conversa…';
    $('feed').setAttribute('aria-busy', 'true');
    $('messages').replaceChildren(element('div', 'skeleton'));
    feedKey = undefined;
    renderComposer();
  }
  sessionStorage.setItem('revez.thread', id);
  workspaceUI.setView('workspace');
  workspaceUI.closeOverlays();
  return refresh().catch(showError);
}

function bindForm(id, submit) {
  const form = $(id);
  const button = form.querySelector('[type="submit"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    const alert = form.querySelector('.form-error');
    if (alert) alert.hidden = true;
    try { await submit(Object.fromEntries(new FormData(form)), form); }
    catch (error) {
      if (alert) { alert.textContent = error.message; alert.hidden = false; }
      else showError(error);
    } finally { button.disabled = false; }
  });
}

bindForm('accountForm', async (fields, form) => {
  try { await api(gateMode, fields); }
  catch (error) {
    $('gateHelp').textContent = error.message;
    $('gateHelp').classList.add('error-text');
    return;
  }
  form.reset();
  await enter();
});
bindForm('contextForm', async (fields, form) => {
  await api('context', { ...fields, threadId: form.dataset.thread, baseVersion: Number(form.dataset.version) });
  $('contextDialog').close();
  await refresh();
});
bindForm('threadForm', async (fields) => {
  const { id } = await api('threads', fields);
  $('threadDialog').close();
  await selectThread(id);
});

$('switchGate').addEventListener('click', () => showGate(gateMode === 'login' ? 'join' : 'login'));
$('logout').addEventListener('click', async () => { try { await api('logout', {}); signOutLocally(); } catch (error) { showError(error); } });
$('toggleThreads').addEventListener('click', () => togglePanel('threads'));
$('toggleContext').addEventListener('click', () => togglePanel('context'));
$('recipient').addEventListener('change', () => {
  renderComposer();
  renderContext();
  if ($('recipient').value === 'chatgpt') void loadChatGPTModels();
});
$('deviceSelect').addEventListener('change', () => { renderComposer(); renderContext(); });
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
$('newThread').addEventListener('click', () => {
  $('threadForm').reset();
  $('threadForm').querySelector('.form-error').hidden = true;
  $('threadDialog').showModal();
});
$('editContext').addEventListener('click', () => {
  if (!thread?.id) return;
  const form = $('contextForm');
  const latest = thread.revisions[0];
  form.dataset.thread = thread.id;
  form.dataset.version = latest?.v ?? 0;
  for (const field of ['decision', 'next', 'ref']) form.elements[field].value = latest?.[field] || (field === 'ref' ? thread.branch : '');
  form.querySelector('.form-error').hidden = true;
  $('contextDialog').showModal();
});

function showCode(title, help, code) {
  $('codeTitle').textContent = title;
  $('codeHelp').textContent = help;
  $('shareCode').value = code;
  $('copyCode').textContent = 'Copiar';
  $('codeDialog').showModal();
}

async function issueCode(button, path, title, help) {
  button.disabled = true;
  try {
    const { code } = await api(path, {});
    if ($('connectionDialog').open) $('connectionDialog').close();
    showCode(title, help, code);
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
}

$('invite').addEventListener('click', () => issueCode($('invite'), 'invites', 'Convidar colega', 'Compartilhe o endereço do workspace e este código. Ele expira em uma hora e vale para uma conta.'));
function renderDevices() {
  if (!workspace) return;
  const list = $('deviceList');
  const key = JSON.stringify(workspace.devices);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(...(workspace.devices.length ? workspace.devices.map((device) => {
    const row = element('div', 'device-row');
    const info = element('div', 'device-info');
    const state = device.online ? (device.busy ? 'Em uso' : 'Conectado') : device.git ? 'Offline' : 'Aguardando conexão';
    info.append(element('strong', '', device.name), element('small', 'muted', [state, device.model, device.git && shortCheckout(device.git)].filter(Boolean).join(' · ')));
    const revoke = element('button', 'button quiet', 'Revogar');
    revoke.type = 'button';
    revoke.setAttribute('aria-label', `Revogar ${device.name}`);
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      $('connectionError').hidden = true;
      try { await api('devices/revoke', { deviceId: device.id }); await refresh(); }
      catch (error) { $('connectionError').textContent = error.message; $('connectionError').hidden = false; }
      finally { revoke.disabled = false; }
    });
    row.append(info, revoke);
    return row;
  }) : [element('p', 'muted', 'Nenhum computador pareado ainda.')]));
}
$('openConnection').addEventListener('click', () => {
  if (!workspace) return;
  $('connectionError').hidden = true;
  renderDevices();
  $('connectionDialog').showModal();
});
bindForm('connectionForm', async (fields, form) => {
  const { code } = await api('pair', fields);
  form.reset();
  $('connectionDialog').close();
  showCode('Código do computador', 'No computador escolhido, use este código como REVEZ_RUNNER_TOKEN e inicie o runner no clone do projeto conforme o README.', code);
  void refresh().catch(showError);
});

async function loadChatGPTModels(retry = false) {
  if (!workspace?.chatgpt?.connected || catalogLoading || (!retry && (chatgptModels || catalogError))) return;
  const generation = authGeneration;
  const select = $('chatgptModel');
  const previous = select.value || sessionStorage.getItem('revez.chatgptModel');
  catalogError = undefined;
  catalogLoading = true;
  try {
    const { models } = await api('chatgpt/models');
    if (generation !== authGeneration || !workspace?.chatgpt?.connected) return;
    chatgptModels = models;
    select.replaceChildren(...models.map(({ id, label }) => Object.assign(element('option', '', label), { value: id })));
    if (models.some(({ id }) => id === previous)) select.value = previous;
  } catch (error) {
    if (generation === authGeneration) catalogError = error.message;
  } finally {
    catalogLoading = false;
    if (generation === authGeneration && workspace) renderComposer();
  }
}

function openChatGPTDialog(message = '') {
  const connection = workspace.chatgpt;
  $('chatgptHelp').textContent = connection.connected
    ? (connection.email ? `Usando o plano de ${connection.email}.` : 'Usando seu plano ChatGPT.')
    : 'Autorize o uso do seu plano no ChatGPT. A cada rodada, seu pedido e o contexto compartilhado da conversa serão enviados ao modelo.';
  $('connectChatGPT').hidden = Boolean(connection.connected);
  $('disconnectChatGPT').hidden = !connection.connected;
  $('switchChatGPT').hidden = !connection.connected && !message;
  $('chatgptUsage').hidden = !connection.connected;
  $('chatgptError').textContent = message;
  $('chatgptError').hidden = !message;
  if (!$('chatgptDialog').open) $('chatgptDialog').showModal();
  if (connection.connected) void loadChatGPTModels(true);
}

async function connectChatGPT(button, fresh = false) {
  button.disabled = true;
  try {
    const { url } = await api('chatgpt/connect', { fresh, consent: askForPlanConsent });
    location.assign(url);
  } catch (error) { openChatGPTDialog(error.message); }
  finally { button.disabled = false; }
}

$('chatgptModel').addEventListener('change', () => sessionStorage.setItem('revez.chatgptModel', $('chatgptModel').value));
$('retryModels').addEventListener('click', () => loadChatGPTModels(true));
$('openChatGPT').addEventListener('click', () => openChatGPTDialog());
$('connectChatGPT').addEventListener('click', () => connectChatGPT($('connectChatGPT')));
$('switchChatGPT').addEventListener('click', () => connectChatGPT($('switchChatGPT'), true));
$('disconnectChatGPT').addEventListener('click', async () => {
  $('disconnectChatGPT').disabled = true;
  try {
    const { revoked } = await api('chatgpt/disconnect', {});
    $('chatgptDialog').close();
    await refresh();
    toast(revoked ? 'ChatGPT desconectado.' : 'ChatGPT desconectado aqui. Confirme a revogação nas configurações do ChatGPT.');
  } catch (error) { openChatGPTDialog(error.message); }
  finally { $('disconnectChatGPT').disabled = false; }
});
$('copyCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('shareCode').value); $('copyCode').textContent = 'Copiado'; }
  catch { $('shareCode').select(); }
});
$('codeDialog').addEventListener('close', () => { $('shareCode').value = ''; });

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || $('send').disabled) return;
  const text = $('prompt').value;
  if (!text.trim()) return;
  const threadId = thread.id;
  const audience = $('recipient').value;
  const device = audience === 'agent' ? selectedDevice() : null;
  sending = true;
  renderComposer();
  try {
    await api('messages', { text, threadId, audience, model: $('chatgptModel').value,
      ...(device && { deviceId: device.id, checkout: device.git, deviceModel: device.model }) });
    if (activeId === threadId && $('prompt').value === text) { $('prompt').value = ''; drafts.save(threadId, ''); }
    else if (drafts.get(threadId) === text) drafts.save(threadId, '');
    await refresh();
  } catch (error) { showError(error); if (error.status === 409) void refresh().catch(showError); }
  finally { sending = false; if (workspace) renderComposer(); }
});
$('prompt').addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('composer').requestSubmit(); }
});
workspaceUI = createWorkspaceUI({ getState: () => ({ workspace, thread }), selectThread, refresh: () => refresh().catch(showError), renderContext });
$('searchThreads').addEventListener('input', () => { if (workspace) renderThreads(); });
$('prompt').addEventListener('input', () => drafts.save(activeId, $('prompt').value));
$('retrySync').addEventListener('click', () => enter().catch(showError));
async function boot() {
  $('retryGate').hidden = true;
  try { await enter(); }
  catch (error) {
    if (!$('shell').hidden) showError(error);
    else { $('gateHelp').textContent = error.message; $('gateHelp').classList.add('error-text'); $('retryGate').hidden = false; }
  }
}
$('retryGate').addEventListener('click', boot);
setInterval(() => { if (workspace) refresh().catch(showError); }, 8000);
window.addEventListener('pagehide', () => { events?.close(); events = undefined; });
window.addEventListener('pageshow', (event) => { if (event.persisted && workspace) enter().catch(showError); });
boot();
