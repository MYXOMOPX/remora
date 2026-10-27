import type { ErrorCode } from '@remora/sdk';
import type http from 'node:http';

/**
 * An error that maps to an HTTP response. `closeConnection` is set when the request body was not
 * (fully) consumed, so the server answers with `Connection: close` and does not reuse the socket.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly closeConnection: boolean;

  constructor(status: number, code: ErrorCode, message: string, closeConnection = false) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.closeConnection = closeConnection;
  }
}

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/** Deepest array/object nesting accepted in a request body. */
export const MAX_JSON_DEPTH = 64;

/** True when the JSON text nests arrays/objects deeper than `max`. Linear scan, no recursion, strings skipped. */
export function exceedsJsonDepth(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) return true;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return false;
}

/**
 * Reads a JSON body. The size is counted while chunks arrive: a `Content-Length` over the limit
 * fails before any byte is read, and once the running total passes the limit buffering stops and
 * the rest of the upload is left unread (the caller closes the connection). `timeoutMs` bounds the
 * whole read (slow-body protection).
 */
export function readJsonBody(req: http.IncomingMessage, limit: number, timeoutMs?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!isJsonContentType(req.headers['content-type'])) {
      return reject(new HttpError(415, 'invalid_param', 'Content-Type must be application/json', true));
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      if (!/^\d+$/.test(declared)) {
        return reject(new HttpError(400, 'invalid_param', 'invalid Content-Length', true));
      }
      if (Number(declared) > limit) {
        return reject(new HttpError(413, 'invalid_param', `request body exceeds ${limit} bytes`, true));
      }
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (timer) clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const fail = (err: HttpError): void => {
      finish();
      chunks.length = 0;
      req.pause(); // stop reading; the socket is closed after the response
      reject(err);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) return fail(new HttpError(413, 'invalid_param', `request body exceeds ${limit} bytes`, true));
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      finish();
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return reject(new HttpError(400, 'invalid_param', 'request body is not valid UTF-8'));
      }
      if (exceedsJsonDepth(text, MAX_JSON_DEPTH)) {
        return reject(new HttpError(400, 'invalid_param', `request body is nested deeper than ${MAX_JSON_DEPTH} levels`));
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'invalid_param', 'request body is not valid JSON'));
      }
    };
    const onError = (): void => fail(new HttpError(400, 'invalid_param', 'request body could not be read', true));
    const onClose = (): void => {
      if (!req.complete) fail(new HttpError(400, 'invalid_param', 'request body incomplete', true));
    };

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => fail(new HttpError(408, 'invalid_param', 'request body timeout', true)), timeoutMs);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}
