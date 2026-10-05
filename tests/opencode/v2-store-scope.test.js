const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

let sequence = 0;
async function loadStore() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../.opencode/plugins/lib/changed-files-store.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const code = Buffer.from(`${outputText}\n// instance ${sequence++}`).toString('base64');
  return import(`data:text/javascript;base64,${code}`);
}

const cases = [
  ['preserves the unscoped V1 store contract', async () => {
    const store = await loadStore();
    const root = path.resolve('/legacy');
    store.initStore(root);
    store.recordChange(path.join(root, 'a.ts'), 'added');
    assert.deepEqual(store.getChangedPaths(), [{ path: 'a.ts', changeType: 'added' }]);
    const snapshot = store.getChanges();
    snapshot.clear();
    assert.equal(store.hasChanges(), true);
    store.clearChanges();
    assert.equal(store.hasChanges(), false);
  }],
  ['keeps two concurrent V2 locations and the V1 fallback independent', async () => {
    const store = await loadStore();
    store.initStore('/legacy');
    store.recordChange('legacy.ts', 'modified');
    const first = store.createStoreScope(path.resolve('/first'));
    const second = store.createStoreScope(path.resolve('/second'));
    await Promise.all([
      first(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        store.recordChange(path.resolve('/first/one.ts'), 'added');
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(store.getChangedPaths(), [{ path: 'one.ts', changeType: 'added' }]);
      }),
      second(async () => {
        store.recordChange(path.resolve('/second/two.ts'), 'modified');
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(store.getChangedPaths(), [{ path: 'two.ts', changeType: 'modified' }]);
      }),
    ]);
    assert.deepEqual(store.getChangedPaths(), [{ path: 'legacy.ts', changeType: 'modified' }]);
    first(() => store.clearChanges());
    assert.equal(first(() => store.hasChanges()), false);
    assert.equal(second(() => store.hasChanges()), true);
    assert.equal(store.hasChanges(), true);
  }],
  ['restores the outer scope after nesting and exceptions', async () => {
    const store = await loadStore();
    const outer = store.createStoreScope('/outer');
    const inner = store.createStoreScope('/inner');
    await outer(async () => {
      store.recordChange('outer.ts', 'added');
      await assert.rejects(inner(async () => {
        store.recordChange('inner.ts', 'deleted');
        throw new Error('inner failure');
      }), /inner failure/);
      assert.deepEqual(store.getChangedPaths(), [{ path: 'outer.ts', changeType: 'added' }]);
    });
    assert.equal(store.hasChanges(), false);
  }],
  ['scopes initStore without resetting another location root', async () => {
    const store = await loadStore();
    store.initStore('/legacy');
    const run = store.createStoreScope('/v2');
    run(() => {
      store.initStore('/v2/linked');
      store.recordChange(path.resolve('/v2/linked/a.ts'), 'modified');
    });
    store.recordChange(path.resolve('/legacy/b.ts'), 'added');
    assert.deepEqual(run(() => store.getChangedPaths()), [{ path: 'a.ts', changeType: 'modified' }]);
    assert.deepEqual(store.getChangedPaths(), [{ path: 'b.ts', changeType: 'added' }]);
  }],
  ['preserves filtering, tree rendering, and snapshot isolation inside a scope', async () => {
    const store = await loadStore();
    const run = store.createStoreScope('/project');
    run(() => {
      store.recordChange('z.ts', 'deleted');
      store.recordChange(path.join('src', 'a.ts'), 'added');
      store.recordChange(path.join('src', 'b.ts'), 'modified');
      assert.equal(store.buildTree()[0].name, 'src');
      assert.equal(store.buildTree('added')[0].children[0].name, 'a.ts');
      assert.deepEqual(store.getChangedPaths('deleted'), [{ path: 'z.ts', changeType: 'deleted' }]);
      store.getChanges().clear();
      assert.equal(store.getChangedPaths().length, 3);
    });
  }],
  ['retains an absolute path outside the worktree', async () => {
    const store = await loadStore();
    const run = store.createStoreScope('/project');
    run(() => {
      store.recordChange('', 'added');
      store.recordChange(path.resolve('/elsewhere/a.ts'), 'modified');
      assert.deepEqual(store.getChangedPaths(), [{ path: path.resolve('/elsewhere/a.ts'), changeType: 'modified' }]);
    });
  }],
];
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
