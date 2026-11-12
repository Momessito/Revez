import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ChatGPTError, createChatGPT } from './chatgpt.mjs';

const derive = promisify(scrypt);
const token = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const leaseLifetime = 5 * 60 * 1000;
const presenceLifetime = 18_000;
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['inter-latin', 'jetbrains-mono-latin'].map((name) => [`/fonts/${name}.woff2`, [`fonts/${name}.woff2`, 'font/woff2']]),
  ...['tokens', 'globals', 'workspace'].map((name) => [`/styles/${name}.css`, [`styles/${name}.css`, 'text/css; charset=utf-8']]),
  ...['components/ui', 'components/workspace', 'lib/api', 'lib/workspace-state'].map((name) => [`/${name}.js`, [`${name}.js`, 'text/javascript; charset=utf-8']]),
].map(([path, [file, mime]]) => [path, { data: readFileSync(new URL(`./public/${file}`, import.meta.url)), mime }]));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function field(value, max, label, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new HttpError(400, `${label}: informe entre ${min} e ${max} caracteres.`);
  }
  return value.trim();
}

function credentials(data) {
  const email = field(data.email, 254, 'E-mail').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  const password = data.password;
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new HttpError(400, 'A senha deve ter entre 12 e 128 caracteres.');
  }
  return { email, password };
}

async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt, 32);
  return `${salt}:${key.toString('hex')}`;
}

function sameDigest(first, second) {
  return timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
}

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Envie um objeto JSON.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 96_000) { req.resume(); throw new HttpError(413, 'Conteúdo acima do limite.'); }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* Treat malformed input as a client error. */ }
  throw new HttpError(400, 'Objeto JSON inválido.');
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function cookieToken(req) {
  return req.headers.cookie?.match(/(?:^|;\s*)revez_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
}

function modelId(value) {
  const model = field(value, 140, 'Modelo');
  if (!/^[\w.-]+\/[\w.:/-]+$/.test(model)) throw new HttpError(400, 'Use o formato provedor/modelo.');
  return model;
}

export function createRevez({ database = ':memory:', origin = 'http://127.0.0.1:8788', setupCode = token(), chatgptFetch } = {}) {
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chatgpt_links (
      user_id TEXT PRIMARY KEY REFERENCES users(id), client_id TEXT NOT NULL, subject TEXT, email TEXT
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      hash TEXT UNIQUE, last_seen INTEGER, model TEXT, git TEXT, checkout_key TEXT, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, branch TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (
      thread_id TEXT NOT NULL REFERENCES threads(id), v INTEGER NOT NULL, author TEXT NOT NULL REFERENCES users(id),
      decision TEXT NOT NULL, next TEXT NOT NULL, ref TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (thread_id,v)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), author TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL, audience TEXT, text TEXT, v INTEGER, model TEXT, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), user_id TEXT NOT NULL REFERENCES users(id),
      payload TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, lease TEXT, deadline INTEGER NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(user_id, status, created);
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);
  `);

  const query = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const setupNeeded = () => !query('SELECT id FROM users LIMIT 1');
  const transactions = (change) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = change(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  transactions(() => {
    const columns = new Set(all('PRAGMA table_info(jobs)').map(({ name }) => name));
    if (!columns.has('device_id')) db.exec('ALTER TABLE jobs ADD COLUMN device_id TEXT REFERENCES devices(id)');
    if (!columns.has('checkout')) db.exec('ALTER TABLE jobs ADD COLUMN checkout TEXT');
    if (!all('PRAGMA table_info(messages)').some(({ name }) => name === 'job_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN job_id TEXT REFERENCES jobs(id)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS jobs_device_status ON jobs(device_id,status,created)');
    if (query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='runners'")) {
      db.exec(`
        INSERT INTO devices (id,user_id,name,hash,last_seen,model,git)
          SELECT user_id,user_id,'Agente anterior',hash,last_seen,model,git FROM runners;
        UPDATE jobs SET device_id=user_id
          WHERE model NOT LIKE 'chatgpt/%' AND user_id IN (SELECT user_id FROM runners);
        DROP TABLE runners;
      `);
    }
  });
  const secure = new URL(origin).protocol === 'https:';
  const clients = new Map();
  const attempts = new Map();
  const nativeJobs = new Map();
  let closing = false;
  const nativeEnabled = /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
  if (nativeEnabled) run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'chatgptHostId', `urn:uuid:${randomUUID()}`);
  const chatgpt = nativeEnabled ? createChatGPT({
    origin, fetcher: chatgptFetch,
    hostId: query('SELECT value FROM meta WHERE key=?', 'chatgptHostId').value,
    getLink: (id) => query('SELECT client_id AS clientId,subject,email FROM chatgpt_links WHERE user_id=?', id),
    saveLink: (id, link) => run('INSERT OR REPLACE INTO chatgpt_links VALUES (?,?,?,?)', id, link.clientId, link.subject, link.email),
    validSession: (id, hash) => Boolean(query('SELECT 1 FROM sessions WHERE user_id=? AND hash=? AND expires>?', id, hash, Date.now())),
  }) : null;

  function limitAuth(req) {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.expires <= now) attempts.delete(key);
    const key = req.socket.remoteAddress;
    const entry = attempts.get(key) || { count: 0, expires: now + 60_000 };
    if (++entry.count > 20) throw new HttpError(429, 'Muitas tentativas. Tente em um minuto.');
    attempts.set(key, entry);
  }

  function notify() {
    for (const res of clients.keys()) res.write('event: change\ndata: 1\n\n');
  }

  function session(req) {
    const value = cookieToken(req);
    if (!value) return;
    return query('SELECT u.id,u.name,u.email,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?', digest(value), Date.now());
  }

  function setCookie(res, value, seconds) {
    res.setHeader('set-cookie', `revez_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure ? '; Secure' : ''}`);
  }

  function signIn(res, userId) {
    const value = token();
    const now = Date.now();
    run('DELETE FROM sessions WHERE expires<=?', now);
    run('INSERT INTO sessions VALUES (?,?,?)', digest(value), userId, now + sessionLifetime);
    setCookie(res, value, sessionLifetime / 1000);
  }

  function ensureThread(id) {
    const thread = query('SELECT id,title,branch FROM threads WHERE id=?', id);
    if (!thread) throw new HttpError(404, 'Conversa não encontrada.');
    return thread;
  }

  function latest(threadId) {
    return query('SELECT v,author,decision,next,ref FROM revisions WHERE thread_id=? ORDER BY v DESC LIMIT 1', threadId) || null;
  }

  function addMessage(thread, author, kind, { audience = null, text = null, v = null, model = null, jobId = null } = {}) {
    run('INSERT INTO messages (thread_id,author,kind,audience,text,v,model,created,job_id) VALUES (?,?,?,?,?,?,?,?,?)', thread, author, kind, audience, text, v, model, Date.now(), jobId);
  }

  function failJob(job, text) {
    const context = JSON.parse(job.payload).context;
    run('UPDATE jobs SET status=?,lease=NULL,payload=? WHERE id=?', 'failed', '{}', job.id);
    addMessage(job.thread_id, job.user_id, 'error', { text, v: context?.v, model: job.model, jobId: job.id });
  }

  function finishJob(job, answer, error) {
    const context = JSON.parse(job.payload).context;
    run('UPDATE jobs SET status=?,payload=? WHERE id=?', answer ? 'done' : 'failed', '{}', job.id);
    addMessage(job.thread_id, job.user_id, answer ? 'agent' : 'error', { text: answer || error, v: context?.v, model: job.model, jobId: job.id });
  }

  async function runChatGPTJob(id, userId, model, payload) {
    const controller = new AbortController();
    nativeJobs.set(userId, controller);
    let answer;
    let error;
    try { answer = await chatgpt.answer(userId, model, payload, controller.signal); }
    catch (failure) {
      error = controller.signal.aborted ? 'Conexão com o ChatGPT encerrada.' : failure instanceof ChatGPTError ? failure.message : 'O ChatGPT não concluiu a rodada.';
    } finally { if (nativeJobs.get(userId) === controller) nativeJobs.delete(userId); }
    if (closing) return;
    transactions(() => {
      const job = query("SELECT * FROM jobs WHERE id=? AND status='running'", id);
      if (job) finishJob(job, answer, error);
    });
    notify();
  }

  // A process restart ends native requests whose tokens were held in memory.
  transactions(() => all("SELECT * FROM jobs WHERE status='running' AND device_id IS NULL AND model LIKE 'chatgpt/%'")
    .forEach((job) => failJob(job, 'O Revez foi reiniciado. Reconecte o ChatGPT e envie novamente.')));

  function expireJobs() {
    const expired = all("SELECT * FROM jobs WHERE status IN ('pending','running') AND deadline<=?", Date.now());
    if (expired.length) {
      transactions(() => expired.forEach((job) => failJob(job, !job.device_id && job.model.startsWith('chatgpt/')
        ? 'A rodada do ChatGPT expirou. Envie novamente.' : 'A rodada expirou. Verifique o agente local e envie novamente.')));
      notify();
    }
  }

  function devicesFor(userId) {
    return all(`SELECT d.id,d.name,d.model,d.last_seen,d.git,EXISTS(SELECT 1 FROM jobs j
      WHERE j.device_id=d.id AND j.status IN ('pending','running')) AS busy
      FROM devices d WHERE d.user_id=? AND d.revoked_at IS NULL ORDER BY d.rowid`, userId).map((device) => ({
      id: device.id, name: device.name, model: device.model, online: (device.last_seen || 0) > Date.now() - presenceLifetime,
      git: device.git ? JSON.parse(device.git) : null, busy: Boolean(device.busy),
    }));
  }

  async function account(req, res, path) {
    limitAuth(req);
    const data = await body(req);
    const { email, password } = credentials(data);
    if (path === '/api/login') {
      const user = query('SELECT id,password FROM users WHERE email=?', email);
      const [salt, expected] = user?.password.split(':') || ['0'.repeat(32), '0'.repeat(64)];
      const [, candidate] = (await passwordHash(password, salt)).split(':');
      if (!sameDigest(candidate, expected) || !user) throw new HttpError(401, 'E-mail ou senha incorretos.');
      signIn(res, user.id);
      return json(res, { ok: true });
    }
    const first = path === '/api/setup';
    const name = field(data.name, 60, 'Nome');
    const code = field(data.code, 128, 'Código');
    const project = first ? field(data.project, 80, 'Projeto') : '';
    const repository = first ? field(data.repository, 150, 'Repositório') : '';
    const hash = await passwordHash(password);
    const id = randomUUID();
    transactions(() => {
      if (first && (!setupNeeded() || !sameDigest(digest(code), digest(setupCode)))) {
        throw new HttpError(403, 'Código de configuração inválido ou já utilizado.');
      }
      if (!first && !run('DELETE FROM invites WHERE hash=? AND expires>?', digest(code), Date.now()).changes) {
        throw new HttpError(403, 'Convite inválido, expirado ou já utilizado.');
      }
      if (query('SELECT id FROM users WHERE email=?', email)) throw new HttpError(409, 'Já existe uma conta com esse e-mail.');
      run('INSERT INTO users VALUES (?,?,?,?,?)', id, email, name, hash, first ? 'owner' : 'member');
      if (first) {
        run('INSERT INTO meta VALUES (?,?),(?,?)', 'project', project, 'repository', repository);
        run('INSERT INTO threads VALUES (?,?,?,?)', randomUUID(), 'Planejamento do projeto', field(data.branch || 'main', 100, 'Branch'), Date.now());
      }
    });
    signIn(res, id);
    notify();
    return json(res, { ok: true }, 201);
  }

  async function agent(req, res, path) {
    const data = await body(req);
    const auth = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const runner = auth && query('SELECT * FROM devices WHERE hash=? AND revoked_at IS NULL', digest(auth));
    if (!runner) throw new HttpError(401, 'Código do agente inválido ou revogado.');
    if (path === '/api/runner/claim') {
      const model = modelId(data.model);
      const checkout = { branch: field(data.branch, 100, 'Branch'), commit: field(data.commit, 64, 'Commit') };
      const git = JSON.stringify(checkout);
      const key = data.checkoutKey ?? null;
      if (key === null ? runner.id !== runner.user_id : typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
        throw new HttpError(400, 'Atualize o runner para conectar este dispositivo.');
      }
      if (runner.checkout_key && key !== runner.checkout_key) throw new HttpError(409, 'Este código está vinculado a outro clone. Gere um novo código para este clone.');
      expireJobs();
      const wasOnline = (runner.last_seen || 0) > Date.now() - presenceLifetime;
      run('UPDATE devices SET last_seen=?,model=?,git=?,checkout_key=COALESCE(checkout_key,?) WHERE id=?', Date.now(), model, git, key, runner.id);
      if (!wasOnline || runner.model !== model || runner.git !== git) notify();
      if (data.busy === true) return json(res, { job: null });
      let rejected = false;
      const job = transactions(() => {
        const pending = query("SELECT * FROM jobs WHERE device_id=? AND status='pending' ORDER BY created LIMIT 1", runner.id);
        if (!pending) return null;
        if (pending.model !== model || (pending.checkout && pending.checkout !== git)) {
          failJob(pending, 'O modelo ou a revisão Git do computador mudou. Confira o destino e envie novamente.');
          rejected = true;
          return null;
        }
        const lease = token();
        run("UPDATE jobs SET status='running',lease=?,deadline=?,checkout=? WHERE id=?", digest(lease), Date.now() + leaseLifetime, git, pending.id);
        return { id: pending.id, lease, payload: JSON.parse(pending.payload), checkout };
      });
      if (job || rejected) notify();
      return json(res, { job });
    }
    if (path === '/api/runner/result') {
      const id = field(data.id, 50, 'Rodada');
      const lease = field(data.lease, 80, 'Autorização da rodada');
      const answer = data.ok === true ? field(data.answer, 48_000, 'Resposta') : null;
      const error = data.ok === true ? null : field(data.error, 180, 'Falha do agente');
      transactions(() => {
        const job = query('SELECT * FROM jobs WHERE id=? AND device_id=?', id, runner.id);
        if (!job || !job.lease || !sameDigest(job.lease, digest(lease))) throw new HttpError(409, 'Rodada indisponível.');
        if (job.status === 'done' || job.status === 'failed') return;
        if (job.status !== 'running' || job.deadline < Date.now()) throw new HttpError(409, 'Rodada expirada.');
        finishJob(job, answer, error);
      });
      notify();
      return json(res, { ok: true });
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }

  const routes = {
    'GET /api/state': (req, res, user) => {
      expireJobs();
      const meta = Object.fromEntries(all("SELECT key,value FROM meta WHERE key IN ('project','repository')").map(({ key, value }) => [key, value]));
      const threads = all('SELECT id,title,branch FROM threads ORDER BY created DESC,rowid DESC');
      const members = all('SELECT id,name FROM users ORDER BY rowid');
      return json(res, { user, ...meta, members, devices: devicesFor(user.id), threads, chatgpt: { available: nativeEnabled, ...chatgpt?.status(user.id) } });
    },
    'POST /api/chatgpt/connect': async (req, res, user) => {
      const data = await body(req);
      const { url, cookie } = chatgpt.start(user.id, digest(cookieToken(req)), { fresh: data.fresh === true, consent: data.consent === true });
      res.setHeader('set-cookie', cookie);
      return json(res, { url });
    },
    'GET /api/chatgpt/models': async (req, res, user) => json(res, { models: await chatgpt.models(user.id) }),
    'POST /api/chatgpt/disconnect': async (req, res, user) => {
      nativeJobs.get(user.id)?.abort();
      const revoked = await chatgpt.disconnect(user.id);
      notify();
      return json(res, { revoked });
    },
    'GET /api/thread': (req, res, user, url) => {
      expireJobs();
      const thread = ensureThread(url.searchParams.get('id'));
      const revisions = all('SELECT v,author,decision,next,ref,created FROM revisions WHERE thread_id=? ORDER BY v DESC', thread.id);
      const messages = all(`SELECT m.id,m.author,m.kind,m.audience,m.text,m.v,m.model,m.created,d.name AS device,j.checkout
        FROM (SELECT * FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 150) m
        LEFT JOIN jobs j ON j.id=m.job_id LEFT JOIN devices d ON d.id=j.device_id ORDER BY m.id`, thread.id)
        .map((message) => ({ ...message, checkout: message.checkout ? JSON.parse(message.checkout) : null }));
      const pending = all(`SELECT j.user_id AS author,j.status,d.name AS device FROM jobs j LEFT JOIN devices d ON d.id=j.device_id
        WHERE j.thread_id=? AND j.status IN ('pending','running') ORDER BY j.created`, thread.id);
      return json(res, { ...thread, revisions, messages, pending });
    },
    'GET /api/events': (req, res) => {
      if (clients.size >= 100) throw new HttpError(503, 'Limite de conexões do piloto atingido.');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no', 'connection': 'keep-alive' });
      res.write('event: change\ndata: 1\n\n');
      clients.set(res, cookieToken(req));
      res.on('close', () => clients.delete(res));
    },
    'POST /api/logout': (req, res) => {
      const value = cookieToken(req);
      run('DELETE FROM sessions WHERE hash=?', digest(value));
      for (const [stream, current] of clients) if (current === value) stream.end();
      setCookie(res, '', 0);
      return json(res, { ok: true });
    },
    'POST /api/invites': (req, res, user) => {
      if (user.role !== 'owner') throw new HttpError(403, 'Somente quem criou o workspace pode gerar convites.');
      const code = token();
      const expires = Date.now() + 60 * 60 * 1000;
      run('DELETE FROM invites WHERE expires<=?', Date.now());
      run('INSERT INTO invites VALUES (?,?)', digest(code), expires);
      return json(res, { code, expires }, 201);
    },
    'POST /api/pair': async (req, res, user) => {
      const data = await body(req);
      const name = field(data.name ?? 'Meu computador', 60, 'Nome do computador');
      const id = randomUUID();
      const code = token();
      run('INSERT INTO devices (id,user_id,name,hash) VALUES (?,?,?,?)', id, user.id, name, digest(code));
      notify();
      return json(res, { id, code });
    },
    'POST /api/devices/revoke': async (req, res, user) => {
      const data = await body(req);
      const id = field(data.deviceId, 50, 'Computador');
      transactions(() => {
        const changed = run('UPDATE devices SET revoked_at=?,hash=NULL WHERE id=? AND user_id=? AND revoked_at IS NULL', Date.now(), id, user.id);
        if (!changed.changes) throw new HttpError(404, 'Computador indisponível.');
        all("SELECT * FROM jobs WHERE device_id=? AND status IN ('pending','running')", id)
          .forEach((job) => failJob(job, 'O computador desta rodada foi desconectado. Escolha um destino e envie novamente.'));
      });
      notify();
      return json(res, { ok: true });
    },
    'POST /api/threads': async (req, res) => {
      const data = await body(req);
      const id = randomUUID();
      run('INSERT INTO threads VALUES (?,?,?,?)', id, field(data.title, 80, 'Título'), field(data.branch, 100, 'Branch'), Date.now());
      notify();
      return json(res, { id }, 201);
    },
    'POST /api/context': async (req, res, user) => {
      const data = await body(req);
      const thread = ensureThread(field(data.threadId, 50, 'Conversa'));
      const decision = field(data.decision, 1200, 'Decisão');
      const next = field(data.next, 1200, 'Próximo passo');
      const ref = field(data.ref, 160, 'Referência Git');
      const v = transactions(() => {
        const current = latest(thread.id)?.v || 0;
        if (current !== data.baseVersion) throw new HttpError(409, 'O contexto mudou. Reabra o editor para ver a versão atual.');
        const version = current + 1;
        run('INSERT INTO revisions VALUES (?,?,?,?,?,?,?)', thread.id, version, user.id, decision, next, ref, Date.now());
        addMessage(thread.id, user.id, 'update', { v: version });
        return version;
      });
      notify();
      return json(res, { v }, 201);
    },
    'POST /api/messages': async (req, res, user) => {
      const data = await body(req);
      const thread = ensureThread(field(data.threadId, 50, 'Conversa'));
      const text = field(data.text, 4000, 'Mensagem');
      const { audience } = data;
      if (!['team', 'agent', 'chatgpt'].includes(audience)) throw new HttpError(400, 'Destinatário inválido.');
      const native = audience === 'chatgpt';
      let chosen;
      if (native) {
        if (!chatgpt) throw new HttpError(403, 'A conexão nativa do ChatGPT está disponível no Revez local.');
        const catalog = await chatgpt.models(user.id);
        chosen = catalog.find((model) => model.id === data.model)?.id;
        if (!chosen) throw new HttpError(400, 'Selecione um modelo disponível no seu plano.');
      }
      expireJobs();
      let nativePayload;
      const jobId = transactions(() => {
        let id = null;
        if (audience !== 'team') {
          let runner;
          if (!native) {
            const candidates = all(`SELECT id,model,git FROM devices WHERE user_id=? AND revoked_at IS NULL AND model IS NOT NULL
              AND git IS NOT NULL AND last_seen>?`, user.id, Date.now() - presenceLifetime);
            if (data.deviceId == null && candidates.length > 1) throw new HttpError(409, 'Escolha em qual computador rodar.');
            runner = data.deviceId == null ? candidates[0] : candidates.find(({ id }) => id === data.deviceId);
            if (!runner) throw new HttpError(409, 'Escolha um computador seu que esteja conectado.');
            const checkout = JSON.parse(runner.git);
            if (data.checkout && (data.checkout.branch !== checkout.branch || data.checkout.commit !== checkout.commit || data.deviceModel !== runner.model)) {
              throw new HttpError(409, 'O destino mudou. Confira o modelo e a revisão Git antes de enviar.');
            }
          }
          if (native && !chatgpt.status(user.id).connected) throw new HttpError(409, 'Conecte sua conta ChatGPT novamente.');
          const busy = native
            ? query("SELECT id FROM jobs WHERE user_id=? AND device_id IS NULL AND model LIKE 'chatgpt/%' AND status='running'", user.id)
            : query("SELECT id FROM jobs WHERE device_id=? AND status IN ('pending','running')", runner.id);
          if (busy) throw new HttpError(409, native ? 'O ChatGPT já está respondendo a outra rodada.' : 'Este computador já está respondendo a outra rodada.');
          const context = latest(thread.id);
          const recent = all(`SELECT u.name,m.kind,substr(m.text,1,800) AS text FROM messages m JOIN users u ON u.id=m.author
            WHERE m.thread_id=? AND m.kind IN ('human','agent') ORDER BY m.id DESC LIMIT 8`, thread.id).reverse();
          const repository = query("SELECT value FROM meta WHERE key='repository'").value;
          const payload = { title: thread.title, branch: thread.branch, repository, context, recent, text };
          id = randomUUID();
          const now = Date.now();
          if (native) nativePayload = payload;
          run(`INSERT INTO jobs (id,thread_id,user_id,payload,model,status,lease,deadline,created,device_id,checkout)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, thread.id, user.id, JSON.stringify(payload), native ? `chatgpt/${chosen}` : runner.model,
            native ? 'running' : 'pending', null, now + (native ? leaseLifetime : 45_000), now, runner?.id ?? null, runner?.git ?? null);
        }
        addMessage(thread.id, user.id, 'human', { audience, text, jobId: id });
        return id;
      });
      notify();
      if (nativePayload) void runChatGPTJob(jobId, user.id, chosen, nativePayload).catch(() => console.error('Revez: não foi possível gravar a rodada do ChatGPT.'));
      return json(res, { jobId }, 201);
    },
  };

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (path.startsWith('/api/chatgpt/') || path === '/auth/callback') {
        if (!chatgpt || req.headers.host !== new URL(origin).host) throw new HttpError(404, 'Conexão disponível no endereço local do Revez.');
        if (path === '/auth/callback' && req.method === 'GET') {
          const result = await chatgpt.complete(req.headers.cookie, url.searchParams);
          res.setHeader('set-cookie', 'revez_chatgpt=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0');
          res.writeHead(303, { location: `/?chatgpt=${result}` });
          notify();
          return res.end();
        }
      }
      const asset = publicFiles.get(path);
      if (asset && req.method === 'GET') { res.writeHead(200, { 'content-type': asset.mime }); return res.end(asset.data); }
      if (path.startsWith('/api/runner/') && req.method === 'POST') return await agent(req, res, path);
      if (req.method === 'POST' && req.headers.origin !== origin) throw new HttpError(403, 'Origem da requisição inválida.');
      if (path === '/api/status' && req.method === 'GET') return json(res, { setupNeeded: setupNeeded(), signedIn: Boolean(session(req)) });
      if (req.method === 'POST' && ['/api/setup', '/api/join', '/api/login'].includes(path)) return await account(req, res, path);
      const handler = routes[`${req.method} ${path}`];
      if (!handler) throw new HttpError(404, 'Rota não encontrada.');
      const user = session(req);
      if (!user) throw new HttpError(401, 'Entre no workspace para continuar.');
      return await handler(req, res, user, url);
    } catch (error) {
      const known = error instanceof HttpError || error instanceof ChatGPTError;
      if (!known) console.error('Revez:', error.code || error.name);
      const status = error instanceof ChatGPTError && error.status === 401 ? 409 : error.status || 500;
      if (!res.headersSent) json(res, { error: known ? error.message : 'Erro interno do Revez.' }, status);
      else res.end();
    }
  });

  const heartbeat = setInterval(() => {
    for (const [res, sessionToken] of clients) {
      if (query('SELECT hash FROM sessions WHERE hash=? AND expires>?', digest(sessionToken), Date.now())) res.write(': keepalive\n\n');
      else res.end();
    }
    expireJobs();
  }, 12_000);
  heartbeat.unref();
  return { server, setupNeeded, setupCode, close: () => {
    closing = true;
    clearInterval(heartbeat);
    for (const job of nativeJobs.values()) job.abort();
    for (const res of clients.keys()) res.end();
    return new Promise((done) => server.close(() => { db.close(); done(); }));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.REVEZ_PORT || 8788);
  const origin = process.env.REVEZ_ORIGIN || `http://127.0.0.1:${port}`;
  const host = process.env.REVEZ_BIND || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !origin.startsWith('https://')) throw new Error('Use REVEZ_ORIGIN=https://… atrás de um proxy TLS ao disponibilizar para outros dispositivos.');
  const app = createRevez({ database: resolve(process.env.REVEZ_DB || '.data/revez.sqlite'), origin });
  app.server.listen(port, host, () => {
    console.log(`Revez disponível em ${origin}`);
    if (app.setupNeeded()) console.log(`Código de configuração (uso único): ${app.setupCode}`);
  });
  process.once('SIGINT', () => app.close());
  process.once('SIGTERM', () => app.close());
}
