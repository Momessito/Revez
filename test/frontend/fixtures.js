import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  app: async ({ page }, use) => {
    const state = {
      user: { id: 'ana', name: 'Ana Martins', role: 'owner' }, project: 'Revez', repository: 'Momessito/Revez',
      members: [{ id: 'ana', name: 'Ana Martins' }, { id: 'natan', name: 'Natan Silva' }],
      devices: [{ id: 'pc', name: 'Notebook', model: 'local/code', online: true, busy: false, git: { branch: 'main', commit: 'abcdef123456' } }],
      threads: [{ id: 'one', title: 'Fundação do workspace', branch: 'feat/workspace' }, { id: 'two', title: 'Autenticação', branch: 'main' }],
      chatgpt: { available: true, connected: false },
    };
    const threads = {
      one: {
        ...state.threads[0],
        revisions: [{ v: 1, author: 'ana', decision: 'Manter o frontend nativo.', next: 'Revisar acessibilidade e navegação.', ref: 'main @ abcdef12', created: 1794500000000 }],
        messages: [
          { id: 1, author: 'ana', kind: 'update', v: 1, created: 1794500000000 },
          { id: 2, author: 'natan', kind: 'human', audience: 'agent', text: 'Revise a navegação e mantenha os contratos atuais.', created: 1794500001000 },
          { id: 3, author: 'natan', kind: 'agent', text: '## Revisão da navegação\n\nVamos preservar **autoria** e `contexto`.\n\n- Busca por conversa\n- Atalhos de teclado\n\n```js\nconst workspace = await loadWorkspace();\n```', model: 'local/code', device: 'Notebook', v: 1, checkout: { branch: 'main', commit: 'abcdef123456' }, created: 1794500002000 },
        ], pending: [],
      },
      two: { ...state.threads[1], messages: [], revisions: [], pending: [] },
    };
    const calls = [];
    const errors = [];
    const controls = { signedIn: true, setupNeeded: false, failState: false, modelError: false, conflict: false, delayThread: null };
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__streams = [];
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.__streams.push(this); setTimeout(() => this.dispatchEvent(new Event('open')), 0); }
        close() { this.closed = true; }
      };
    });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(5);
      const body = route.request().postDataJSON();
      calls.push({ path, body });
      const fulfill = (json, status = 200) => route.fulfill({ json, status });
      if (path === 'status') return fulfill({ signedIn: controls.signedIn, setupNeeded: controls.setupNeeded });
      if (path === 'state') return controls.failState ? fulfill({ error: 'Falha de conexão de teste' }, 503) : fulfill(state);
      if (path === 'thread') {
        const id = url.searchParams.get('id');
        if (controls.delayThread === id) await new Promise((resolve) => setTimeout(resolve, 300));
        return fulfill(threads[id]);
      }
      if (path === 'messages') {
        threads[body.threadId].messages.push({ id: Date.now(), author: 'ana', kind: 'human', audience: body.audience, text: body.text, created: Date.now() });
        return fulfill({ ok: true }, 201);
      }
      if (path === 'threads') {
        const id = `new-${state.threads.length}`;
        state.threads.unshift({ ...body, id }); threads[id] = { ...body, id, messages: [], revisions: [], pending: [] };
        return fulfill({ id }, 201);
      }
      if (path === 'context') {
        if (controls.conflict) return fulfill({ error: 'O contexto mudou. Atualize antes de publicar.' }, 409);
        threads[body.threadId].revisions.unshift({ ...body, v: body.baseVersion + 1, author: 'ana', created: Date.now() });
        return fulfill({ ok: true }, 201);
      }
      if (path === 'chatgpt/models') return controls.modelError ? fulfill({ error: 'Catálogo temporariamente indisponível' }, 503) : fulfill({ models: [{ id: 'test/model', label: 'Modelo de teste' }] });
      if (path === 'invites' || path === 'pair') return fulfill({ code: 'CODIGO-SOMENTE-DE-TESTE' }, 201);
      if (path === 'devices/revoke') { state.devices = state.devices.filter(({ id }) => id !== body.deviceId); return fulfill({ ok: true }); }
      if (path === 'logout') { controls.signedIn = false; return fulfill({ ok: true }); }
      if (['login', 'join', 'setup'].includes(path)) { controls.signedIn = true; return fulfill({ ok: true }); }
      errors.push(`Unexpected API: ${path}`);
      return fulfill({ error: 'Rota não simulada' }, 500);
    });
    const update = () => page.evaluate(() => window.__streams.at(-1).dispatchEvent(new Event('change')));
    await use({ state, threads, calls, controls, update, open: async () => { await page.goto('/'); await expect(page.locator('#taskTitle')).toHaveText(state.threads[0].title); } });
    expect(errors).toEqual([]);
  },
});
export { expect };
