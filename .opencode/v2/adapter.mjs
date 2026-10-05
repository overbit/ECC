import path from 'node:path';

// The V2 Promise contract is { id, setup(ctx) }; Plugin.define is an identity
// helper, not a requirement for loading a JavaScript plugin. Keep this module
// independent of both SDKs so V1 users do not acquire a second runtime SDK.
// https://opencode.ai/v2/docs/build/plugins/migrate-v1
function assertV2Context(ctx) {
  for (const [domain, method] of [
    ['tool', 'hook'], ['tool', 'transform'], ['shell', 'hook'], ['session', 'hook'],
  ]) {
    if (typeof ctx?.[domain]?.[method] !== 'function') {
      throw new Error(
        `[ECC] OpenCode V2 requires ctx.${domain}.${method}. ` +
        'Update your V2 runtime; use the existing ECC entrypoint for OpenCode V1.'
      );
    }
  }
  if (typeof ctx.location?.directory !== 'string' || !path.isAbsolute(ctx.location.directory)) {
    throw new Error('[ECC] OpenCode V2 must provide an absolute ctx.location.directory.');
  }
}

function legacyInput(event) {
  return {
    tool: event.tool,
    sessionID: event.sessionID,
    callID: event.callID,
    args: event.input,
  };
}

function editedPath(event, directory) {
  if (event.tool !== 'edit' && event.tool !== 'write') return;
  const value = event.input?.filePath ?? event.input?.file_path ?? event.input?.path;
  if (typeof value === 'string' && value.trim()) return path.resolve(directory, value);
}

function toolResult(result) {
  if (typeof result === 'string') return { content: result };
  if (!result || typeof result.output !== 'string') {
    throw new Error('[ECC] Legacy tool returned an unsupported result.');
  }
  if (result.attachments?.length) {
    throw new Error('[ECC] Legacy tool attachments require a native V2 tool implementation.');
  }
  const { output, attachments: _attachments, ...rest } = result;
  return { ...rest, content: output };
}

function nativeTool(tool, directory) {
  return {
    name: tool.name,
    description: tool.description,
    input: tool.input,
    async execute(input, context) {
      context.signal?.throwIfAborted();
      const args = tool.parse(input);
      const result = await tool.execute(args, {
        ...context,
        directory,
        worktree: directory,
        abort: context.signal,
        // The two tools exported by ECC do not ask for permissions. Do not
        // silently approve a future legacy tool that starts requesting them.
        ask: async () => {
          throw new Error('[ECC] This legacy tool requires a native V2 permission adapter.');
        },
      });
      context.signal?.throwIfAborted();
      return toolResult(result);
    },
  };
}

/**
 * Bridge ECC's existing hook implementation to the documented V2 runtime.
 * loadLegacy(directory) returns { hooks, tools }; each tool supplies a JSON
 * Schema input, a Zod-backed parse function, and its existing execute function.
 * Loading is deferred until setup, after the host contract has been checked.
 */
export function createV2Plugin(loadLegacy, log = (level, message) => {
  const write = level === 'error' ? console.error : console.info;
  write(message);
}) {
  return {
    id: 'ecc-universal',
    async setup(ctx) {
      assertV2Context(ctx);
      // A linked worktree must not be replaced by project.canonical here.
      const directory = ctx.location.directory;
      const { hooks, tools } = await loadLegacy(directory);
      const registrations = [];
      let cleanupPromise;
      const cleanup = () => {
        cleanupPromise ??= (async () => {
          const errors = [];
          for (const registration of [...registrations].reverse()) {
            try { await registration.dispose(); } catch (error) { errors.push(error); }
          }
          try { await hooks.dispose?.(); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, '[ECC] V2 plugin cleanup failed.');
        })();
        return cleanupPromise;
      };

      try {
        registrations.push(await ctx.tool.hook('execute.before', async (event) => {
          const output = { args: event.input };
          await hooks['tool.execute.before']?.(legacyInput(event), output);
          event.input = output.args;
        }));

        registrations.push(await ctx.tool.hook('execute.after', async (event) => {
          // V2 also invokes this hook for failures. Legacy checks and formatting
          // must only run after the underlying operation succeeded.
          if (event.status !== 'completed') return;
          const result = event.result;
          const originalOutput = typeof result.content === 'string' ? result.content : '';
          const output = {
            title: result.title,
            output: originalOutput,
            metadata: result.metadata,
          };
          // Format before typechecking; the subsequent write hook also restores
          // the pending 'added' classification after file.edited records a change.
          const file = editedPath(event, directory);
          if (file) await hooks['file.edited']?.({ path: file });
          await hooks['tool.execute.after']?.(legacyInput(event), output);
          event.result = {
            ...result,
            ...(output.title !== result.title ? { title: output.title } : {}),
            ...(output.metadata !== result.metadata ? { metadata: output.metadata } : {}),
            ...(output.output !== originalOutput ? { content: output.output } : {}),
          };
        }));

        registrations.push(await ctx.shell.hook('create.before', async (event) => {
          const output = { env: { ...event.env } };
          await hooks['shell.env']?.({ cwd: event.cwd }, output);
          event.env = output.env;
        }));

        registrations.push(await ctx.session.hook('compaction', async (event) => {
          const output = { context: [] };
          await hooks['experimental.session.compacting']?.({ sessionID: event.sessionID }, output);
          const additions = output.prompt === undefined ? output.context : [output.prompt];
          event.system = [
            ...event.system,
            ...additions.filter(Boolean).map((text) => ({ type: 'text', text })),
          ];
        }));

        // Transforms can be replayed: all parsing/schema construction and other
        // one-time work happens outside the synchronous editor callback.
        const definitions = tools.map((tool) => nativeTool(tool, directory));
        registrations.push(await ctx.tool.transform((editor) => {
          for (const definition of definitions) editor.add(definition);
        }));

        // Intentionally do not translate the legacy permission.ask auto-allow
        // heuristic. V2's configured rules and approval prompts remain in force.
        log('info', '[ECC] OpenCode V2 adapter loaded (runtime hooks and custom tools).');
        return cleanup;
      } catch (error) {
        try { await cleanup(); } catch {
          log('error', '[ECC] V2 setup rollback also failed; preserving the original startup error.');
        }
        throw error;
      }
    },
  };
}
