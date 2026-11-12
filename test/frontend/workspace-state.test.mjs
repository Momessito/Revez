import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDrafts, filterThreads, safeLink } from '../../public/lib/workspace-state.js';

test('busca por título ou branch ignora acentos e caixa', () => {
  const rows = [{ id: '1', title: 'Autenticação', branch: 'feat/login' }, { id: '2', title: 'Editor', branch: 'main' }];
  assert.deepEqual(filterThreads(rows, ' AUTENTICACAO '), [rows[0]]);
  assert.deepEqual(filterThreads(rows, 'feat/LOGIN'), [rows[0]]);
  assert.deepEqual(filterThreads(rows, 'ausente'), []);
  assert.equal(filterThreads(rows, '').length, 2);
});
test('rascunhos são isolados por conversa e apagados ao sair', () => {
  const drafts = createDrafts(); drafts.save('a', 'pedido A'); drafts.save('b', 'pedido B');
  assert.equal(drafts.get('a'), 'pedido A'); assert.equal(drafts.get('b'), 'pedido B');
  drafts.save('a', ''); assert.equal(drafts.get('a'), ''); assert.equal(drafts.get('b'), 'pedido B');
  drafts.clear(); assert.equal(drafts.get('b'), '');
});
test('links rejeitam protocolos executáveis, dados e URLs relativas', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///secret', '//example.test', '/api/logout', 'inválido']) assert.equal(safeLink(href), null);
  assert.equal(safeLink('https://example.test/docs'), 'https://example.test/docs');
});
