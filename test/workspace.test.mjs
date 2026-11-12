import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createRevez } from '../server.mjs';
import { makePrompt } from '../runner.mjs';

test('dois membros compartilham contexto e a rodada recebe a revisão correta', async (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.revez-test-'));
  const database = join(directory, 'revez.sqlite');
  const origin = 'http://127.0.0.1:8789';
  const setupCode = 'codigo-de-configuracao-de-teste';
  let app;
  async function start() {
    app = createRevez({ database, origin, setupCode });
    app.server.listen(8789, '127.0.0.1');
    await once(app.server, 'listening');
  }
  t.after(async () => {
    await app?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true });
    rmdirSync(directory);
  });
  await start();
  const account = (name) => ({ name, email: `${name.toLowerCase()}@example.test`, password: 'uma senha sintética de teste' });
  const cookie = (res) => res.headers.get('set-cookie').split(';')[0];
  async function call(path, { user, body, code, status = 200 } = {}) {
    const response = await fetch(`${origin}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { connection: 'close',
        ...(user && { cookie: user }), ...(code && { authorization: `Bearer ${code}` }),
        ...(body !== undefined && { origin, 'content-type': 'application/json' }),
      }, body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((error) => { throw new Error(`Falha HTTP em ${path}: ${error.cause?.code || error.message}`, { cause: error }); });
    const data = await response.json();
    assert.equal(response.status, status, `${path} → ${JSON.stringify(data)}`);
    return { data, response };
  }
  assert.deepEqual((await call('status')).data, { setupNeeded: true, signedIn: false });
  await call('state', { status: 401 });
  const ana = cookie((await call('setup', { body: { ...account('Ana'), code: setupCode, project: 'Checkout', repository: 'demo/checkout' }, status: 201 })).response);
  const { code: invite } = (await call('invites', { user: ana, body: {}, status: 201 })).data;
  const bruno = cookie((await call('join', { body: { ...account('Bruno'), code: invite }, status: 201 })).response);
  await call('join', { body: { ...account('Outra'), code: invite }, status: 403 });
  await call('invites', { user: bruno, body: {}, status: 403 });
  const state = (await call('state', { user: ana })).data;
  assert.deepEqual(state.members.map((member) => member.name), ['Ana', 'Bruno']);
  const [thread] = state.threads;

  const stream = await fetch(`${origin}/api/events`, { headers: { cookie: bruno } });
  const reader = stream.body.getReader();
  try {
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /event: change/);
    const draft = { threadId: thread.id, decision: 'Use AMBAR-27 para idempotência.', next: 'Valide duas chamadas simultâneas.', ref: 'main @ 38cda40', baseVersion: 0 };
    await call('context', { user: ana, body: draft, status: 201 });
    assert.match(decoder.decode((await reader.read()).value), /event: change/);
    await call('context', { user: bruno, body: draft, status: 409 });
    await call('messages', { user: ana, body: { threadId: thread.id, text: 'Teste a janela de repetição.', audience: 'team' }, status: 201 });
    await call('messages', { user: bruno, body: { threadId: thread.id, text: 'Continue o trabalho.', audience: 'agent' }, status: 409 });
    const { code: brunoRunner } = (await call('pair', { user: bruno, body: {} })).data;
    const { code: anaRunner } = (await call('pair', { user: ana, body: {} })).data;
    const checkout = { model: 'local/test', branch: 'main', commit: '38cda40', checkoutKey: 'a'.repeat(64) };
    const claim = (code) => call('runner/claim', { code, body: checkout });
    await claim(brunoRunner);
    await call('messages', { user: bruno, body: { threadId: thread.id, text: 'Continue o trabalho.', audience: 'agent' }, status: 201 });
    assert.equal((await claim(anaRunner)).data.job, null);
    const { job } = (await claim(brunoRunner)).data;
    assert.equal(job.payload.context.v, 1);
    assert.match(makePrompt(job.payload, checkout), /AMBAR-27/);
    assert.match(makePrompt(job.payload, checkout), /Teste a janela de repetição/);
    await call('context', { user: ana, body: { ...draft, decision: 'Decisão posterior', baseVersion: 1 }, status: 201 });
    const result = { id: job.id, lease: job.lease, ok: true, answer: 'Vou usar AMBAR-27.' };
    await call('runner/result', { code: anaRunner, body: result, status: 409 });
    await call('runner/result', { code: brunoRunner, body: result });
    await call('runner/result', { code: brunoRunner, body: result });
    const view = (await call(`thread?id=${thread.id}`, { user: ana })).data;
    assert.equal(view.revisions[0].v, 2);
    assert.equal(view.messages.filter(({ kind }) => kind === 'agent').length, 1);
    assert.equal(view.messages.at(-1).v, 1);
  } finally { await reader.cancel(); }

  await app.close();
  await start();
  const { data: view } = await call(`thread?id=${thread.id}`, { user: bruno });
  assert.equal(view.messages.at(-1).text, 'Vou usar AMBAR-27.');
  const [first] = (await call('state', { user: bruno })).data.devices;
  const { code: laptopCode, id: laptop } = (await call('pair', { user: bruno, body: { name: 'Notebook' } })).data;
  const firstCheckout = { model: 'local/test', branch: 'main', commit: '38cda40', checkoutKey: 'a'.repeat(64) };
  const secondCheckout = { ...firstCheckout, branch: 'feature', commit: '16fa9cc', checkoutKey: 'b'.repeat(64) };
  const { code: desktopCode, id: desktop } = (await call('pair', { user: bruno, body: { name: 'Desktop' } })).data;
  await call('devices/revoke', { user: bruno, body: { deviceId: first.id } });
  const poll = (code, body, status = 200) => call('runner/claim', { code, body, status });
  const send = (deviceId, text, status = 201, extra = {}) => call('messages', { user: bruno, status,
    body: { threadId: thread.id, text, audience: 'agent', deviceId, ...extra } });
  await poll(desktopCode, firstCheckout);
  await poll(laptopCode, secondCheckout);
  await poll(laptopCode, firstCheckout, 409);
  const devices = (await call('state', { user: bruno })).data.devices;
  assert.deepEqual(devices.map(({ name, online, git }) => [name, online, git.branch]), [['Notebook', true, 'feature'], ['Desktop', true, 'main']]);
  assert.deepEqual(Object.keys(devices[0]).sort(), ['busy', 'git', 'id', 'model', 'name', 'online']);
  assert.ok(!(await call('state', { user: ana })).data.devices.some(({ id }) => id === laptop));
  await call('devices/revoke', { user: ana, body: { deviceId: laptop }, status: 404 });
  await call('messages', { user: ana, body: { threadId: thread.id, text: 'Outro dono', audience: 'agent', deviceId: laptop }, status: 409 });
  await send(undefined, 'Sem destino', 409);
  await send(desktop, 'Destino antigo', 409, { checkout: { branch: 'main', commit: '0' }, deviceModel: firstCheckout.model });

  const desktopJob = (await send(desktop, 'Execute no desktop')).data.jobId;
  assert.equal((await poll(laptopCode, secondCheckout)).data.job, null);
  const laptopJob = (await send(laptop, 'Execute no notebook')).data.jobId;
  await send(laptop, 'Notebook ocupado', 409);
  const [laptopClaim, desktopClaim] = await Promise.all([poll(laptopCode, secondCheckout), poll(desktopCode, firstCheckout)]);
  assert.equal(laptopClaim.data.job.id, laptopJob);
  assert.equal(desktopClaim.data.job.id, desktopJob);
  assert.deepEqual(laptopClaim.data.job.checkout, { branch: 'feature', commit: '16fa9cc' });
  const result = ({ id, lease }, answer) => ({ id, lease, ok: true, answer });
  const laptopResult = result(laptopClaim.data.job, 'Resposta do notebook');
  await call('runner/result', { code: desktopCode, body: laptopResult, status: 409 });
  await call('devices/revoke', { user: bruno, body: { deviceId: desktop } });
  await poll(desktopCode, firstCheckout, 401);
  await call('runner/result', { code: desktopCode, body: result(desktopClaim.data.job, 'Resposta revogada'), status: 401 });
  await call('runner/result', { code: laptopCode, body: laptopResult });
  await call('runner/result', { code: laptopCode, body: laptopResult });
  await send(laptop, 'A referência deve ser fixa');
  assert.equal((await poll(laptopCode, { ...secondCheckout, commit: 'bbb222' })).data.job, null);
  const { data: finalView } = await call(`thread?id=${thread.id}`, { user: ana });
  assert.deepEqual(finalView.pending, []);
  const latest = finalView.messages.slice(-4);
  assert.match(latest[0].text, /desconectado/);
  assert.equal(latest[0].device, 'Desktop');
  assert.equal(latest[1].text, 'Resposta do notebook');
  assert.deepEqual(latest[1].checkout, { branch: 'feature', commit: '16fa9cc' });
  assert.match(latest[3].text, /revisão Git do computador mudou/);
  await call('logout', { user: bruno, body: {} });
  await call('state', { user: bruno, status: 401 });
  await call('login', { body: account('Bruno') });
});

test('migra o banco anterior e mantém o código, a rodada pendente e o histórico', async (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.revez-test-'));
  const database = join(directory, 'revez.sqlite');
  const origin = 'http://127.0.0.1:8791';
  const cookie = 'f'.repeat(43);
  const code = 'a'.repeat(43);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  let app;
  t.after(async () => {
    await app?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true });
    rmdirSync(directory);
  });
  const old = new DatabaseSync(database);
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, branch TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE runners (user_id TEXT PRIMARY KEY REFERENCES users(id), hash TEXT NOT NULL UNIQUE, last_seen INTEGER, model TEXT, git TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), user_id TEXT NOT NULL REFERENCES users(id),
      payload TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, lease TEXT, deadline INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), author TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL, audience TEXT, text TEXT, v INTEGER, model TEXT, created INTEGER NOT NULL);
    INSERT INTO users VALUES ('ana','ana@example.test','Ana','senha','owner');
    INSERT INTO threads VALUES ('tarefa','Tarefa','main',1);
    INSERT INTO messages VALUES (1,'tarefa','ana','human','team','Histórico anterior',NULL,NULL,1);
  `);
  const now = Date.now();
  const checkout = { branch: 'main', commit: 'abc123' };
  old.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(cookie), 'ana', now + 60_000);
  old.prepare('INSERT INTO runners VALUES (?,?,?,?,?)').run('ana', hash(code), now, 'local/demo', JSON.stringify(checkout));
  old.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run('legada', 'tarefa', 'ana', '{"context":null}', 'local/demo', 'pending', null, now + 60_000, now);
  old.close();
  async function start() {
    app = createRevez({ database, origin });
    app.server.listen(8791, '127.0.0.1');
    await once(app.server, 'listening');
  }
  async function api(path, body, status = 200) {
    const response = await fetch(`${origin}/api/${path}`, { method: body ? 'POST' : 'GET', headers: {
      connection: 'close', cookie: `revez_session=${cookie}`, authorization: `Bearer ${code}`, origin, 'content-type': 'application/json',
    }, body: body && JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  await start();
  const [device] = (await api('state')).devices;
  assert.equal(device.name, 'Agente anterior');
  const presence = { ...checkout, model: 'local/demo' };
  const { job } = await api('runner/claim', presence);
  assert.equal(job.id, 'legada');
  await api('runner/result', { id: job.id, lease: job.lease, ok: true, answer: 'Resposta após atualização' });
  assert.deepEqual((await api('thread?id=tarefa')).messages.map(({ text }) => text), ['Histórico anterior', 'Resposta após atualização']);
  await api('devices/revoke', { deviceId: device.id });
  await app.close();
  await start();
  assert.deepEqual((await api('state')).devices, []);
  await api('runner/claim', presence, 401);
});
