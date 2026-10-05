const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const adapterURL = pathToFileURL(path.resolve(__dirname, '../../.opencode/v2/adapter.mjs'));
const entryURL = pathToFileURL(path.resolve(__dirname, '../../.opencode/v2/index.mjs'));

async function fixture(hooks = {}, tools = []) {
  const { createV2Plugin } = await import(adapterURL.href);
  const registered = new Map();
  const disposed = [];
  const messages = [];
  let transform;
  let loadCount = 0;
  const ctx = {
    location: { directory: path.resolve('/project/worktree'), project: { canonical: '/project/main' } },
    tool: {
      hook: async (name, callback) => register(`tool:${name}`, callback),
      transform: async (callback) => { transform = callback; return register('tools', callback); },
    },
    shell: { hook: async (name, callback) => register(`shell:${name}`, callback) },
    session: { hook: async (name, callback) => register(`session:${name}`, callback) },
  };
  function register(name, callback) {
    registered.set(name, callback);
    return { dispose: async () => { disposed.push(name); registered.delete(name); } };
  }
  const load = async (directory) => {
    loadCount++;
    assert.equal(directory, ctx.location.directory);
    return { hooks, tools };
  };
  const plugin = createV2Plugin(load, (level, message) => messages.push({ level, message }));
  return {
    ctx, plugin, registered, disposed, messages,
    loadCount: () => loadCount,
    tools: () => { const definitions = []; transform({ add: (tool) => definitions.push(tool) }); return definitions; },
  };
}

const cases = [];
function check(name, run) { cases.push([name, run]); }

check('exports an inert V2 definition without loading Bun or the legacy SDK', async () => {
  const module = await import(entryURL.href);
  assert.deepEqual(Object.keys(module), ['default']);
  assert.equal(module.default.id, 'ecc-universal');
  assert.equal(typeof module.default.setup, 'function');
});

check('rejects a V1 context before loading legacy code', async () => {
  const f = await fixture();
  await assert.rejects(f.plugin.setup({}), /OpenCode V2/);
  assert.equal(f.loadCount(), 0);
});

for (const [domain, method] of [['tool', 'hook'], ['tool', 'transform'], ['shell', 'hook'], ['session', 'hook']]) {
  check(`reports missing ${domain}.${method} instead of silently skipping`, async () => {
    const f = await fixture();
    delete f.ctx[domain][method];
    await assert.rejects(f.plugin.setup(f.ctx), new RegExp(`${domain}\\.${method}`));
    assert.equal(f.loadCount(), 0);
  });
}

check('requires an absolute location directory', async () => {
  const f = await fixture();
  f.ctx.location.directory = 'relative';
  await assert.rejects(f.plugin.setup(f.ctx), /absolute/);
  assert.equal(f.loadCount(), 0);
});

check('registers runtime hooks and a replayable tool transform', async () => {
  const f = await fixture();
  await f.plugin.setup(f.ctx);
  assert.deepEqual([...f.registered.keys()], [
    'tool:execute.before', 'tool:execute.after', 'shell:create.before', 'session:compaction', 'tools',
  ]);
  assert.equal(f.loadCount(), 1);
  assert.ok(f.messages.some(({ message }) => /loaded/.test(message)));
});

check('maps V2 tool input to legacy args and writes argument mutations back', async () => {
  let seen;
  const f = await fixture({ 'tool.execute.before': async (input, output) => {
    seen = input;
    output.args = { ...output.args, timeout: 30 };
  } });
  await f.plugin.setup(f.ctx);
  const event = { tool: 'bash', sessionID: 's1', callID: 'c1', input: { command: 'git status' } };
  await f.registered.get('tool:execute.before')(event);
  assert.deepEqual(seen, { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'git status' } });
  assert.deepEqual(event.input, { command: 'git status', timeout: 30 });
});

check('propagates pre-tool rejection instead of swallowing it', async () => {
  const f = await fixture({ 'tool.execute.before': async () => { throw new Error('blocked'); } });
  await f.plugin.setup(f.ctx);
  await assert.rejects(f.registered.get('tool:execute.before')({ tool: 'write', input: {} }), /blocked/);
});

check('does not invoke success or formatting hooks for failed tools', async () => {
  const calls = [];
  const f = await fixture({
    'tool.execute.after': async () => calls.push('after'),
    'file.edited': async () => calls.push('edited'),
  });
  await f.plugin.setup(f.ctx);
  await f.registered.get('tool:execute.after')({ tool: 'edit', status: 'error', input: { filePath: 'a.ts' }, error: { message: 'failed' } });
  assert.deepEqual(calls, []);
});

check('forwards successful tool results without dropping structured content', async () => {
  const f = await fixture({ 'tool.execute.after': async (_input, output) => { output.metadata = { checked: true }; } });
  await f.plugin.setup(f.ctx);
  const content = [{ type: 'text', text: 'result' }];
  const event = { tool: 'read', status: 'completed', input: {}, result: { content, metadata: { original: true } } };
  await f.registered.get('tool:execute.after')(event);
  assert.equal(event.result.content, content);
  assert.deepEqual(event.result.metadata, { checked: true });
});

check('forwards legacy output replacements', async () => {
  const f = await fixture({ 'tool.execute.after': async (_input, output) => { output.output = 'replacement'; } });
  await f.plugin.setup(f.ctx);
  const event = { tool: 'read', status: 'completed', input: {}, result: { content: 'original' } };
  await f.registered.get('tool:execute.after')(event);
  assert.equal(event.result.content, 'replacement');
});

for (const key of ['filePath', 'file_path', 'path']) {
  check(`dispatches file.edited after successful writes using ${key}`, async () => {
    const calls = [];
    const f = await fixture({ 'tool.execute.after': async () => calls.push('after'), 'file.edited': async (event) => calls.push(event.path) });
    await f.plugin.setup(f.ctx);
    await f.registered.get('tool:execute.after')({ tool: 'write', status: 'completed', input: { [key]: 'src/a.ts' }, result: { content: 'ok' } });
    assert.deepEqual(calls, [path.resolve('/project/worktree/src/a.ts'), 'after']);
  });
}

check('does not format files for read tools or missing paths', async () => {
  let edits = 0;
  const f = await fixture({ 'file.edited': async () => edits++ });
  await f.plugin.setup(f.ctx);
  for (const [tool, input] of [['read', { filePath: 'a.ts' }], ['edit', {}]]) {
    await f.registered.get('tool:execute.after')({ tool, status: 'completed', input, result: { content: '' } });
  }
  assert.equal(edits, 0);
});

check('merges shell environment without changing cwd, command, or unrelated values', async () => {
  const f = await fixture({ 'shell.env': async (input, output) => {
    assert.equal(input.cwd, '/project/worktree/subdir');
    output.env = { ...output.env, ECC_PLUGIN: 'true' };
  } });
  await f.plugin.setup(f.ctx);
  const event = { cwd: '/project/worktree/subdir', command: 'pwd', env: { KEEP: 'yes', UNSET: undefined } };
  await f.registered.get('shell:create.before')(event);
  assert.deepEqual(event, { cwd: '/project/worktree/subdir', command: 'pwd', env: { KEEP: 'yes', UNSET: undefined, ECC_PLUGIN: 'true' } });
});

check('appends compaction guidance without replacing history or another plugin result', async () => {
  const f = await fixture({ 'experimental.session.compacting': async (_input, output) => { output.context.push('ECC guidance'); } });
  await f.plugin.setup(f.ctx);
  const event = { sessionID: 's1', system: [{ type: 'text', text: 'original' }], messages: [{ role: 'user' }], result: { summary: 'custom' } };
  await f.registered.get('session:compaction')(event);
  assert.deepEqual(event.system, [{ type: 'text', text: 'original' }, { type: 'text', text: 'ECC guidance' }]);
  assert.deepEqual(event.result, { summary: 'custom' });
  assert.deepEqual(event.messages, [{ role: 'user' }]);
});

check('preserves a legacy custom compaction prompt', async () => {
  const f = await fixture({ 'experimental.session.compacting': async (_input, output) => { output.prompt = 'custom prompt'; } });
  await f.plugin.setup(f.ctx);
  const event = { sessionID: 's1', system: [] };
  await f.registered.get('session:compaction')(event);
  assert.deepEqual(event.system, [{ type: 'text', text: 'custom prompt' }]);
});

check('keeps configured permissions intact instead of carrying over legacy auto-approval', async () => {
  let approvalCalls = 0;
  const f = await fixture({ 'permission.ask': async () => approvalCalls++ });
  f.ctx.permission = { hook: () => { throw new Error('must not register auto-approval'); } };
  await f.plugin.setup(f.ctx);
  assert.equal(approvalCalls, 0);
});

check('registers native JSON-schema tools, parses arguments, and maps string results', async () => {
  const input = { type: 'object', properties: { format: { type: 'string' } } };
  const f = await fixture({}, [{
    name: 'changed-files', description: 'Files', input,
    parse: (args) => ({ format: 'tree', ...args }),
    execute: async (args, context) => {
      assert.equal(context.directory, path.resolve('/project/worktree'));
      assert.equal(context.worktree, path.resolve('/project/worktree'));
      assert.equal(context.abort, controller.signal);
      return args.format;
    },
  }]);
  const controller = new AbortController();
  await f.plugin.setup(f.ctx);
  const [tool] = f.tools();
  assert.equal(tool.name, 'changed-files');
  assert.equal(tool.input, input);
  assert.deepEqual(await tool.execute({}, { signal: controller.signal }), { content: 'tree' });
  assert.equal(f.tools().length, 1);
  assert.equal(f.loadCount(), 1);
});

check('rejects invalid tool input before execution', async () => {
  let executions = 0;
  const f = await fixture({}, [{ name: 'test', input: {}, parse: () => { throw new Error('invalid input'); }, execute: async () => executions++ }]);
  await f.plugin.setup(f.ctx);
  await assert.rejects(f.tools()[0].execute({}, {}), /invalid input/);
  assert.equal(executions, 0);
});

check('honors cancellation before invoking a legacy custom tool', async () => {
  let executions = 0;
  const f = await fixture({}, [{ name: 'test', input: {}, parse: (args) => args, execute: async () => executions++ }]);
  await f.plugin.setup(f.ctx);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.tools()[0].execute({}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(executions, 0);
});

check('maps legacy structured tool output', async () => {
  const f = await fixture({}, [{ name: 'test', input: {}, parse: (args) => args,
    execute: async () => ({ title: 'Result', output: 'text', metadata: { ok: true } }),
  }]);
  await f.plugin.setup(f.ctx);
  assert.deepEqual(await f.tools()[0].execute({}, {}), { title: 'Result', content: 'text', metadata: { ok: true } });
});

check('fails explicitly for unsupported attachment output', async () => {
  const f = await fixture({}, [{ name: 'test', input: {}, parse: (args) => args,
    execute: async () => ({ output: '', attachments: [{ url: 'file:///x' }] }),
  }]);
  await f.plugin.setup(f.ctx);
  await assert.rejects(f.tools()[0].execute({}, {}), /attachments/);
});

check('cleanup disposes every registration once and invokes legacy disposal', async () => {
  let count = 0;
  const f = await fixture({ dispose: async () => count++ });
  const cleanup = await f.plugin.setup(f.ctx);
  await cleanup();
  await cleanup();
  assert.equal(f.disposed.length, 5);
  assert.equal(count, 1);
  assert.equal(f.registered.size, 0);
});

check('rolls back registrations if setup fails midway', async () => {
  let count = 0;
  const f = await fixture({ dispose: async () => count++ });
  f.ctx.shell.hook = async () => { throw new Error('registration failed'); };
  await assert.rejects(f.plugin.setup(f.ctx), /registration failed/);
  assert.deepEqual(f.disposed, ['tool:execute.after', 'tool:execute.before']);
  assert.equal(count, 1);
});

check('cleanup attempts all disposals even when one fails', async () => {
  const f = await fixture();
  f.ctx.shell.hook = async () => ({ dispose: async () => { throw new Error('dispose failed'); } });
  const cleanup = await f.plugin.setup(f.ctx);
  await assert.rejects(cleanup(), /cleanup/);
  assert.ok(f.disposed.includes('tool:execute.before'));
  assert.ok(f.disposed.includes('tools'));
});

check('preserves the primary startup failure if rollback also fails', async () => {
  const f = await fixture();
  f.ctx.tool.hook = async () => ({ dispose: async () => { throw new Error('rollback failure'); } });
  f.ctx.shell.hook = async () => { throw new Error('startup failure'); };
  await assert.rejects(f.plugin.setup(f.ctx), /startup failure/);
  assert.ok(f.messages.some(({ level }) => level === 'error'));
});

check('gives an actionable missing-build error from an isolated entrypoint', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-v2-missing-build-'));
  try {
    const destination = path.join(root, '.opencode/v2');
    fs.mkdirSync(destination, { recursive: true });
    for (const file of ['index.mjs', 'adapter.mjs']) {
      fs.copyFileSync(path.resolve(__dirname, '../../.opencode/v2', file), path.join(destination, file));
    }
    const f = await fixture();
    const { default: plugin } = await import(pathToFileURL(path.join(destination, 'index.mjs')).href);
    await assert.rejects(plugin.setup(f.ctx), /npm run build:opencode/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

let passed = 0;
let failed = 0;
for (const [name, run] of cases) {
  test(name, async () => {
    try { await run(); passed++; } catch (error) { failed++; throw error; }
  });
}
process.on('beforeExit', () => {
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
});
