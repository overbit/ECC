import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../../.opencode/v2/index.mjs';

// Run with Bun after npm run build:opencode. This uses real ECC modules and
// schemas, but a fixture host, not a live OpenCode daemon or an LLM provider.
process.env.ECC_HOOK_PROFILE = 'minimal';
process.env.ECC_DISABLED_HOOKS = '';

function host(directory) {
  const hooks = new Map();
  const tools = new Map();
  const register = (name, callback) => {
    hooks.set(name, callback);
    return { dispose: async () => hooks.delete(name) };
  };
  const ctx = {
    location: { directory, project: { canonical: directory } },
    tool: {
      hook: async (name, callback) => register(`tool:${name}`, callback),
      transform: async (callback) => {
        callback({ add: (tool) => tools.set(tool.name, tool) });
        return { dispose: async () => tools.clear() };
      },
    },
    shell: { hook: async (name, callback) => register(`shell:${name}`, callback) },
    session: { hook: async (name, callback) => register(`session:${name}`, callback) },
  };
  return { ctx, hooks, tools };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ecc-v2-runtime-'));
const cleanups = [];
try {
  const firstDir = path.join(root, 'first');
  const secondDir = path.join(root, 'second');
  await fs.mkdir(firstDir);
  await fs.mkdir(secondDir);
  await fs.writeFile(path.join(firstDir, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
  const first = host(firstDir);
  const second = host(secondDir);
  cleanups.push(await plugin.setup(first.ctx));
  cleanups.push(await plugin.setup(second.ctx));
  assert.deepEqual([...first.tools.keys()].sort(), ['changed-files', 'dependency-analyzer']);

  const shell = { cwd: firstDir, command: 'pwd', env: { KEEP: 'yes' } };
  await first.hooks.get('shell:create.before')(shell);
  assert.equal(shell.env.KEEP, 'yes');
  assert.equal(shell.env.ECC_PLUGIN, 'true');
  assert.equal(shell.env.PROJECT_ROOT, firstDir);

  const controller = new AbortController();
  const context = { signal: controller.signal, sessionID: 'smoke', messageID: 'smoke', agent: 'build' };
  await assert.rejects(first.tools.get('changed-files').execute({ format: 'invalid' }, context));
  const input = { filePath: path.join(firstDir, 'example.ts'), content: 'export const answer = 42;\n' };
  await first.hooks.get('tool:execute.before')({ tool: 'write', sessionID: 'smoke', callID: 'write-1', input });
  await fs.writeFile(input.filePath, input.content);
  await first.hooks.get('tool:execute.after')({
    tool: 'write', sessionID: 'smoke', callID: 'write-1', input,
    status: 'completed', result: { content: 'written' },
  });
  const changes = JSON.parse((await first.tools.get('changed-files').execute({ format: 'json' }, context)).content);
  assert.deepEqual(changes.files, [{ path: 'example.ts', changeType: 'added' }]);
  const other = JSON.parse((await second.tools.get('changed-files').execute({ format: 'json' }, context)).content);
  assert.equal(other.changed, false);
  const analysis = JSON.parse((await first.tools.get('dependency-analyzer').execute({}, context)).content);
  assert.equal(analysis.success, true);
  assert.equal(analysis.dependencies[0].name, 'example');

  const compaction = { sessionID: 'smoke', system: [{ type: 'text', text: 'Keep this instruction' }] };
  await first.hooks.get('session:compaction')(compaction);
  assert.equal(compaction.system[0].text, 'Keep this instruction');
  assert.ok(compaction.system.some(({ text }) => text.includes('ECC Context')));
  console.log('Passed: 1 real-payload V2 fixture smoke test');
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await fs.rm(root, { recursive: true, force: true });
}
