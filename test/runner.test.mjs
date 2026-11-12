import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runOpenCode } from '../runner.mjs';

test('preserva o plugin de autenticação integrado para modelos OpenAI', async (t) => {
  const root = mkdtempSync(join(process.cwd(), '.revez-test-'));
  const executable = join(root, 'run');
  t.after(() => { rmSync(executable, { force: true }); rmdirSync(root); });
  writeFileSync(executable, `
    const text = JSON.stringify({
      pure: process.argv.includes('--pure'),
      disableDefaultPlugins: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS || null,
    });
    console.log(JSON.stringify({ type: 'text', part: { text } }));
  `);
  const payload = { title: 'Teste', repository: 'demo/revez', branch: 'main', recent: [], text: 'Teste' };
  const checkout = { root, branch: 'main', commit: 'abc123' };
  const launch = async (model) => JSON.parse(await runOpenCode({ cli: process.execPath, model, checkout, payload }));
  assert.deepEqual(await launch('openai/test-model'), { pure: true, disableDefaultPlugins: null });
  assert.deepEqual(await launch('ollama-local/test-model'), { pure: true, disableDefaultPlugins: '1' });
});
