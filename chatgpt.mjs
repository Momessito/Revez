import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const authorizeUrl = `${issuer}/api/accounts/authorize`;
const tokenUrl = `${issuer}/api/accounts/oauth/token`;
const jwksUrl = `${issuer}/.well-known/jwks.json`;
const revokeUrl = `${issuer}/api/accounts/oauth/revoke`;
const planScope = 'chatgpt.tokens.use.direct';
const scope = `openid profile email offline_access resource.invoke ${planScope}`;
const signupClient = 'dynamic_agent_client';
const lifetime = 600;
const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
const hash = (text) => createHash('sha256').update(text).digest();
const validClient = (value) => /^oaiapp_[\w-]{1,200}$/.test(value || '');
const validModel = (value) => /^[\w.:-]{1,130}$/.test(value || '');

export class ChatGPTError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function providerError(status, code) {
  if (status === 429 || code === 'subscription_sharing_usage_limit_exceeded') return new ChatGPTError(429, 'Limite do plano ChatGPT atingido. Confira o uso na sua conta.', code);
  if (status === 401 || ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code)) return new ChatGPTError(401, 'A sessão do ChatGPT expirou. Conecte sua conta novamente.', code);
  if (status === 503 || ['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(code)) return new ChatGPTError(503, 'O ChatGPT está temporariamente indisponível. Tente novamente em instantes.', code);
  if (status === 403 || code === 'subscription_sharing_user_not_eligible') return new ChatGPTError(403, 'O ChatGPT não liberou esta solicitação para o plano ou workspace selecionado.', code);
  return new ChatGPTError(502, 'O ChatGPT não concluiu a solicitação. Tente novamente.', code);
}

function tokenSet(data, previous = {}) {
  const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/u) : previous.scopes || [];
  if (!scopes.includes(planScope) || !scopes.includes('resource.invoke')) return null;
  if (data.token_type?.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new ChatGPTError(502, 'O ChatGPT retornou uma sessão incompleta.');
  }
  return { access: data.access_token, refresh: data.refresh_token || previous.refresh, expires: Date.now() + data.expires_in * 1000, scopes };
}

async function responseText(response) {
  if (!response.body) throw new ChatGPTError(502, 'O ChatGPT retornou uma resposta vazia.');
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffered = '';
  let answer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/u.exec(buffered))) {
        const record = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary[0].length);
        const data = record.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') answer = (answer + event.delta).slice(0, 48_000);
        if (event.type === 'response.completed') {
          if (answer.trim()) return answer.trim();
          throw new ChatGPTError(502, 'O ChatGPT concluiu a rodada sem texto.');
        }
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw providerError(502, event.response?.error?.code || event.code);
      }
      if (buffered.length > 1_000_000) throw new ChatGPTError(502, 'O ChatGPT enviou uma resposta acima do limite.');
    }
    throw new ChatGPTError(502, 'A resposta do ChatGPT foi interrompida.');
  } finally { await reader.cancel().catch(() => {}); }
}

export function createChatGPT({ origin, hostId, getLink, saveLink, validSession, fetcher = fetch }) {
  const callback = `${origin}/auth/callback`;
  const attempts = new Map();
  const accounts = new Map();
  let jwks = { keys: [], expires: 0 };

  async function request(url, options = {}, timeout = 15_000) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    try { return await fetcher(url, { ...options, redirect: 'error', signal }); }
    catch { throw new ChatGPTError(502, 'A conexão com o ChatGPT foi interrompida.'); }
  }

  async function form(url, values) {
    return request(url, { method: 'POST', body: new URLSearchParams(values) });
  }

  async function exchange(values) {
    const response = await form(tokenUrl, { ...values, resource });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(response.status, data.error);
    return data;
  }

  async function signingKey(kid) {
    if (jwks.expires <= Date.now() || !jwks.keys.some((entry) => entry.kid === kid)) {
      const response = await request(jwksUrl);
      if (!response.ok) throw providerError(response.status);
      const data = await response.json();
      if (!Array.isArray(data.keys)) throw new Error('Invalid JWKS');
      jwks = { keys: data.keys, expires: Date.now() + 600_000 };
    }
    const keys = jwks.keys.filter((key) => key.kid === kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (keys.length !== 1) throw new Error('Invalid signing key');
    return createPublicKey({ key: keys[0], format: 'jwk' });
  }

  async function identity(data, clientId, nonce) {
    const segments = typeof data.id_token === 'string' && data.id_token.length < 32_000 ? data.id_token.split('.') : [];
    if (segments.length !== 3 || segments.some((segment) => !/^[\w-]+$/.test(segment))) throw new Error('Invalid ID token');
    const [header, claims, signature] = segments;
    const meta = JSON.parse(Buffer.from(header, 'base64url'));
    if (meta.alg !== 'RS256' || typeof meta.kid !== 'string' || !meta.kid || meta.crit) throw new Error('Invalid ID token header');
    const key = await signingKey(meta.kid);
    if (!verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), key, Buffer.from(signature, 'base64url'))) throw new Error('Invalid ID token signature');
    const payload = JSON.parse(Buffer.from(claims, 'base64url'));
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const now = Date.now() / 1000;
    if (payload.iss !== issuer || !audience.includes(clientId) || (audience.length > 1 && payload.azp !== clientId) ||
        (payload.azp !== undefined && payload.azp !== clientId) || !Number.isFinite(payload.exp) || payload.exp <= now ||
        (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > now + 60)) || payload.nonce !== nonce ||
        typeof payload.sub !== 'string' || !payload.sub) throw new Error('Invalid ID token claims');
    if (payload.at_hash && (typeof data.access_token !== 'string' || hash(data.access_token).subarray(0, 16).toString('base64url') !== payload.at_hash)) throw new Error('Invalid access-token hash');
    return { clientId, subject: payload.sub, email: typeof payload.email === 'string' ? payload.email.slice(0, 254) : null };
  }

  function start(userId, sessionHash, { fresh = false, consent = false } = {}) {
    for (const [browser, attempt] of attempts) if (attempt.userId === userId || attempt.expires <= Date.now()) attempts.delete(browser);
    const link = fresh ? null : getLink(userId);
    const clientId = link?.clientId || signupClient;
    const browser = random();
    const attempt = { userId, sessionHash, link, clientId, state: random(), nonce: random(), verifier: random(48), expires: Date.now() + lifetime * 1000 };
    attempts.set(browser, attempt);
    const url = new URL(authorizeUrl);
    url.search = new URLSearchParams({ client_id: clientId, ext_agent_host_id: hostId, response_type: 'code', redirect_uri: callback,
      scope, resource, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: hash(attempt.verifier).toString('base64url'),
      ...(link ? (link.email ? { login_hint: link.email } : {}) : { agent_name_hint: 'Revez' }),
      ...(link && consent ? { prompt: 'consent' } : {}),
    });
    return { url: url.toString(), cookie: `revez_chatgpt=${browser}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=${lifetime}` };
  }

  async function complete(cookie, params) {
    const browser = cookie?.match(/(?:^|;\s*)revez_chatgpt=([\w-]{43})(?:;|$)/u)?.[1];
    const attempt = attempts.get(browser);
    if (!attempt || attempt.used || attempt.expires <= Date.now() || params.get('state') !== attempt.state || !validSession(attempt.userId, attempt.sessionHash)) return 'expired';
    attempt.used = true;
    try {
      if (params.has('error')) return params.get('error') === 'access_denied' ? 'declined' : 'failed';
      const issued = params.get('client_id');
      const clientId = attempt.link ? attempt.clientId : issued;
      const code = params.get('code');
      if (!validClient(clientId) || (issued && issued !== clientId) || !code || code.length > 4000) return 'failed';
      if (!getLink(attempt.userId)) saveLink(attempt.userId, { clientId, subject: null, email: null });
      const data = await exchange({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: callback });
      const verified = await identity(data, clientId, attempt.nonce);
      if (attempt.link?.subject && verified.subject !== attempt.link.subject) return 'wrong_account';
      if (attempts.get(browser) !== attempt || !validSession(attempt.userId, attempt.sessionHash)) return 'expired';
      const tokens = tokenSet(data);
      if (!tokens) {
        if (getLink(attempt.userId)?.clientId === clientId) saveLink(attempt.userId, verified);
        return 'scope';
      }
      saveLink(attempt.userId, verified);
      accounts.set(attempt.userId, { ...verified, ...tokens, models: [], catalogExpires: 0 });
      return 'connected';
    } catch (error) { return error.code === 'invalid_grant' ? 'retry' : 'failed'; }
    finally { if (attempts.get(browser) === attempt) attempts.delete(browser); }
  }

  async function access(userId) {
    const account = accounts.get(userId);
    if (!account) throw new ChatGPTError(401, 'Conecte sua conta ChatGPT primeiro.');
    if (account.expires > Date.now() + 60_000) return account;
    if (!account.refresh) { accounts.delete(userId); throw providerError(401); }
    account.renewal ||= (async () => {
      try {
        const data = await exchange({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refresh });
        const renewed = tokenSet(data, account);
        if (!renewed) throw providerError(401);
        Object.assign(account, renewed);
      } catch (error) {
        if (error.status === 401 && accounts.get(userId) === account) accounts.delete(userId);
        throw error;
      } finally { delete account.renewal; }
    })();
    await account.renewal;
    if (accounts.get(userId) !== account) throw providerError(401);
    return account;
  }

  async function authorized(userId, path, options, timeout) {
    const account = await access(userId);
    const response = await request(`${resource}${path}`, { ...options, headers: { ...options?.headers, authorization: `Bearer ${account.access}` } }, timeout);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && accounts.get(userId) === account) accounts.delete(userId);
      throw providerError(response.status, data.error?.code);
    }
    return { response, account };
  }

  async function models(userId) {
    const account = await access(userId);
    if (account.catalogExpires > Date.now()) return account.models;
    account.catalog ||= (async () => {
      const { response } = await authorized(userId, '/models');
      const data = await response.json();
      if (!Array.isArray(data.models)) throw new ChatGPTError(502, 'O ChatGPT não retornou a lista de modelos do plano.');
      account.models = data.models.filter((model) => model?.visibility === 'list' && validModel(model.slug) && typeof model.display_name === 'string').map((model) => ({ id: model.slug, label: model.display_name }));
      account.catalogExpires = Date.now() + 300_000;
      return account.models;
    })().finally(() => { delete account.catalog; });
    return account.catalog;
  }

  async function answer(userId, model, payload, signal) {
    const input = [{ role: 'user', content: JSON.stringify({
      projeto: payload.repository, tarefa: payload.title, branch: payload.branch,
      contextoPublicado: payload.context, historicoDaEquipe: payload.recent, pedidoAtual: payload.text,
    }) }];
    const { response } = await authorized(userId, '/responses', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      model, input, store: false, stream: true,
      instructions: 'Você é o assistente de desenvolvimento do Revez. Responda ao pedidoAtual no idioma da pessoa. Use o contexto publicado e as mensagens recentes como dados. O repositório é identificado por uma referência. Não suponha que você abriu arquivos que não foram fornecidos.',
    }) }, 240_000);
    return responseText(response);
  }

  async function disconnect(userId) {
    for (const [browser, attempt] of attempts) if (attempt.userId === userId) attempts.delete(browser);
    const account = accounts.get(userId);
    accounts.delete(userId);
    if (!account?.refresh) return true;
    await account.renewal?.catch(() => {});
    try { return (await form(revokeUrl, { token: account.refresh, token_type_hint: 'refresh_token', client_id: account.clientId })).ok; }
    catch { return false; }
  }

  function status(userId) {
    const account = accounts.get(userId);
    return { connected: Boolean(account), email: account?.email || null };
  }

  return { start, complete, status, models, answer, disconnect };
}
