// app.ts — router forge github-core-clone-01.
//
// Satu Store untuk semua permukaan (git, REST, GraphQL, MCP). main.ts tidak
// diubah; file ini hanya me-routing request ke handler tiap permukaan.
// Handler membaca body request sendiri dari stream req — router TIDAK BOLEH
// membaca body lebih dulu. Semua balasan error di sini JSON, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git-http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Jawab satu request dengan body JSON. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Path request, atau '/' bila tidak bisa di-parse (tidak pernah throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Pola path git smart HTTP: /{owner}/{repo}.git[/...]. */
const GIT_PATH = /^\/[^/]+\/[^/]+\.git(\/|$)/;

/** Build server. Satu Store per server; main.ts memanggil ini sekali. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // Boot probe env (tanpa auth).
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (GIT_PATH.test(path)) {
          if (await handleGit(req, res, store, { ownerLogin: store.getViewerLogin() ?? '' })) return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, store, { token })) return;
        }

        // GraphQL v4.
        if (method === 'POST' && (path === '/api/graphql' || path === '/api/graphql/')) {
          if (await handleGraphql(req, res, store, { token })) return;
        }

        // MCP.
        if (path === '/mcp' || path === '/mcp/') {
          if (await handleMcp(req, res, store, { token })) return;
        }

        // Rute tak dikenal: 404 JSON, never HTML.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Jaring pengaman: jangan pernah menjatuhkan server atau menjawab HTML.
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : 'internal error';
          sendJson(res, 500, { message: `internal error: ${message}` });
        } else {
          try {
            res.end();
          } catch {
            // Abaikan: koneksi sudah rusak.
          }
        }
      }
    })();
  });
}
