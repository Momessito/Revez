import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRevez } from '../server.mjs';

test('ChatGPT nativo usa a conta vinculada e grava a versão de contexto na rodada', async (t) => {
  const origin = 'http://127.0.0.1:8790';
  const issuer = 'https://auth.openai.com';
  const clientId = 'oaiapp_revez_fixture';
  const access = 'access-token-sintetico';
  const refresh = 'refresh-token-sintetico';
  const granted = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let authorization;
  let exchangeCount = 0;
  let modelRequests = 0;
  let revoked = false;
  let noPlan = false;
  let badNonce = false;
  const fetcher = async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      exchangeCount++;
      const form = options.body;
      assert.equal(url, `${issuer}/api/accounts/oauth/token`);
      assert.equal(form.get('resource'), 'https://api.openai.com/v1');
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('redirect_uri'), `${origin}/auth/callback`);
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
      const token = [
        { alg: 'RS256', kid: 'fixture' },
        { iss: issuer, aud: [clientId], sub: 'verified-subject', email: 'plano@example.test', exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: badNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce') },
      ].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
      const id_token = `${token}.${sign('RSA-SHA256', Buffer.from(token), privateKey).toString('base64url')}`;
      return Response.json({ token_type: 'Bearer', id_token, access_token: access, refresh_token: refresh, expires_in: 3600, scope: noPlan ? 'openid email' : granted });
    }
    if (url === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture' }] });
    if (url === 'https://api.openai.com/v1/models') {
      modelRequests++;
      assert.equal(options.headers.authorization, `Bearer ${access}`);
      return Response.json({ models: [{ slug: 'modelo-demo', display_name: 'Modelo de teste', visibility: 'list' }, { slug: 'interno', display_name: 'Interno', visibility: 'hidden' }] });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      assert.equal(options.headers.authorization, `Bearer ${access}`);
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'modelo-demo');
      assert.equal(payload.stream, true);
      assert.equal(payload.store, false);
      const input = JSON.parse(payload.input[0].content);
      assert.equal(input.contextoPublicado.v, 1);
      assert.equal(input.contextoPublicado.decision, 'Adotar AMBAR-27.');
      assert.equal(input.historicoDaEquipe[0].text, 'Histórico da Ana.');
      return new Response('data: {"type":"response.output_text.delta","delta":"Vou usar AMBAR-27."}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n');
    }
    if (url === `${issuer}/api/accounts/oauth/revoke`) {
      assert.equal(options.body.get('token'), refresh);
      revoked = true;
      return new Response();
    }
    throw new Error('Unexpected provider URL');
  };
  const setupCode = 'configuracao-de-teste';
  const app = createRevez({ origin, chatgptFetch: fetcher, setupCode });
  t.after(() => app.close());
  app.server.listen(8790, '127.0.0.1');
  await once(app.server, 'listening');
  function send(path, body, cookie, redirect = 'manual') {
    return fetch(`${origin}${path}`, { redirect, method: body === undefined ? 'GET' : 'POST', headers: {
      ...(cookie ? { cookie } : {}), ...(body !== undefined ? { origin, 'content-type': 'application/json' } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const account = (name) => ({ name, email: `${name.toLowerCase()}@example.test`, password: 'uma senha longa de teste' });
  const setup = await send('/api/setup', { ...account('Ana'), project: 'Checkout', repository: 'demo/checkout', code: setupCode });
  const ana = setup.headers.get('set-cookie').split(';')[0];
  const invite = await (await send('/api/invites', {}, ana)).json();
  const join = await send('/api/join', { ...account('Bruno'), code: invite.code });
  const bruno = join.headers.get('set-cookie').split(';')[0];
  const state = async (cookie) => (await send('/api/state', undefined, cookie)).json();
  const [thread] = (await state(ana)).threads;
  await send('/api/messages', { threadId: thread.id, audience: 'team', text: 'Histórico da Ana.' }, ana);
  await send('/api/context', { threadId: thread.id, baseVersion: 0, decision: 'Adotar AMBAR-27.', next: 'Testar.', ref: 'main' }, ana);
  assert.equal((await send('/api/chatgpt/connect', {})).status, 401);
  async function begin(options = {}) {
    const start = await send('/api/chatgpt/connect', options, bruno);
    assert.equal(start.status, 200);
    authorization = new URL((await start.json()).url);
    assert.equal(authorization.origin, issuer);
    assert.equal(authorization.searchParams.get('redirect_uri'), `${origin}/auth/callback`);
    const raw = start.headers.get('set-cookie');
    assert.match(raw, /HttpOnly; SameSite=Lax/);
    return raw.split(';')[0];
  }
  const finish = (cookie) => send(`/auth/callback?${new URLSearchParams({ code: 'codigo-de-teste', client_id: clientId, state: authorization.searchParams.get('state') })}`, undefined, cookie);
  const first = await begin();
  const hostId = authorization.searchParams.get('ext_agent_host_id');
  assert.match(hostId, /^urn:uuid:/);
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal((await finish(ana)).headers.get('location'), '/?chatgpt=expired');
  assert.equal(exchangeCount, 0);
  badNonce = true;
  assert.equal((await finish(first)).headers.get('location'), '/?chatgpt=failed');
  badNonce = false;
  const second = await begin();
  assert.equal(authorization.searchParams.get('client_id'), clientId);
  assert.equal(authorization.searchParams.get('ext_agent_host_id'), hostId);
  noPlan = true;
  assert.equal((await finish(second)).headers.get('location'), '/?chatgpt=scope');
  assert.equal((await state(bruno)).chatgpt.connected, false);
  noPlan = false;
  const third = await begin({ consent: true });
  assert.equal(authorization.searchParams.get('prompt'), 'consent');
  assert.equal((await finish(third)).headers.get('location'), '/?chatgpt=connected');
  assert.equal((await finish(third)).headers.get('location'), '/?chatgpt=expired');
  const before = await state(bruno);
  assert.deepEqual(before.chatgpt, { available: true, connected: true, email: 'plano@example.test' });
  assert.ok(!JSON.stringify(before).includes(access));
  assert.equal((await state(ana)).chatgpt.connected, false);
  const models = await (await send('/api/chatgpt/models', undefined, bruno)).json();
  assert.deepEqual(models.models, [{ id: 'modelo-demo', label: 'Modelo de teste' }]);
  const device = await (await send('/api/pair', { name: 'Notebook' }, bruno)).json();
  const poll = () => fetch(`${origin}/api/runner/claim`, { method: 'POST', headers: {
    authorization: `Bearer ${device.code}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ model: 'local/test', branch: 'main', commit: 'abc123', checkoutKey: 'c'.repeat(64) }) });
  assert.equal((await poll()).status, 200);
  const local = await send('/api/messages', { threadId: thread.id, audience: 'agent', deviceId: device.id, text: 'Rodada local' }, bruno);
  assert.equal(local.status, 201);
  assert.equal((await send('/api/messages', { threadId: thread.id, audience: 'chatgpt', model: 'interno', text: 'Continue' }, bruno)).status, 400);
  assert.equal((await send('/api/messages', { threadId: thread.id, audience: 'chatgpt', model: 'modelo-demo', text: 'Continue' }, bruno)).status, 201);
  let reply;
  for (let i = 0; i < 20; i++) {
    const conversation = await (await send(`/api/thread?id=${thread.id}`, undefined, ana)).json();
    reply = conversation.messages.find(({ kind }) => kind === 'agent');
    if (reply) break;
    await delay(20);
  }
  assert.equal(reply?.text, 'Vou usar AMBAR-27.');
  assert.equal(reply.model, 'chatgpt/modelo-demo');
  assert.equal(reply.v, 1);
  assert.equal((await (await poll()).json()).job.id, (await local.json()).jobId);
  assert.equal(modelRequests, 1);
  assert.deepEqual(await (await send('/api/chatgpt/disconnect', {}, bruno)).json(), { revoked: true });
  assert.ok(revoked);
  assert.equal((await state(bruno)).chatgpt.connected, false);
});
