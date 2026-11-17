// mcp.ts — MCP (POST /mcp, DELETE /mcp) untuk forge github-core-clone-01.
//
// Transport: JSON-RPC 2.0 Streamable HTTP, era MODERN 2026-07-28.
// server/discover menjawab result dengan supportedVersions tak kosong —
// JANGAN pernah menjawabnya dengan 5xx/-32601/404 (itu mematikan connect()
// klien tanpa fallback). Handshake legacy (initialize +
// notifications/initialized + Mcp-Session-Id) juga diterima.
// tools/list adalah konstanta (byte-identik antar panggilan). Keenam tool
// kanonik github-mcp-server, argumen persis kontrak, sinonim + full_name
// "owner/repo" didukung, prefix server pada nama tool dicocokkan sebagai
// suffix case-insensitive.
//
// Semua tulis/baca state lewat Store (method yang sama dengan REST).
// Lookup repo/issue memakai method Store dulu, dengan fallback membaca Map
// publik Store bila method itu masih stub.
//
// Aturan determinisme: tanpa Date.now()/Math.random()/UUID; id JSON-RPC
// di-echo dari request itu sendiri (tanpa state modul).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const PREFERRED_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS: string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** Daftar tool adalah KONSTANTA — jangan pernah dimutasi — supaya dua
 *  panggilan tools/list byte-identik (JSON.stringify sama persis). */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'Owner login of the new repository.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

const TOOL_REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

// ---------------------------------------------------------------------------
// HTTP + JSON-RPC helpers
// ---------------------------------------------------------------------------

function isAuthorized(req: IncomingMessage, ctx: { token: string }): boolean {
  const expected = ctx.token;
  if (!expected) return false;
  return req.headers.authorization === `Bearer ${expected}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error.';
}

// ---------------------------------------------------------------------------
// Akses Store (method dulu, fallback Map publik bila masih stub)
// ---------------------------------------------------------------------------

function viewerLogin(store: Store): string {
  try {
    const user = store.getViewerUser();
    if (user && user.login) return user.login;
  } catch {
    // getViewerUser melempar bila login belum terikat.
  }
  const login = store.getViewerLogin();
  if (login) return login;
  try {
    for (const repo of store.listAllRepos()) {
      if (repo.owner) return repo.owner;
    }
  } catch {
    // listAllRepos masih stub.
  }
  for (const repo of store.repos.values()) {
    if (repo.owner) return repo.owner;
  }
  return '';
}

function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (!owner || !name) return null;
  try {
    const repo = store.getRepoByOwnerAndName(owner, name);
    if (repo) return repo;
  } catch {
    // Method masih stub — lanjut ke lookup longgar.
  }
  let loose: Repo | null = null;
  try {
    loose = store.findRepoByName(name);
  } catch {
    // findRepoByName masih stub — scan Map langsung.
  }
  if (!loose) {
    for (const repo of store.repos.values()) {
      if (repo.name === name && (!loose || repo.databaseId < loose.databaseId)) loose = repo;
    }
  }
  if (!loose) return null;
  if (loose.owner !== '' && loose.owner !== owner) return null;
  if (loose.owner === '') {
    try {
      return store.bindOwner(loose.databaseId, owner);
    } catch {
      loose.owner = owner;
      if (!store.viewerLogin) store.viewerLogin = owner;
      return loose;
    }
  }
  return loose;
}

function listIssuesForRepo(store: Store, repoDatabaseId: number): Issue[] {
  try {
    const result = store.listIssues(repoDatabaseId, { sort: 'created', direction: 'asc' });
    if (Array.isArray(result)) return result;
  } catch {
    // listIssues masih stub — baca Map langsung.
  }
  const map = store.issues.get(repoDatabaseId);
  const all = map ? [...map.values()] : [];
  return all.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
}

// ---------------------------------------------------------------------------
// Pencocokan nama tool + normalisasi argumen
// ---------------------------------------------------------------------------

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Cocok persis (kanonik/alias), lalu suffix — prefix server diizinkan,
 *  mis. "github__create_issue" cocok dengan "create_issue". */
function matchTool(requested: string): string | null {
  const norm = normalizeToolName(requested);
  for (const tool of TOOLS) {
    const candidates = [tool.name, ...(TOOL_ALIASES[tool.name] ?? [])];
    for (const candidate of candidates) {
      const canon = normalizeToolName(candidate);
      if (norm === canon || norm.endsWith(canon)) return tool.name;
    }
  }
  return null;
}

function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function argString(args: Record<string, unknown>, names: string[]): string | undefined {
  const value = pickArg(args, names);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function splitFullName(value: string | undefined): { owner?: string; repo?: string } {
  if (!value) return {};
  const idx = value.indexOf('/');
  if (idx <= 0) return { repo: value };
  return { owner: value.slice(0, idx), repo: value.slice(idx + 1) };
}

/** Petakan argumen mentah ke nama kanonik kontrak github-mcp-server,
 *  memakai daftar sinonim suite (spec/graphql-mcp.md B.4). */
function normalizeArgs(canonical: string, raw: Record<string, unknown>): Record<string, unknown> {
  void canonical;
  const out: Record<string, unknown> = {};
  const fullName = argString(raw, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  const fromFull = splitFullName(fullName);
  const owner =
    argString(raw, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']) ??
    fromFull.owner;
  const repo =
    argString(raw, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']) ??
    fromFull.repo;
  if (owner !== undefined) out.owner = owner;
  if (repo !== undefined) out.repo = repo;
  if (fullName !== undefined) out.full_name = fullName;
  const name = argString(raw, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
  if (name !== undefined) out.name = name;
  const title = argString(raw, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (title !== undefined) out.title = title;
  const body = argString(raw, ['body', 'issue_body', 'description', 'content', 'text', 'comment']);
  if (body !== undefined) out.body = body;
  const description = argString(raw, ['description', 'about', 'summary', 'body']);
  if (description !== undefined) out.description = description;
  const head = argString(raw, [
    'head',
    'head_ref',
    'head_branch',
    'pull_request_head',
    'pr_head',
    'source',
    'source_ref',
    'source_branch',
    'from',
    'from_branch',
    'branch',
  ]);
  if (head !== undefined) out.head = head;
  const base = argString(raw, [
    'base',
    'base_ref',
    'base_branch',
    'pull_request_base',
    'pr_base',
    'target',
    'target_ref',
    'target_branch',
    'into',
    'into_branch',
  ]);
  if (base !== undefined) out.base = base;
  const pullNumber = pickArg(raw, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (pullNumber !== undefined) out.pull_number = pullNumber;
  const state = argString(raw, ['state', 'status']);
  if (state !== undefined) out.state = state;
  const priv = pickArg(raw, ['private', 'is_private']);
  if (priv !== undefined) out.private = priv;
  return out;
}

function parsePullNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const n = parseInt(value, 10);
    if (n >= 1) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Eksekusi tool
// ---------------------------------------------------------------------------

interface ToolOutcome {
  payload: unknown;
  isError: boolean;
}

function errorOutcome(message: string): ToolOutcome {
  return { payload: { error: message }, isError: true };
}

function repoPayload(store: Store, repo: Repo): Record<string, unknown> {
  const ownerLogin = repo.owner || viewerLogin(store);
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: ownerLogin ? `${ownerLogin}/${repo.name}` : repo.name,
    owner: { login: ownerLogin },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function executeTool(store: Store, canonical: string, args: Record<string, unknown>): ToolOutcome {
  if (canonical === 'create_repo') {
    const name = String(args.name ?? '');
    const description = typeof args.description === 'string' ? args.description : '';
    const priv = args.private === true || args.private === 'true';
    let repo: Repo;
    try {
      repo = store.createRepo({ name, description, private: priv });
    } catch (e) {
      return errorOutcome(messageOf(e));
    }
    const ownerArg = typeof args.owner === 'string' ? args.owner : undefined;
    if (ownerArg && repo.owner === '') {
      try {
        store.bindOwner(repo.databaseId, ownerArg);
      } catch {
        repo.owner = ownerArg;
      }
    }
    return { payload: repoPayload(store, repo), isError: false };
  }

  if (canonical === 'get_repo') {
    const repo = findRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
    if (!repo) return errorOutcome(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found.`);
    return { payload: repoPayload(store, repo), isError: false };
  }

  if (canonical === 'create_issue') {
    const repo = findRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
    if (!repo) return errorOutcome(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found.`);
    const title = String(args.title ?? '');
    const body = typeof args.body === 'string' ? args.body : '';
    let issue: Issue;
    try {
      issue = store.createIssue(repo.databaseId, { title, body, labels: [] });
    } catch (e) {
      return errorOutcome(messageOf(e));
    }
    return {
      payload: {
        id: store.globalIdForIssue(issue),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        repository: { full_name: `${repo.owner}/${repo.name}` },
      },
      isError: false,
    };
  }

  if (canonical === 'list_issues') {
    const repo = findRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
    if (!repo) return errorOutcome(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found.`);
    const stateRaw = typeof args.state === 'string' ? args.state.toLowerCase() : undefined;
    let issues = listIssuesForRepo(store, repo.databaseId);
    if (stateRaw === 'open' || stateRaw === 'closed') {
      issues = issues.filter((issue) => issue.state === stateRaw);
    }
    issues = [...issues].sort((a, b) => a.number - b.number);
    return {
      payload: {
        issues: issues.map((issue) => ({
          id: store.globalIdForIssue(issue),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        })),
      },
      isError: false,
    };
  }

  if (canonical === 'create_pull_request') {
    const repo = findRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
    if (!repo) return errorOutcome(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found.`);
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    const title = String(args.title ?? '');
    const body = typeof args.body === 'string' ? args.body : '';
    let pr: PullRequest;
    try {
      pr = store.createPullRequest(repo.databaseId, { head, base, title, body });
    } catch (e) {
      return errorOutcome(messageOf(e));
    }
    return {
      payload: {
        id: store.globalIdForPullRequest(pr),
        number: pr.number,
        pull_number: pr.number,
        title: pr.title,
        body: pr.body,
        state: 'open',
        head,
        base,
        head_ref: head,
        base_ref: base,
        head_sha: pr.headSha,
        base_sha: pr.baseSha,
      },
      isError: false,
    };
  }

  if (canonical === 'merge_pull_request') {
    const repo = findRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
    if (!repo) return errorOutcome(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found.`);
    const pullNumber = parsePullNumber(args.pull_number);
    if (pullNumber === null) return errorOutcome('pull_number must be a positive integer.');
    let outcome;
    try {
      outcome = store.squashMergePullRequest(repo.databaseId, pullNumber, { mergeMethod: 'squash' });
    } catch (e) {
      return errorOutcome(messageOf(e));
    }
    if (!outcome || !outcome.ok) {
      return { payload: { error: outcome?.message ?? 'Merge failed.', conflicts: outcome?.conflicts ?? [] }, isError: true };
    }
    return {
      payload: {
        number: pullNumber,
        pull_number: pullNumber,
        merged: true,
        state: 'closed',
        sha: outcome.mergeCommitSha,
        message: outcome.message,
      },
      isError: false,
    };
  }

  return errorOutcome(`Unknown tool: ${canonical}`);
}

function toolResult(outcome: ToolOutcome): Record<string, unknown> {
  const text = typeof outcome.payload === 'string' ? outcome.payload : JSON.stringify(outcome.payload);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: outcome.payload,
  };
  if (outcome.isError) result.isError = true;
  return result;
}

function discoverResult(): Record<string, unknown> {
  return {
    protocolVersion: PREFERRED_VERSION,
    supportedVersions: [...SUPPORTED_VERSIONS],
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: { tools: {} },
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
    },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Menangani POST /mcp (+ DELETE /mcp penutup sesi). Mengembalikan true bila
 *  request ditangani (termasuk 401/400), false bila path/method bukan milik
 *  handler ini. */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx: { token: string },
): Promise<boolean> {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  if (pathname !== '/mcp' && pathname !== '/mcp/') return false;
  if (req.method === 'DELETE') {
    // Penutup sesi (best-effort dari klien; era modern tidak memakai sesi).
    sendJson(res, 200, {});
    return true;
  }
  if (req.method !== 'POST') return false;

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Body bukan JSON = HTTP 400 + JSON-RPC -32700. Coba selamatkan id.
    let requestId: unknown = null;
    const match = /"id"\s*:\s*(-?[0-9]+|"[^"\\]*(?:\\.[^"\\]*)*")/.exec(raw);
    if (match) {
      try {
        requestId = JSON.parse(match[1]);
      } catch {
        requestId = null;
      }
    }
    sendJson(res, 400, rpcError(requestId, -32700, 'Parse error'));
    return true;
  }

  // Auth diputuskan sebelum tool di-resolve: 401 wajib keluar walau nama
  // tool tidak ada.
  if (!isAuthorized(req, ctx)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }

  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 200, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const request = parsed as Record<string, unknown>;
  const hasId = 'id' in request && request.id !== undefined && request.id !== null;
  const id: unknown = hasId ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';

  if (!hasId) {
    // Notifikasi (mis. notifications/initialized): terima diam-diam.
    res.writeHead(202);
    res.end();
    return true;
  }

  const params = (request.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover': {
      sendJson(res, 200, rpcResult(id, discoverResult()));
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const version =
        requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PREFERRED_VERSION;
      sendJson(
        res,
        200,
        rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
      return true;
    }
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}));
      return true;
    }
    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const rawArgs = (params.arguments ?? {}) as Record<string, unknown>;
      if (!name) {
        sendJson(res, 200, rpcError(id, -32602, 'Missing required argument: name'));
        return true;
      }
      const canonical = matchTool(name);
      if (!canonical) {
        sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
        return true;
      }
      const args = normalizeArgs(canonical, rawArgs);
      const required = TOOL_REQUIRED[canonical] ?? [];
      for (const prop of required) {
        const value = args[prop];
        if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
          sendJson(res, 200, rpcError(id, -32602, `Missing required argument: ${prop}`));
          return true;
        }
        if (prop === 'pull_number' && parsePullNumber(value) === null) {
          sendJson(res, 200, rpcError(id, -32602, 'Missing required argument: pull_number'));
          return true;
        }
      }
      let outcome: ToolOutcome;
      try {
        outcome = executeTool(store, canonical, args);
      } catch (e) {
        sendJson(res, 200, rpcError(id, -32602, messageOf(e)));
        return true;
      }
      sendJson(res, 200, rpcResult(id, toolResult(outcome)));
      return true;
    }
    default: {
      // Method tak dikenal — JANGAN 5xx/404: -32601 (klien bisa fallback legacy).
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return true;
    }
  }
}
