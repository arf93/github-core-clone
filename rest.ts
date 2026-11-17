// rest.ts — REST v3 GitHub API (prefix /api/v3) untuk github-core-clone-01.
//
// Kontrak perilaku: ../spec/rest.md (55 check) dan ../spec/architecture.md §4-§5.
// Modul ini hanya tahu HTTP + Store: tidak menyimpan state sendiri, tidak
// memakai jam dinding / Math.random / UUID. Request-id memakai counter
// deterministik `req-<n>` (architecture.md §5).
//
// Kontrak dengan app.ts (router parent):
//   - app.ts TIDAK BOLEH membaca body request sebelum mendelegasikan ke
//     handleRest — body dibaca di sini dari stream req. Bila app.ts sudah
//     membaca body, ia harus menempelkannya sebagai `(req as any).body`
//     (string, atau objek JSON yang sudah di-parse).
//   - app.ts TIDAK BOLEH menimpa header X-GitHub-Request-Id untuk rute
//     yang ditangani handleRest — header itu dipasang di sini di semua
//     respons (termasuk 401/404/405/409/422/500).
//   - ctx.token adalah isi process.env.MAKEFUN_SHOP_TOKEN apa adanya;
//     token '' berarti tidak ada token yang valid (semua request ber-auth 401).
//
// Aturan auth (rest.md §3): GET /api/v3/ tidak butuh auth; semua rute
// /api/v3 lain butuh `Authorization: Bearer <ctx.token>` (tanpa header
// atau token salah -> 401 JSON). Owner lain -> 404, bukan 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StoreError, deterministicIso } from './store.ts';
import type { Comment, Issue, IssueState, Label, PullRequest, PullRequestState, Repo, Store } from './store.ts';

/** Konteks yang diberikan router parent (app.ts) ke handleRest. */
export interface RestContext {
  /** Isi process.env.MAKEFUN_SHOP_TOKEN apa adanya. */
  token: string;
}

/** Versi yang dilaporkan GET /api/v3/meta (nilai bebas, hanya tak-kosong). */
export const FORGE_VERSION = '0.0.0';

/** Batas ukuran body request yang dibaca (konten suite jauh di bawah ini). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Counter deterministik untuk header X-GitHub-Request-Id. */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

// ---------------------------------------------------------------------------
// Pembentuk objek JSON (dipakai juga graphql.ts / mcp.ts supaya bentuknya
// tidak drift antar permukaan).
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  const fullName = repo.owner === '' ? repo.name : `${repo.owner}/${repo.name}`;
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: fullName,
    owner: { login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: deterministicIso(repo.createdSeq),
    updated_at: deterministicIso(repo.createdSeq),
    url: `/api/v3/repos/${fullName}`,
    html_url: `/api/v3/repos/${fullName}`,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(store: Store, issue: Issue): Record<string, unknown> {
  return {
    // id REST GitHub adalah id global yang stabil; Store tidak menyimpannya,
    // jadi diturunkan secara deterministik dari (repo, number) — unik per
    // issue dan stabil antar pembacaan. Basis 2_000_000 memisahkannya dari
    // id pull request (offset +1_000_000, lihat pullRequestJson).
    id: issue.repoDatabaseId * 2_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = store.getLabel(issue.repoDatabaseId, name);
      return { name, color: label?.color ?? '' };
    }),
    created_at: deterministicIso(issue.createdSeq),
    updated_at: deterministicIso(issue.updatedSeq),
  };
}

export function pullRequestJson(pr: PullRequest): Record<string, unknown> {
  return {
    // id global deterministik, lihat komentar di issueJson; offset
    // +1_000_000 agar tidak bertabrakan dengan id issue bernomor sama.
    id: pr.repoDatabaseId * 2_000_000 + 1_000_000 + pr.number,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    created_at: deterministicIso(pr.createdSeq),
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    created_at: deterministicIso(comment.createdSeq),
  };
}

// ---------------------------------------------------------------------------
// Helper HTTP / parsing
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse, requestId: string): void {
  res.writeHead(204, { 'x-github-request-id': requestId });
  res.end();
}

function sendNotFound(res: ServerResponse, requestId: string): void {
  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

function errorStatus(err: unknown): { status: number; message: string } {
  if (err instanceof StoreError) {
    return { status: err.status, message: err.message === '' ? 'error' : err.message };
  }
  return { status: 500, message: err instanceof Error ? err.message : 'internal error' };
}

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== 'string') return null;
  }
  return [...(value as string[])];
}

function parseNumber(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** CommitInfo.message dinormalisasi dengan satu '\n' akhir (byte git);
 *  REST menampilkan pesan tanpa newline akhir itu (suite membandingkan
 *  persis dengan pesan yang dikirim). */
function stripOneTrailingNewline(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

function isAuthorized(req: IncomingMessage, ctx: RestContext): boolean {
  const token = ctx.token;
  if (token === '') return false;
  return req.headers.authorization === `Bearer ${token}`;
}

/** Baca body request sebagai string. Bila router parent sudah membaca body
 *  dan menempelkannya sebagai req.body (string / objek), pakai itu. */
async function readBody(req: IncomingMessage): Promise<string> {
  const attached = (req as unknown as { body?: unknown }).body;
  if (typeof attached === 'string') return attached;
  if (attached !== undefined && attached !== null && typeof attached === 'object') {
    return JSON.stringify(attached);
  }
  if (req.readableEnded) return '';
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(new StoreError(400, 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Baca body sebagai objek JSON. Body kosong -> {}. JSON malformed -> 400. */
async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreError(400, 'malformed JSON body');
  }
  const obj = asObject(parsed);
  if (obj === null) throw new StoreError(400, 'request body must be a JSON object');
  return obj;
}

// ---------------------------------------------------------------------------
// Repo resolution + paginasi
// ---------------------------------------------------------------------------

/** Resolve repo di bawah owner yang disebut di path. Repo pending (owner
 *  '') diikat ke owner itu (lazy binding); owner yang tidak cocok -> null
 *  (pemanggil menjawab 404, bukan 403). */
export function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  const direct = store.getRepoByOwnerAndName(owner, name);
  if (direct !== null) return direct;
  const byName = store.findRepoByName(name);
  if (byName === null) return null;
  if (byName.owner === '') {
    try {
      return store.bindOwner(byName.databaseId, owner);
    } catch {
      return null;
    }
  }
  return null;
}

/** Repo milik viewer (untuk GET /user/repos): yang terikat ke login viewer
 *  ditambah yang masih pending (dibuat token ini sebelum owner terikat). */
function viewerRepos(store: Store): Repo[] {
  const viewer = store.getViewerLogin();
  return store.listAllRepos().filter((repo) => repo.owner === '' || (viewer !== null && repo.owner === viewer));
}

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], params: PageParams): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  return { items: items.slice(start, start + params.perPage), totalPages };
}

/** Header Link gaya GitHub. `next` hanya bila ada halaman berikut (halaman
 *  terakhir tanpa `next`, supaya loop suite berhenti); `last` bila >1 halaman. */
function linkHeader(
  req: IncomingMessage,
  url: URL,
  query: URLSearchParams,
  page: number,
  perPage: number,
  totalPages: number,
): string | null {
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${base}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${build(page + 1)}; rel="next"`);
  parts.push(`${build(totalPages)}; rel="last"`);
  return parts.join(', ');
}

function linkHeaders(
  req: IncomingMessage,
  url: URL,
  query: URLSearchParams,
  page: number,
  perPage: number,
  totalPages: number,
): Readonly<Record<string, string>> {
  const link = linkHeader(req, url, query, page, perPage, totalPages);
  return link === null ? {} : { link };
}

// ---------------------------------------------------------------------------
// Router REST v3
// ---------------------------------------------------------------------------

/**
 * Tangani satu request HTTP di bawah /api/v3.
 * @returns true bila rute ditangani (termasuk 404 JSON untuk rute tak
 * dikenal di bawah /api/v3); false bila path bukan /api/v3 (router parent
 * yang menangani: /healthz, git, GraphQL, MCP).
 */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx: RestContext,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const pathname = url.pathname;
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  const requestId = nextRequestId();
  try {
    const segments = pathname
      .split('/')
      .filter((s) => s !== '')
      .slice(2)
      .map(decodeSegment);
    const method = req.method ?? 'GET';

    // GET /api/v3/ — satu-satunya rute REST tanpa auth (rest.md §4.2).
    if (segments.length === 0) {
      if (method === 'GET') {
        sendJson(
          res,
          200,
          { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
          requestId,
          { 'x-oauth-scopes': 'repo, read:org' },
        );
      } else {
        sendNotFound(res, requestId);
      }
      return true;
    }

    // Semua rute /api/v3 lain butuh Bearer token yang benar.
    if (!isAuthorized(req, ctx)) {
      sendJson(res, 401, { message: 'Requires authentication' }, requestId);
      return true;
    }

    await routeRest(req, res, store, url, segments, method, requestId);
    return true;
  } catch (err) {
    const { status, message } = errorStatus(err);
    try {
      sendJson(res, status, { message }, requestId);
    } catch {
      // Respons sudah terkirim sebagian; tidak ada lagi yang bisa dilakukan.
    }
    return true;
  }
}

async function routeRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  url: URL,
  segments: string[],
  method: string,
  requestId: string,
): Promise<void> {
  const query = url.searchParams;
  const first = segments[0];

  if (first === 'meta') {
    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { installed_version: FORGE_VERSION }, requestId);
      return;
    }
    sendNotFound(res, requestId);
    return;
  }

  if (first === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') {
        sendNotFound(res, requestId);
        return;
      }
      const viewer = store.getViewerUser();
      sendJson(
        res,
        200,
        { login: viewer.login, id: viewer.databaseId, name: viewer.name, email: viewer.email, type: 'User' },
        requestId,
      );
      return;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const params = pageParams(query);
        const page = paginate(viewerRepos(store), params);
        sendJson(
          res,
          200,
          page.items.map((repo) => repoJson(repo)),
          requestId,
          linkHeaders(req, url, query, params.page, params.perPage, page.totalPages),
        );
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const repo = store.createRepo({
          name: asString(body.name, ''),
          description: asString(body.description, ''),
          private: typeof body.private === 'boolean' ? body.private : false,
        });
        sendJson(res, 201, repoJson(repo), requestId);
        return;
      }
    }
    sendNotFound(res, requestId);
    return;
  }

  if (first === 'repos') {
    const owner = segments[1];
    const name = segments[2];
    if (owner === undefined || name === undefined) {
      sendNotFound(res, requestId);
      return;
    }
    const repo = resolveRepo(store, owner, name);
    if (repo === null) {
      sendNotFound(res, requestId);
      return;
    }
    const tail = segments.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo), requestId);
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        const patched = store.patchRepo(repo.databaseId, {
          description: typeof body.description === 'string' ? body.description : undefined,
          private: typeof body.private === 'boolean' ? body.private : undefined,
        });
        sendJson(res, 200, repoJson(patched), requestId);
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo.databaseId);
        sendNoContent(res, requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }
    await routeRepoSubresource(req, res, store, url, repo, tail, method, requestId);
    return;
  }

  sendNotFound(res, requestId);
}

async function routeRepoSubresource(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  url: URL,
  repo: Repo,
  tail: string[],
  method: string,
  requestId: string,
): Promise<void> {
  const query = url.searchParams;
  const sub = tail[0];
  const subTail = tail.slice(1);
  const repoId = repo.databaseId;

  if (sub === 'branches' && subTail.length === 0) {
    if (method !== 'GET') {
      sendNotFound(res, requestId);
      return;
    }
    const heads = store.listHeads(repoId);
    sendJson(
      res,
      200,
      heads.map((ref) => ({
        name: ref.name.replace(/^refs\/heads\//, ''),
        commit: { sha: ref.oid },
      })),
      requestId,
    );
    return;
  }

  if (sub === 'commits' && subTail.length === 0) {
    if (method !== 'GET') {
      sendNotFound(res, requestId);
      return;
    }
    const ref = query.get('sha') ?? repo.defaultBranch;
    const history = store.commitHistory(repoId, ref);
    sendJson(
      res,
      200,
      history.map((info) => ({
        sha: info.oid,
        commit: {
          message: stripOneTrailingNewline(info.message),
          author: {
            name: info.authorName,
            email: info.authorEmail,
            date: new Date(info.authorEpoch * 1000).toISOString(),
          },
          committer: {
            name: info.committerName,
            email: info.committerEmail,
            date: new Date(info.committerEpoch * 1000).toISOString(),
          },
        },
      })),
      requestId,
    );
    return;
  }

  if (sub === 'contents') {
    const path = subTail.join('/');
    if (path === '') {
      sendNotFound(res, requestId);
      return;
    }
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      const file = store.getFileAtRef(repoId, ref, path);
      if (file !== null) {
        sendJson(
          res,
          200,
          {
            type: 'file',
            encoding: 'base64',
            size: file.content.length,
            name: path.split('/').pop() ?? path,
            path,
            content: file.content.toString('base64'),
            sha: file.blobOid,
          },
          requestId,
        );
        return;
      }
      const entries = store.listDirectoryAtRef(repoId, ref, path);
      if (entries === null || entries.length === 0) {
        sendNotFound(res, requestId);
        return;
      }
      sendJson(
        res,
        200,
        entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: `${path}/${entry.name}`,
          sha: entry.oid,
        })),
        requestId,
      );
      return;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      if (typeof body.content !== 'string') {
        sendJson(res, 422, { message: 'content is required' }, requestId);
        return;
      }
      const content = Buffer.from(body.content, 'base64');
      const result = store.applyContentsPut({
        repoDatabaseId: repoId,
        branch: asString(body.branch, ''),
        path,
        content,
        message: asString(body.message, ''),
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      sendJson(
        res,
        result.status,
        {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: result.blobSha,
            size: content.length,
            encoding: 'base64',
            type: 'file',
          },
          commit: { sha: result.commitSha },
        },
        requestId,
      );
      return;
    }
    if (method === 'DELETE') {
      const body = await readJsonBody(req);
      const result = store.applyContentsDelete({
        repoDatabaseId: repoId,
        branch: asString(body.branch, ''),
        path,
        message: asString(body.message, ''),
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      sendJson(res, 200, { commit: { sha: result.commitSha } }, requestId);
      return;
    }
    sendNotFound(res, requestId);
    return;
  }

  if (sub === 'labels' && subTail.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const label = store.createLabel(repoId, {
        name: asString(body.name, ''),
        color: asString(body.color, ''),
      });
      sendJson(res, 201, labelJson(label), requestId);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, store.listLabels(repoId).map((label) => labelJson(label)), requestId);
      return;
    }
    sendNotFound(res, requestId);
    return;
  }

  if (sub === 'issues') {
    if (subTail.length === 0) {
      if (method === 'GET') {
        const state = query.get('state');
        const filter: { state?: IssueState; sort?: 'created'; direction?: 'asc' | 'desc' } = {};
        if (state === 'open' || state === 'closed') filter.state = state;
        if (query.get('sort') === 'created') filter.sort = 'created';
        const direction = query.get('direction');
        if (direction === 'asc' || direction === 'desc') filter.direction = direction;
        const params = pageParams(query);
        const page = paginate(store.listIssues(repoId, filter), params);
        sendJson(
          res,
          200,
          page.items.map((issue) => issueJson(store, issue)),
          requestId,
          linkHeaders(req, url, query, params.page, params.perPage, page.totalPages),
        );
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const labels = body.labels === undefined ? [] : asStringArray(body.labels);
        if (labels === null) {
          sendJson(res, 422, { message: 'labels must be an array of strings' }, requestId);
          return;
        }
        const issue = store.createIssue(repoId, {
          title: asString(body.title, ''),
          body: asString(body.body, ''),
          labels,
        });
        sendJson(res, 201, issueJson(store, issue), requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }
    const issueNumber = parseNumber(subTail[0]);
    if (issueNumber === null) {
      sendNotFound(res, requestId);
      return;
    }
    if (subTail.length === 1) {
      if (method === 'GET') {
        const issue = store.getIssue(repoId, issueNumber);
        if (issue === null) {
          sendNotFound(res, requestId);
          return;
        }
        sendJson(res, 200, issueJson(store, issue), requestId);
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        const patch: { title?: string; body?: string; labels?: string[]; state?: IssueState } = {};
        if (typeof body.title === 'string') patch.title = body.title;
        if (typeof body.body === 'string') patch.body = body.body;
        if (body.labels !== undefined) {
          const labels = asStringArray(body.labels);
          if (labels === null) {
            sendJson(res, 422, { message: 'labels must be an array of strings' }, requestId);
            return;
          }
          patch.labels = labels;
        }
        if (body.state !== undefined) {
          if (body.state !== 'open' && body.state !== 'closed') {
            sendJson(res, 422, { message: 'invalid issue state' }, requestId);
            return;
          }
          patch.state = body.state;
        }
        const issue = store.updateIssue(repoId, issueNumber, patch);
        sendJson(res, 200, issueJson(store, issue), requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }
    if (subTail.length === 2 && subTail[1] === 'comments') {
      if (method === 'GET') {
        const issue = store.getIssue(repoId, issueNumber);
        if (issue === null) {
          sendNotFound(res, requestId);
          return;
        }
        sendJson(
          res,
          200,
          store.listComments(repoId, issueNumber).map((comment) => commentJson(comment)),
          requestId,
        );
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const comment = store.addComment(repoId, issueNumber, asString(body.body, ''));
        sendJson(res, 201, commentJson(comment), requestId);
        return;
      }
    }
    sendNotFound(res, requestId);
    return;
  }

  if (sub === 'pulls') {
    if (subTail.length === 0) {
      if (method === 'GET') {
        const state = query.get('state');
        const filterState: PullRequestState | 'all' =
          state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open';
        const params = pageParams(query);
        const page = paginate(store.listPullRequests(repoId, { state: filterState }), params);
        sendJson(
          res,
          200,
          page.items.map((pr) => pullRequestJson(pr)),
          requestId,
          linkHeaders(req, url, query, params.page, params.perPage, page.totalPages),
        );
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const pr = store.createPullRequest(repoId, {
          head: asString(body.head, ''),
          base: asString(body.base, ''),
          title: asString(body.title, ''),
          body: asString(body.body, ''),
        });
        sendJson(res, 201, pullRequestJson(pr), requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }
    const prNumber = parseNumber(subTail[0]);
    if (prNumber === null) {
      sendNotFound(res, requestId);
      return;
    }
    if (subTail.length === 1) {
      if (method === 'GET') {
        const pr = store.getPullRequest(repoId, prNumber);
        if (pr === null) {
          sendNotFound(res, requestId);
          return;
        }
        sendJson(res, 200, pullRequestJson(pr), requestId);
        return;
      }
      sendNotFound(res, requestId);
      return;
    }
    if (subTail.length === 2 && subTail[1] === 'files') {
      if (method !== 'GET') {
        sendNotFound(res, requestId);
        return;
      }
      const pr = store.getPullRequest(repoId, prNumber);
      if (pr === null) {
        sendNotFound(res, requestId);
        return;
      }
      const files = store.computeChangedFiles(repoId, pr.baseSha, pr.headSha);
      sendJson(
        res,
        200,
        files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        })),
        requestId,
      );
      return;
    }
    if (subTail.length === 2 && subTail[1] === 'merge') {
      if (method !== 'PUT') {
        sendNotFound(res, requestId);
        return;
      }
      const body = await readJsonBody(req);
      const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : undefined;
      const outcome = store.squashMergePullRequest(
        repoId,
        prNumber,
        mergeMethod === undefined ? undefined : { mergeMethod },
      );
      if (!outcome.ok) {
        sendJson(res, 405, { message: outcome.message }, requestId);
        return;
      }
      sendJson(res, 200, { merged: true, sha: outcome.mergeCommitSha, message: outcome.message }, requestId);
      return;
    }
    sendNotFound(res, requestId);
    return;
  }

  if (sub === 'git' && subTail.length === 1 && subTail[0] === 'refs') {
    if (method !== 'POST') {
      sendNotFound(res, requestId);
      return;
    }
    const body = await readJsonBody(req);
    const ref = store.createRef(repoId, asString(body.ref, ''), asString(body.sha, ''));
    sendJson(res, 201, { ref: ref.name, object: { sha: ref.oid } }, requestId);
    return;
  }

  sendNotFound(res, requestId);
}
