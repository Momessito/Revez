import { button, codeBlock, element, emptyState, markdown, statusIndicator } from '../public/components/ui.js';

export default { title: 'Revez/Design System' };
function stack(...nodes) { const node = element('div', 'dialog-content'); node.append(...nodes); return node; }
function label(text, control) { const node = element('label', '', text); node.append(control); return node; }

export const Tokens = { render: () => {
  const list = stack(element('h1', '', 'Revez · Fundação visual'), element('p', 'muted', 'Menta para ação, seleção e foco. Escala de 4px. Fontes locais Inter / Geist e JetBrains Mono, com fallback.'));
  for (const token of ['--bg', '--side', '--surface', '--elevated', '--line', '--green', '--text', '--muted', '--success', '--error', '--warning', '--info']) {
    const row = element('div', 'row'); const swatch = element('span');
    Object.assign(swatch.style, { width: '32px', height: '32px', borderRadius: '4px', background: `var(${token})`, border: '1px solid var(--line)' });
    row.append(swatch, element('code', '', token)); list.append(row);
  }
  return list;
} };
export const Buttons = { render: () => stack(
  element('h2', '', 'Button · variantes, tamanho e estados'),
  button('Iniciar conversa', { variant: 'primary' }), button('Secundário', { variant: '' }), button('Discreto'),
  button('Indisponível', { variant: 'primary', disabled: true }),
  Object.assign(button('Enviando…', { disabled: true }), { ariaBusy: 'true' }),
  button('Compacto', { variant: 'small' }),
  element('p', 'muted small', 'Use Tab para foco e o mouse para hover. Os estados compartilham tokens de foco/hover.')) };
export const Focus = { ...Buttons, play: ({ canvasElement }) => { canvasElement.querySelector('button').focus(); } };
export const Inputs = { render: () => {
  const normal = element('input'); normal.placeholder = 'Nome da conversa';
  const disabled = element('input'); disabled.disabled = true; disabled.value = 'Indisponível';
  const error = element('input'); error.setAttribute('aria-invalid', 'true'); error.setAttribute('aria-describedby', 'storyError');
  const message = element('p', 'form-error', 'Informe um nome para continuar.'); message.id = 'storyError';
  const text = element('textarea'); text.placeholder = 'Próximo passo da equipe';
  const select = element('select'); select.append(element('option', '', 'Equipe'), element('option', '', 'Meu agente local'));
  return stack(label('Input', normal), label('Disabled', disabled), label('Error', error), message, label('Textarea', text), label('Select / Dropdown nativo', select));
} };
export const Status = { render: () => stack(...[
  ['Disponível', 'idle'], ['Em execução', 'running'], ['Aguardando agente', 'waiting'], ['Erro na rodada', 'error'], ['Concluído', 'completed'], ['Reconectando', 'reconnecting'],
].map(([text, state]) => statusIndicator(text, state))) };
export const BadgesAndAvatars = { render: () => stack(element('span', 'pill version', 'Contexto v3'), element('span', 'pill mono', 'feat/workspace'), element('span', 'avatar', 'NT'), element('span', 'avatar bruno', 'AM'), element('span', 'avatar agent', '↬')) };
export const Empty = { render: () => emptyState('Comece uma conversa', 'Reúna a equipe e publique o contexto antes de enviar a primeira rodada.', button('Nova conversa', { variant: 'primary' })) };
export const Loading = { render: () => { const node = stack(element('div', 'skeleton'), element('div', 'skeleton')); node.setAttribute('aria-label', 'Carregando conversa'); node.setAttribute('aria-busy', 'true'); return node; } };
export const Error = { render: () => stack(element('p', 'form-error', 'Não foi possível atualizar a conversa.'), button('Tentar novamente')) };
export const Code = { render: () => codeBlock('const workspace = await loadWorkspace();\nconsole.log(workspace.project);', 'javascript') };
export const Markdown = { render: () => markdown('## Resultado da revisão\n\nA equipe pode usar **contexto versionado** e `branch`.\n\n- Autoria preservada\n- Código legível\n\n> O contexto publicado vale para a próxima rodada.\n\n```js\nconst ready = true;\n```') };
export const Dialog = { render: () => {
  const dialog = element('dialog'); const content = stack(element('h2', '', 'Nova conversa'), label('Título', element('input')), button('Fechar', { onClick: () => dialog.close() }));
  content.firstChild.id = 'storyDialogTitle'; dialog.setAttribute('aria-labelledby', 'storyDialogTitle'); dialog.append(content);
  return stack(button('Abrir Dialog', { onClick: () => dialog.showModal() }), dialog);
} };
export const ToastAndTooltip = { render: () => {
  const control = button('Passe o mouse ou use foco'); control.title = 'Atalho: Ctrl+K';
  const toast = element('div', 'state', 'Contexto publicado.'); toast.setAttribute('role', 'status');
  return stack(control, toast);
} };
export const Tabs = { render: () => {
  const tabs = element('div', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Detalhes');
  const panel = element('div', 'state', 'Contexto compartilhado'); panel.id = 'storyPanel'; panel.setAttribute('role', 'tabpanel');
  const labels = ['Contexto', 'Execução', 'Atividade'];
  const select = (index, focus = false) => {
    [...tabs.children].forEach((node, i) => { node.setAttribute('aria-selected', String(i === index)); node.tabIndex = i === index ? 0 : -1; });
    panel.setAttribute('aria-labelledby', `storyTab${index}`); panel.textContent = labels[index]; if (focus) tabs.children[index].focus();
  };
  labels.forEach((text, index) => {
    const node = button(text, { onClick: () => select(index) }); node.id = `storyTab${index}`; node.setAttribute('role', 'tab'); node.setAttribute('aria-controls', 'storyPanel');
    node.addEventListener('keydown', (event) => { const next = { ArrowRight: (index + 1) % 3, ArrowLeft: (index + 2) % 3, Home: 0, End: 2 }[event.key]; if (next !== undefined) { event.preventDefault(); select(next, true); } }); tabs.append(node);
  }); select(0); return stack(tabs, panel);
} };
