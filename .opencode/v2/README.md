# ECC on OpenCode V2

This is an **opt-in V2 runtime adapter for a built ECC source checkout**.
The existing `.opencode/index.ts`, package default export, V1 configuration,
and home installer remain V1-compatible and are not replaced by this adapter.

V2 loads a default `{ id, setup(ctx) }` definition. It does not execute ECC's
legacy `async (input) => hooks` export. Changing `plugin` to `plugins` alone
therefore does not make the existing ECC package entrypoint work.

## Install from this checkout

Run these commands in the ECC checkout containing the V2 adapter:

```bash
npm install --include=dev --ignore-scripts
npm run build:opencode
node -e "console.log(require('node:path').resolve('.opencode/v2/index.mjs'))"
```

Copy the absolute path printed by the last command into your **project's** V2
`opencode.json` or `opencode.jsonc`, preserving your other settings and plugins:

```json
{
  "plugins": [
    "/absolute/path/to/ECC/.opencode/v2/index.mjs"
  ]
}
```

On Windows, use forward slashes in JSON, for example
`C:/Users/you/src/ECC/.opencode/v2/index.mjs`.

Remove only the old ECC plugin reference from that project's configuration;
do not replace the entire plugins array or delete other plugins. Do not copy
the legacy `.opencode/plugins/` directory into V2's auto-discovery directory.
Run OpenCode V2 in your own project, not in the ECC repository, which contains
its separate V1 reference configuration.

Restart OpenCode V2, then inspect its active plugin list:

```bash
opencode2 api get /api/plugin
```

The list should contain `ecc-universal`. The adapter also logs
`[ECC] OpenCode V2 adapter loaded (runtime hooks and custom tools).`
A missing build or missing V2 runtime capability produces an actionable error
instead of returning an empty plugin. This adapter requires the current V2
Promise runtime hooks documented below; early beta builds without those hooks
must be upgraded.

The JavaScript entrypoint uses the documented V2 definition shape directly,
without importing an additional V2 SDK. It uses ECC's existing pinned
`@opencode-ai/plugin` dependency only to reuse the legacy hook implementation
and its Zod tool schemas. The host is the Bun-based OpenCode runtime.

## What this adapter enables

| ECC implementation | V2 registration |
| --- | --- |
| `tool.execute.before` | `ctx.tool.hook("execute.before", ...)` |
| `file.edited` and `tool.execute.after` | Successful `ctx.tool.hook("execute.after", ...)` calls |
| `shell.env` | `ctx.shell.hook("create.before", ...)` |
| `experimental.session.compacting` | `ctx.session.hook("compaction", ...)`, appending system guidance |
| Exported `tool` map | `ctx.tool.transform(...)` with JSON Schema inputs and structured results |

The current ECC plugin exports `changed-files` and `dependency-analyzer` in its
tool map. This adapter registers those tools; it does not promise that every
tool listed elsewhere in ECC's reference documentation is exported.

The adapter reuses existing hook behavior, including its existing limitations.
Failed tool calls do not trigger formatting or success checks. Existing shell
environment values and other plugins' compaction content are preserved. The
V1 permission auto-approval heuristic is deliberately not forwarded: V2's
configured permission rules and user approvals remain authoritative.

Hook profiles and disabled-hook IDs retain their existing meanings:

```bash
export ECC_HOOK_PROFILE=standard
export ECC_DISABLED_HOOKS="post:edit:typecheck"
```

Loading this entrypoint explicitly enables the hook runtime. `minimal`,
`standard`, and `strict` select the same behaviors as the legacy implementation;
formatting and typechecking require `strict`.

## Scope and limitations

This is an initial runtime port, not full V1 feature parity. It does **not**
register ECC's agent/command/instruction catalog or convert the home installer
into a V2 installer. The existing default npm entrypoint is still V1-only;
use the explicit source-checkout entrypoint above for V2.

Session lifecycle notifications, idle audits, raw file-watcher events, and todo
progress are not ported in this change. File tracking covers successful
`edit`/`write` calls in the loaded plugin location, not arbitrary filesystem
changes or a complete `apply_patch` change list. It is location-scoped for the
plugin's lifetime, not isolated per conversation. Reloading/unloading the
plugin clears its tracker.

The changed-files store uses an async-local scope per V2 plugin instance, so
separate locations do not overwrite one another's worktree or tracked files.
Unscoped V1 callers retain their previous store behavior. Shell commands use a
per-command working directory; the adapter never changes the process cwd.

The dependency analyzer retains ECC's existing implementation; this port does
not add registry lookups, vulnerability scanning, or automatic dependency fixes.

## Verification

The ordinary Node test suite discovers both `*.test.js` files automatically:

```bash
node tests/opencode/v2-adapter.test.js
node tests/opencode/v2-store-scope.test.js
```

The adapter tests use a V2 contract fixture. The store tests execute the actual
TypeScript implementation, transpiled with the repository's TypeScript
dependency, and cover the V1 fallback plus concurrent V2 scopes.

After building, run the integration smoke test with a standalone Bun CLI:

```bash
bun tests/opencode/v2-runtime-smoke.mjs
```

This imports the real compiled ECC hooks, real tool schemas, and Bun shell
helper into a fixture host. It is not a substitute for launching OpenCode V2.
Before merging, verify the active plugin ID in a real V2 process, exercise an
edit plus both custom tools, test the selected hook profile, and reload the
plugin. Also run the full repository build and test suite.

## API references

- [V1 to V2 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [V2 Promise plugin API](https://opencode.ai/v2/docs/build/plugins/)

Do not use the old experimental `@opencode-ai/plugin/v2` examples for this
adapter; the current SDK namespace is `@opencode/plugin` and tool definitions
use JSON Schema with structured results.
