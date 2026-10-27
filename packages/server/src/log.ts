import type { Logger } from './plugins/registry.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JsonLogger extends Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Meta may be a plain object (spread into the line) or anything else (stored under `meta`). */
function metaFields(meta: unknown): Record<string, unknown> {
  if (meta === undefined || meta === null) return {};
  if (meta instanceof Error) return { error: meta.message, stack: meta.stack };
  if (typeof meta === 'object' && !Array.isArray(meta)) return meta as Record<string, unknown>;
  return { meta };
}

/** R42: one JSON object per line: `{ts, level, msg, ...meta}`. Default sink is stdout. */
export function createLogger(opts: { level?: LogLevel; write?: (line: string) => void } = {}): JsonLogger {
  const min = ORDER[opts.level ?? 'info'];
  const write = opts.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const emit = (level: LogLevel, msg: string, meta?: unknown): void => {
    if (ORDER[level] < min) return;
    // reserved keys come last so meta can never overwrite them
    const ts = new Date().toISOString();
    let line: string;
    try {
      line = JSON.stringify({ ...metaFields(meta), ts, level, msg });
    } catch {
      // BigInt, circular structures, throwing toJSON: logging must never throw
      line = JSON.stringify({ ts, level, msg, log_error: 'meta not serializable' });
    }
    try {
      write(line);
    } catch {
      // a broken sink must not break the caller
    }
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}
