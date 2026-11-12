import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';

test('workspace real: autoria, Markdown seguro, contexto e visão geral', async ({ page, app }) => {
  await app.open();
  await expect(page.locator('.code-block code')).toHaveText('const workspace = await loadWorkspace();');
  await expect(page.getByText('Agente de Natan', { exact: true })).toBeVisible();
  await page.getByText('Ver contexto v1 usado').click();
  await expect(page.locator('.message details pre')).toContainText('Manter o frontend nativo.');
  await page.locator('#showOverview').click();
  await expect(page.locator('#overview')).toContainText('Membros cadastrados');
  await expect(page.locator('#overview')).toContainText('Seus computadores conectados');
  await page.locator('#overview').getByRole('button', { name: /Autenticação/ }).click();
  await expect(page.locator('#taskTitle')).toHaveText('Autenticação');
  await expect(page.getByText('O próximo passo começa aqui.')).toBeVisible();
});

test('busca e troca de conversas preservam rascunhos independentes', async ({ page, app }) => {
  await app.open();
  await page.locator('#prompt').fill('Pedido da primeira conversa');
  await page.getByRole('searchbox', { name: 'Buscar conversas', exact: true }).fill('AUTENTICACAO');
  await expect(page.locator('#threads button')).toHaveCount(1);
  await page.locator('#threads button').click();
  await expect(page.locator('#taskTitle')).toHaveText('Autenticação');
  await page.locator('#prompt').fill('Segundo rascunho');
  await page.locator('#searchThreads').fill('');
  await page.locator('#threads').getByRole('button', { name: 'Fundação do workspace' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Pedido da primeira conversa');
  await page.locator('#threads').getByRole('button', { name: 'Autenticação' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Segundo rascunho');
});

test('SSE mantém digitação e foco e mostra reconexão', async ({ page, app }) => {
  await app.open();
  await page.locator('#prompt').fill('Um rascunho em edição');
  await page.locator('#prompt').evaluate((node) => node.setSelectionRange(3, 8));
  await app.update();
  await expect(page.locator('#prompt')).toBeFocused();
  expect(await page.locator('#prompt').evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([3, 8]);
  await page.evaluate(() => window.__streams.at(-1).dispatchEvent(new Event('error')));
  await expect(page.locator('#syncStatus')).toContainText('Reconectando');
  await page.evaluate(() => window.__streams.at(-1).dispatchEvent(new Event('open')));
  await expect(page.locator('#syncStatus')).toContainText('Atualizações conectadas');
  await page.locator('#threads button').first().focus();
  await app.update();
  await expect(page.locator('#threads button').first()).toBeFocused();
});

test('atalho de envio usa contrato atual e limpa apenas a mensagem enviada', async ({ page, app }) => {
  await app.open();
  await page.locator('#prompt').fill('Continuar a tarefa');
  await page.locator('#prompt').press('Control+Enter');
  await expect(page.locator('#prompt')).toHaveValue('');
  expect(app.calls.find(({ path }) => path === 'messages').body).toMatchObject({ text: 'Continuar a tarefa', threadId: 'one', audience: 'team' });
  await expect(page.locator('#messages')).toContainText('Continuar a tarefa');
});

test('troca rápida bloqueia envio à conversa antiga', async ({ page, app }) => {
  await app.open(); app.controls.delayThread = 'two';
  await page.locator('#threads').getByRole('button', { name: 'Autenticação' }).click();
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#threads').getByRole('button', { name: 'Fundação do workspace' }).click();
  await expect(page.locator('#taskTitle')).toHaveText('Fundação do workspace');
  await expect(page.locator('#feed')).toHaveAttribute('aria-busy', 'false');
});

test('agente offline e execução real aparecem sem presença fictícia de membros', async ({ page, app }) => {
  app.state.devices[0].online = false;
  app.threads.one.pending = [{ author: 'natan', status: 'running', device: 'Computador de Natan' }];
  await app.open();
  await page.locator('#recipient').selectOption('agent');
  await expect(page.locator('#send')).toBeDisabled();
  await page.getByRole('tab', { name: 'Execução', exact: true }).click();
  await expect(page.locator('#contextBody')).toContainText('Iniciada por Natan Silva');
  await expect(page.locator('#contextBody')).toContainText('Offline');
  await expect(page.locator('#members')).not.toContainText('online');
});

test('catálogo ChatGPT permite recuperar erro sem recarregar a página', async ({ page, app }) => {
  app.state.chatgpt.connected = true; app.controls.modelError = true;
  await app.open(); await page.locator('#recipient').selectOption('chatgpt');
  await expect(page.locator('#composeStatus')).toContainText('Catálogo temporariamente indisponível');
  await expect(page.locator('#send')).toBeDisabled();
  app.controls.modelError = false; await page.locator('#retryModels').click();
  await expect(page.locator('#chatgptModel')).toHaveValue('test/model');
  await expect(page.locator('#send')).toBeEnabled();
});

test('paleta por teclado filtra comandos e abre nova conversa', async ({ page, app }) => {
  await app.open(); await page.keyboard.press('Control+k');
  await expect(page.locator('#commandSearch')).toBeFocused();
  await page.locator('#commandSearch').fill('nova conversa');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('#threadDialog')).toBeVisible();
  await page.getByRole('textbox', { name: 'Título', exact: true }).fill('Revisão de código');
  await page.getByRole('button', { name: 'Criar conversa', exact: true }).click();
  await expect(page.locator('#taskTitle')).toHaveText('Revisão de código');
});

test('conflito de contexto mantém edição e permite recuperação', async ({ page, app }) => {
  await app.open(); app.controls.conflict = true;
  await page.locator('#editContext').click();
  await page.getByLabel('Decisão da equipe').fill('Nova decisão');
  await page.getByRole('button', { name: 'Publicar versão' }).click();
  await expect(page.locator('#contextForm .form-error')).toContainText('O contexto mudou');
  await expect(page.getByLabel('Decisão da equipe')).toHaveValue('Nova decisão');
  app.controls.conflict = false;
  await page.getByRole('button', { name: 'Publicar versão' }).click();
  await expect(page.locator('#contextDialog')).not.toBeVisible();
  await expect(page.locator('#contextBody')).toContainText('Nova decisão');
});

test('falha inicial apresenta recuperação e skeleton não fica preso', async ({ page, app }) => {
  app.controls.failState = true; await page.goto('/');
  await expect(page.locator('#syncError')).toContainText('Falha de conexão de teste');
  app.controls.failState = false; await page.locator('#retrySync').click();
  await expect(page.locator('#taskTitle')).toHaveText('Fundação do workspace');
  await expect(page.locator('#syncError')).not.toBeVisible();
});

test('HTML e URLs executáveis de mensagens nunca são interpretados', async ({ page, app }) => {
  app.threads.one.messages[2].text = '<img src=x onerror="window.PWNED=1">\n\n[Executar](javascript:alert(1))\n\n[Docs](https://example.test/docs)';
  await app.open();
  await expect(page.locator('#messages img')).toHaveCount(0);
  await expect(page.locator('#messages a')).toHaveCount(1);
  await expect(page.locator('#messages a')).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.evaluate(() => window.PWNED)).toBeUndefined();
});

test('painéis recolhem, redimensionam pelo teclado e persistem preferências', async ({ page, app }) => {
  await app.open();
  const divider = page.getByRole('separator', { name: 'Largura do painel' });
  await divider.focus(); await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '328');
  await page.keyboard.press('Control+b');
  await expect(page.locator('#projectSidebar')).not.toBeVisible();
  await page.locator('#toggleContext').click();
  await expect(page.locator('#contextPanel')).not.toBeVisible();
  await page.reload(); await expect(page.locator('#taskTitle')).toHaveText('Fundação do workspace');
  await expect(page.locator('#projectSidebar')).not.toBeVisible();
  await expect(page.locator('#contextPanel')).not.toBeVisible();
  await page.locator('#toggleContext').click();
  await expect(divider).toHaveAttribute('aria-valuenow', '328');
});

test('tabs usam setas e exposição ARIA consistente', async ({ page, app }) => {
  await app.open(); await page.getByRole('tab', { name: 'Contexto', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Execução', exact: true })).toBeFocused();
  await expect(page.locator('#contextBody')).toHaveAttribute('aria-labelledby', 'tabExecution');
  await page.keyboard.press('End');
  await expect(page.locator('#contextBody')).toContainText('Resposta do agente');
});

test('logout limpa rascunhos e encerra stream', async ({ page, app }) => {
  await app.open(); await page.locator('#prompt').fill('Rascunho privado');
  await page.locator('#openSettings').click(); await page.locator('#settingsLogout').click();
  await expect(page.locator('#gate')).toBeVisible();
  expect(await page.evaluate(() => window.__streams.at(-1).closed)).toBe(true);
  await page.getByLabel('E-mail', { exact: true }).fill('teste@example.test');
  await page.getByLabel('Senha', { exact: true }).fill('senha de teste longa');
  await page.locator('#accountSubmit').click();
  await expect(page.locator('#shell')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('');
});

test('convite usa fluxo existente e respeita papel do membro', async ({ page, app }) => {
  await app.open(); await page.locator('#invite').click();
  await expect(page.locator('#shareCode')).toHaveValue('CODIGO-SOMENTE-DE-TESTE');
  await page.locator('#codeDialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(page.locator('#shareCode')).toHaveValue('');
  app.state.user.role = 'member'; await app.update();
  await expect(page.locator('#invite')).not.toBeVisible();
});

test('mobile não transborda e overlays fecham por Escape com foco restaurado', async ({ page, app }) => {
  await page.setViewportSize({ width: 375, height: 812 }); await app.open();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#toggleThreads').click();
  await expect(page.locator('#searchThreads')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#toggleThreads')).toBeFocused();
  await expect(page.locator('#projectSidebar')).not.toBeVisible();
  await page.locator('#toggleContext').click();
  await expect(page.locator('#contextPanel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#toggleContext')).toBeFocused();
});

test('acessibilidade automática AA no workspace, modal e mobile', async ({ page, app }) => {
  await app.open();
  const scan = () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect((await scan()).violations).toEqual([]);
  await page.locator('#newThread').click(); expect((await scan()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 812 }); expect((await scan()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 }); await page.screenshot({ path: 'test-results/workspace-desktop.png', fullPage: true });
});

test('histórico longo só acompanha o final quando a pessoa já está no final', async ({ page, app }) => {
  app.threads.one.messages = Array.from({ length: 150 }, (_, index) => ({ id: index, author: 'ana', kind: 'human', text: `Mensagem ${index}\n${'Conteúdo da equipe. '.repeat(12)}`, created: 1794500000000 + index }));
  await app.open();
  await page.locator('#feed').evaluate((node) => { node.scrollTop = 240; });
  app.threads.one.messages.push({ id: 151, author: 'natan', kind: 'human', text: 'Nova atualização', created: Date.now() });
  await app.update();
  await expect(page.locator('#messages')).toContainText('Nova atualização');
  expect(await page.locator('#feed').evaluate((node) => node.scrollTop)).toBe(240);
  await page.locator('#feed').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  app.threads.one.messages.push({ id: 152, author: 'ana', kind: 'human', text: 'Segunda atualização', created: Date.now() });
  await app.update();
  await expect(page.locator('#messages')).toContainText('Segunda atualização');
  expect(await page.locator('#feed').evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
});

test('gate alterna login e convite sem exibir campos de criação no login', async ({ page, app }) => {
  app.controls.signedIn = false; await page.goto('/');
  await expect(page.locator('#gateTitle')).toHaveText('Entrar no workspace');
  await expect(page.getByLabel('Nome', { exact: true })).not.toBeVisible();
  await page.locator('#switchGate').click();
  await expect(page.getByLabel('Código de convite', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Nome do projeto', { exact: true })).not.toBeVisible();
  await page.locator('#switchGate').click();
  await expect(page.locator('#gateTitle')).toHaveText('Entrar no workspace');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
});

test('tablet e desktop compacto mantêm composer e navegação utilizáveis', async ({ page, app }) => {
  await app.open();
  for (const width of [320, 600, 768, 900, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#send')).toBeInViewport();
    await expect(page.locator('#prompt')).toBeInViewport();
  }
});

test('voltar pelo cache do navegador reabre o stream encerrado', async ({ page, app }) => {
  await app.open();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(await page.evaluate(() => window.__streams.at(-1).closed)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => page.evaluate(() => window.__streams.length)).toBe(2);
  await expect(page.locator('#syncStatus')).toContainText('Atualizações conectadas');
});
