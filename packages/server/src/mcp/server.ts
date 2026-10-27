import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type http from 'node:http';
import type { ApiError } from '../api/apply.js';
import type { RemoraApp } from '../app.js';
import { getContract } from '../contract/index.js';
import { runApply, runQuery } from '../transport/dispatch.js';

export interface McpOptions {
  /** Called with errors thrown by the app; the client only ever sees a generic `internal` envelope. */
  onError?(error: unknown): void;
}

const APPLY_DESCRIPTION =
  'Write to the memory: create entities, property types, relation types and evidence sources, and add, change or retract facts, relations, events and evidence. ' +
  'Send {"ops": [...]}; the ops run in order inside one transaction, so a failing op rolls the whole batch back. ' +
  'Give an op an "as" name and refer to its result later in the same batch as "$name". ' +
  'The result is a JSON envelope {ok, results} or {ok:false, error:{op_index, code, message, details}}; op_index points at the failing op.';

const QUERY_DESCRIPTION =
  'Read from the memory (never changes anything): fetch entities, facts as of a point in time on a time axis, history, relations, neighbors, events, evidence and the dictionaries of known types. ' +
  'Send {"ops": [...]}; every op is answered in one envelope {ok, results} or {ok:false, error:{op_index, code, message, details}}. ' +
  'Call the list_* ops first to see which property types, relation types and time axes exist.';

function errorEnvelope(error: ApiError): { ok: false; error: ApiError } {
  return { ok: false, error };
}

/** R27: the envelope is both `structuredContent` and the text content; `isError` mirrors `ok:false`. */
function toolResult(envelope: { ok: boolean }): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError: !envelope.ok,
  };
}

/** A low-level MCP server with the two tools `apply` and `query` (R27). */
export function createMcpServer(app: RemoraApp, opts: McpOptions = {}): Server {
  const server = new Server({ name: 'remora', version: '1.0.0' }, { capabilities: { tools: {} } });
  const contract = getContract();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'apply', description: APPLY_DESCRIPTION, inputSchema: contract.apply as { type: 'object' } },
      { name: 'query', description: QUERY_DESCRIPTION, inputSchema: contract.query as { type: 'object' } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== 'apply' && name !== 'query') {
      return toolResult(
        errorEnvelope({ op_index: -1, code: 'invalid_param', message: `unknown tool "${name}"; use "apply" or "query"` }),
      );
    }
    try {
      return toolResult(name === 'apply' ? await runApply(app, args) : await runQuery(app, args));
    } catch (e) {
      opts.onError?.(e);
      return toolResult(errorEnvelope({ op_index: -1, code: 'internal', message: 'internal error' }));
    }
  });

  return server;
}

/**
 * R28: stateless Streamable HTTP. A fresh server and transport per POST; both are closed when the
 * response closes. `body` is the already-read (size-limited) JSON body. Resolves once the response
 * is finished, so callers can count the request as in flight until then.
 */
export async function handleMcp(
  app: RemoraApp,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown,
  opts: McpOptions = {},
): Promise<void> {
  const server = createMcpServer(app, opts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const closed = new Promise<void>((resolve) => {
    res.once('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
      resolve();
    });
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (res.writableEnded || res.destroyed) {
      opts.onError?.(e);
    } else {
      throw e; // the HTTP server answers with its generic 500 envelope
    }
  }
  if (!res.writableFinished && !res.destroyed) await closed;
}
