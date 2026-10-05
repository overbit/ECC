import { existsSync } from 'node:fs';
import { createV2Plugin } from './adapter.mjs';

async function loadLegacy(directory) {
  const entry = new URL('../dist/plugins/ecc-hooks.js', import.meta.url);
  if (!existsSync(entry)) {
    throw new Error(
      '[ECC] OpenCode V2 requires the compiled ECC payload. ' +
      'Run npm install --ignore-scripts && npm run build:opencode from the ECC repository root.'
    );
  }

  // The supported installation is a built source checkout with its pinned
  // dependencies. No imports from the legacy SDK run at module-evaluation time.
  const [{ ECCHooksPlugin }, { createStoreScope, clearChanges }, { $ }, { tool }] = await Promise.all([
    import(entry.href),
    import('../dist/plugins/lib/changed-files-store.js'),
    import('bun'),
    import('@opencode-ai/plugin/tool'),
  ]);
  if (typeof tool.schema.toJSONSchema !== 'function') {
    throw new Error('[ECC] The V2 adapter needs the pinned Zod 4 tool SDK. Run npm install in the ECC repository root.');
  }

  if (typeof createStoreScope !== 'function') {
    throw new Error('[ECC] Compiled ECC files are stale. Run npm run build:opencode again.');
  }
  const inScope = createStoreScope(directory);
  const hooks = await inScope(() => ECCHooksPlugin({
    directory,
    worktree: directory,
    // Set cwd per command, not through process.chdir or Bun's global defaults.
    $: (strings, ...values) => $(strings, ...values).cwd(directory),
    client: {
      app: {
        log: async ({ body }) => {
          const write = body.level === 'error' ? console.error : body.level === 'warn' ? console.warn : console.info;
          write(body.message);
        },
      },
    },
  }));
  const tools = Object.entries(hooks.tool ?? {}).map(([name, definition]) => {
    const schema = tool.schema.object(definition.args);
    return {
      name,
      description: definition.description,
      input: tool.schema.toJSONSchema(schema, { io: 'input' }),
      parse: (input) => schema.parse(input),
      execute: (input, context) => inScope(() => definition.execute(input, context)),
    };
  });
  const scopedHooks = Object.fromEntries(Object.entries(hooks).map(([name, value]) => [
    name, typeof value === 'function' ? (...args) => inScope(() => value(...args)) : value,
  ]));
  scopedHooks.dispose = async () => {
    try { await inScope(() => hooks.dispose?.()); } finally { inScope(clearChanges); }
  };
  return { hooks: scopedHooks, tools };
}

export default createV2Plugin(loadLegacy);
