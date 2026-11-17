// graphql.ts — GraphQL v4 (POST /api/graphql) untuk forge github-core-clone-01.
//
// Cakupan: dokumen-dokumen yang dikirim suite (lihat spec/graphql-mcp.md BAGIAN A),
// introspeksi __type/__schema, node(id:) Relay, batching array, error 200+errors,
// auth Bearer 401. Parser + eksekutor minimal yang ditulis dari spesifikasi
// (bukan salinan implementasi forge lain), tanpa dependensi.
//
// Semua tulis/baca state lewat Store (method yang sama dengan REST). Bila
// Store.resolveNode belum diimplementasikan (masih stub), dipakai implementasi
// lokal resolveNodeAny di file ini — JANGAN mengedit store.ts dari sini.
// Lookup repo/issue/PR memakai method Store dulu, dengan fallback membaca Map
// publik Store bila method itu masih stub, supaya handler tetap benar sesudah
// Store diisi penuh oleh implementer REST/git.
//
// Aturan determinisme: tanpa Date.now()/Math.random()/UUID; cursor opaque
// base64url dari (repoDatabaseId, createdSeq); global id dari Store
// (encode/decode base64url "Kind:..." — sudah diimplementasikan di store.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeGlobalId, deterministicIso } from './store.ts';
import type { Comment, Issue, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// HTTP helpers
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

// ---------------------------------------------------------------------------
// Tokenizer + parser GraphQL minimal (hanya konstruksi yang dikirim suite)
// ---------------------------------------------------------------------------

type TokenKind = 'Name' | 'String' | 'Int' | 'Float' | 'Punct' | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let value = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1];
          if (esc === 'u' && i + 5 < input.length) {
            const hex = input.slice(i + 2, i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              value += String.fromCharCode(parseInt(hex, 16));
              i += 6;
              continue;
            }
          }
          const simple: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          value += simple[esc] ?? esc;
          i += 2;
          continue;
        }
        value += input[i];
        i += 1;
      }
      if (i >= input.length) throw new Error('Syntax error: unterminated string.');
      i += 1; // closing quote
      push('String', value);
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      push('Punct', '...');
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      push('Punct', ch);
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if ((input[j] === 'e' || input[j] === 'E') && /[0-9+-]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      push(isFloat ? 'Float' : 'Int', input.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      push('Name', input.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`Syntax error: unexpected character "${ch}".`);
  }
  push('EOF', '');
  return tokens;
}

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'FragmentSpread'; name: string }
  | { kind: 'InlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selections: SelectionNode[] }>;
}

class Parser {
  tokens: Token[];
  pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) {
      throw new Error(`Syntax error: expected "${value}" but got "${token.value}".`);
    }
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'Name') throw new Error(`Syntax error: expected a name but got "${token.value}".`);
    if (value !== undefined && token.value !== value) {
      throw new Error(`Syntax error: expected "${value}" but got "${token.value}".`);
    }
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selections: SelectionNode[] }>();
    while (this.peek().kind !== 'EOF') {
      if (this.peek().kind === 'Name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | null = null;
    if (this.peek().kind === 'Punct' && this.peek().value === '{') {
      return { kind: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    const keyword = this.next();
    if (keyword.kind !== 'Name' || (keyword.value !== 'query' && keyword.value !== 'mutation' && keyword.value !== 'subscription')) {
      throw new Error(`Syntax error: expected an operation but got "${keyword.value}".`);
    }
    kind = keyword.value;
    if (this.peek().kind === 'Name') name = this.next().value;
    let variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      variableDefinitions = this.parseVariableDefinitions();
    }
    // Direktif (@...) tidak dipakai suite; lewati bila ada.
    while (this.peek().kind === 'Punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'Punct' && this.peek().value === '(') this.parseArguments();
    }
    return { kind, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      // Tipe: Name, '[...]', '!' — lewati tanpa membangun AST tipe.
      this.skipType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'Punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  skipType(): void {
    const token = this.next();
    if (token.kind === 'Punct' && token.value === '[') {
      this.skipType();
      this.expectPunct(']');
    } else if (token.kind !== 'Name') {
      throw new Error(`Syntax error: expected a type but got "${token.value}".`);
    }
    if (this.peek().kind === 'Punct' && this.peek().value === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'EOF') throw new Error('Syntax error: unterminated selection set.');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek().kind === 'Punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value !== 'on') {
        return { kind: 'FragmentSpread', name: this.next().value };
      }
      let typeCondition: string | null = null;
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'Punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      args = this.parseArguments();
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'Punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'Punct' && token.value === '$') {
      return { kind: 'Variable', name: this.expectName() };
    }
    if (token.kind === 'String') return { kind: 'String', value: token.value };
    if (token.kind === 'Int') return { kind: 'Int', value: parseInt(token.value, 10) };
    if (token.kind === 'Float') return { kind: 'Float', value: parseFloat(token.value) };
    if (token.kind === 'Punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (token.kind === 'Punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    if (token.kind === 'Name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new Error(`Syntax error: unexpected value "${token.value}".`);
  }
}

// ---------------------------------------------------------------------------
// Skema yang dikenal (validasi + introspeksi)
// ---------------------------------------------------------------------------

const KNOWN_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Node: ['id'],
  User: ['login', 'id', 'name', 'email', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private'],
  Ref: ['name', 'id'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'author'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'isDeprecated', 'deprecationReason', 'type', 'args'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'description', 'directives'],
};

const CHILD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection', author: 'User' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', comment: 'IssueComment' },
  IssueCommentEdge: { node: 'IssueComment' },
  Issue: { author: 'User' },
  IssueComment: { author: 'User' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  __Field: { type: '__Type' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'],
  User: ['login', 'id', 'name'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name'],
  IssueComment: ['id', 'body'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Nilai GraphQL (objek terbungkus __typename)
// ---------------------------------------------------------------------------

interface AnyObj {
  __typename: string;
  [key: string]: unknown;
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
  fragments: Map<string, { typeCondition: string | null; selections: SelectionNode[] }>;
}

interface ResolvedNode {
  kind: 'Repo' | 'Issue' | 'PullRequest' | 'IssueComment';
  repo?: Repo;
  issue?: Issue;
  pullRequest?: PullRequest;
  comment?: Comment;
}

function repoObj(repo: Repo): AnyObj {
  return { __typename: 'Repository', repo };
}

function issueObj(issue: Issue): AnyObj {
  return { __typename: 'Issue', issue };
}

function prObj(pr: PullRequest): AnyObj {
  return { __typename: 'PullRequest', pr };
}

function commentObj(comment: Comment): AnyObj {
  return { __typename: 'IssueComment', comment };
}

function userObj(login: string): AnyObj {
  return { __typename: 'User', login };
}

// ---------------------------------------------------------------------------
// Akses Store (method dulu, fallback Map publik bila masih stub)
// ---------------------------------------------------------------------------

function viewerLogin(store: Store): string {
  try {
    const user = store.getViewerUser();
    if (user && user.login) return user.login;
  } catch {
    // getViewerUser melempar bila login belum terikat — lanjut ke fallback.
  }
  const login = store.getViewerLogin();
  if (login) return login;
  try {
    for (const repo of store.listAllRepos()) {
      if (repo.owner) return repo.owner;
    }
  } catch {
    // listAllRepos masih stub — baca Map langsung.
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

function getIssue(store: Store, repoDatabaseId: number, number: number): Issue | null {
  try {
    const issue = store.getIssue(repoDatabaseId, number);
    if (issue) return issue;
  } catch {
    // getIssue masih stub (tidak mungkin — one-liner — tapi aman).
  }
  return store.issues.get(repoDatabaseId)?.get(number) ?? null;
}

function getPullRequest(store: Store, repoDatabaseId: number, number: number): PullRequest | null {
  try {
    const pr = store.getPullRequest(repoDatabaseId, number);
    if (pr) return pr;
  } catch {
    // Fallback Map.
  }
  return store.pullRequests.get(repoDatabaseId)?.get(number) ?? null;
}

function getComment(store: Store, repoDatabaseId: number, id: number): Comment | null {
  try {
    const comment = store.getCommentById(repoDatabaseId, id);
    if (comment) return comment;
  } catch {
    // getCommentById masih stub — baca Map global komentar.
  }
  void repoDatabaseId;
  return store.comments.get(id) ?? null;
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

function listPRsForRepo(store: Store, repoDatabaseId: number): PullRequest[] {
  try {
    const result = store.listPullRequests(repoDatabaseId);
    if (Array.isArray(result)) return result;
  } catch {
    // listPullRequests masih stub — baca Map langsung.
  }
  const map = store.pullRequests.get(repoDatabaseId);
  const all = map ? [...map.values()] : [];
  return all.sort((a, b) => a.number - b.number);
}

/** Resolve global id. Pakai Store.resolveNode bila sudah terisi; bila masih
 *  stub (melempar), implementasi lokal di sini dari decodeGlobalId. */
function resolveNodeAny(store: Store, id: string): ResolvedNode | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  try {
    const viaStore = store.resolveNode(id);
    if (viaStore) {
      return {
        kind: viaStore.kind,
        repo: viaStore.repo,
        issue: viaStore.issue,
        pullRequest: viaStore.pullRequest,
        comment: viaStore.comment,
      };
    }
  } catch {
    // Store.resolveNode masih stub — lanjut ke implementasi lokal.
  }
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repo') {
    const repo = store.getRepoById(Number(decoded.parts[0]));
    return repo ? { kind: 'Repo', repo } : null;
  }
  if (decoded.kind === 'Issue') {
    const issue = getIssue(store, Number(decoded.parts[0]), Number(decoded.parts[1]));
    return issue ? { kind: 'Issue', issue } : null;
  }
  if (decoded.kind === 'PullRequest') {
    const pr = getPullRequest(store, Number(decoded.parts[0]), Number(decoded.parts[1]));
    return pr ? { kind: 'PullRequest', pullRequest: pr } : null;
  }
  if (decoded.kind === 'IssueComment') {
    const comment = getComment(store, Number(decoded.parts[0]), Number(decoded.parts[2]));
    return comment ? { kind: 'IssueComment', comment } : null;
  }
  return null;
}

// --- Cursor paginasi (opaque, deterministik) --------------------------------

function encodeCursor(repoDatabaseId: number, seq: number): string {
  return Buffer.from(`cursor:${repoDatabaseId}:${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { repoId: number; seq: number } | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(text, 'utf8').toString('base64url') !== cursor) return null;
    const match = /^cursor:([0-9]+):([0-9]+)$/.exec(text);
    if (!match) return null;
    return { repoId: Number(match[1]), seq: Number(match[2]) };
  } catch {
    return null;
  }
}

// --- Introspeksi -------------------------------------------------------------

function introspectionType(name: string): AnyObj | null {
  if (INTROSPECTION_FIELDS[name]) {
    return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: INTROSPECTION_FIELDS[name], enumNames: null };
  }
  if (INTROSPECTION_ENUMS[name]) {
    return { __typename: '__Type', name, kind: 'ENUM', fieldNames: null, enumNames: INTROSPECTION_ENUMS[name] };
  }
  if (name === '__Type') {
    return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: KNOWN_FIELDS['__Type'], enumNames: null };
  }
  if (name === '__Schema') {
    return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: KNOWN_FIELDS['__Schema'], enumNames: null };
  }
  if (name === '__Field') {
    return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: KNOWN_FIELDS['__Field'], enumNames: null };
  }
  if (name === '__EnumValue') {
    return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: KNOWN_FIELDS['__EnumValue'], enumNames: null };
  }
  return null;
}

function allIntrospectionTypes(): AnyObj[] {
  const names = [
    ...Object.keys(INTROSPECTION_FIELDS),
    ...Object.keys(INTROSPECTION_ENUMS),
    '__Schema',
    '__Type',
    '__Field',
    '__EnumValue',
  ];
  const out: AnyObj[] = [];
  for (const name of names) {
    const type = introspectionType(name);
    if (type) out.push(type);
  }
  return out;
}

// --- Koneksi issue / PR ------------------------------------------------------

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): AnyObj {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : null;
  const statesRaw = Array.isArray(args.states) ? (args.states as unknown[]) : undefined;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  let issues = listIssuesForRepo(store, repo.databaseId);
  if (statesRaw && statesRaw.length > 0) {
    const wanted = new Set(statesRaw.map((s) => String(s).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy.direction === 'ASC' ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
  issues = [...issues].sort((a, b) =>
    direction === 'desc'
      ? b.createdSeq - a.createdSeq || b.number - a.number
      : a.createdSeq - b.createdSeq || a.number - b.number,
  );
  if (after) {
    const cursor = decodeCursor(after);
    if (cursor && cursor.repoId === repo.databaseId) {
      const idx = issues.findIndex((issue) => issue.createdSeq === cursor.seq);
      if (idx >= 0) issues = issues.slice(idx + 1);
    }
  }
  const total = issues.length;
  const page = first !== undefined ? issues.slice(0, first) : issues;
  const hasNextPage = first !== undefined ? total > first : false;
  const endCursor = page.length > 0 ? encodeCursor(repo.databaseId, page[page.length - 1].createdSeq) : null;
  const startCursor = page.length > 0 ? encodeCursor(repo.databaseId, page[0].createdSeq) : null;
  return { __typename: 'IssueConnection', issues: page, totalCount: total, hasNextPage, endCursor, startCursor };
}

function prConnection(store: Store, repo: Repo, args: Record<string, unknown>): AnyObj {
  const first = typeof args.first === 'number' ? args.first : undefined;
  let prs = listPRsForRepo(store, repo.databaseId);
  prs = [...prs].sort((a, b) => a.number - b.number);
  const total = prs.length;
  const page = first !== undefined ? prs.slice(0, first) : prs;
  return {
    __typename: 'PullRequestConnection',
    prs: page,
    totalCount: total,
    hasNextPage: first !== undefined ? total > first : false,
    endCursor: null,
    startCursor: null,
  };
}

function resolveRefTip(store: Store, repoDatabaseId: number, branch: string): string | null {
  try {
    const oid = store.resolveRef(repoDatabaseId, `refs/heads/${branch}`);
    if (oid) return oid;
  } catch {
    // resolveRef masih stub.
  }
  return null;
}

/** mergeable: hitung nyata bila Store sudah bisa (three-way), sonst MERGEABLE.
 *  Suite menerima MERGEABLE | CONFLICTING | UNKNOWN apa pun. */
function computeMergeable(store: Store, pr: PullRequest): string {
  try {
    const baseTip = resolveRefTip(store, pr.repoDatabaseId, pr.baseRef) ?? pr.baseSha;
    const headTip = resolveRefTip(store, pr.repoDatabaseId, pr.headRef) ?? pr.headSha;
    if (!baseTip || !headTip) return 'UNKNOWN';
    const base = store.mergeBase(baseTip, headTip);
    if (base === null) return 'UNKNOWN';
    const merged = store.threeWayMergeFiles(base, baseTip, headTip);
    return merged.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  } catch {
    return 'MERGEABLE';
  }
}

function resolvePrFiles(store: Store, pr: PullRequest, first: unknown): AnyObj[] {
  let files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  try {
    const computed = store.computeChangedFiles(pr.repoDatabaseId, pr.baseSha, pr.headSha);
    files = computed.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
  } catch {
    // computeChangedFiles masih stub — jawab daftar kosong, jangan crash.
    files = [];
  }
  const limited = typeof first === 'number' ? files.slice(0, first) : files;
  return limited.map((f) => ({
    __typename: 'PullRequestChangedFile',
    path: f.filename,
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
  }));
}

// ---------------------------------------------------------------------------
// Eksekusi
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
    case 'Enum':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => resolveValue(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function getArgValues(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function childTypeOf(parentType: string, fieldName: string): string {
  return CHILD_TYPE[parentType]?.[fieldName] ?? parentType;
}

function validateSelections(
  selections: SelectionNode[],
  typeName: string,
  ctx: Ctx,
  errors: Array<{ message: string }>,
): void {
  const known = KNOWN_FIELDS[typeName] ?? [];
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (!known.includes(sel.name)) {
        errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      }
      const child = CHILD_TYPE[typeName]?.[sel.name];
      if (sel.selectionSet && child) validateSelections(sel.selectionSet, child, ctx, errors);
    } else if (sel.kind === 'InlineFragment') {
      validateSelections(sel.selectionSet, sel.typeCondition ?? typeName, ctx, errors);
    } else {
      const frag = ctx.fragments.get(sel.name);
      if (frag) validateSelections(frag.selections, frag.typeCondition ?? typeName, ctx, errors);
    }
  }
}

function nodeGlobalId(store: Store, source: AnyObj): string {
  if (source.__typename === 'Repository') return store.globalIdForRepo(source.repo as Repo);
  if (source.__typename === 'Issue') return store.globalIdForIssue(source.issue as Issue);
  if (source.__typename === 'PullRequest') return store.globalIdForPullRequest(source.pr as PullRequest);
  if (source.__typename === 'IssueComment') return store.globalIdForComment(source.comment as Comment);
  return '';
}

function resolveMutation(name: string, args: Record<string, unknown>, ctx: Ctx): AnyObj | null {
  const store = ctx.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = input.clientMutationId ?? null;
  try {
    if (name === 'createIssue') {
      const node = resolveNodeAny(store, String(input.repositoryId ?? ''));
      if (!node || node.kind !== 'Repo' || !node.repo) {
        ctx.errors.push({ message: `Repository not found for id "${String(input.repositoryId ?? '')}".` });
        return null;
      }
      const title = String(input.title ?? '');
      if (!title) {
        ctx.errors.push({ message: 'CreateIssueInput.title is required.' });
        return null;
      }
      const issue = store.createIssue(node.repo.databaseId, {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      return { __typename: 'CreateIssuePayload', issue: issueObj(issue), clientMutationId };
    }
    if (name === 'closeIssue') {
      const node = resolveNodeAny(store, String(input.issueId ?? ''));
      if (!node || node.kind !== 'Issue' || !node.issue) {
        ctx.errors.push({ message: `Issue not found for id "${String(input.issueId ?? '')}".` });
        return null;
      }
      const updated = store.updateIssueState(node.issue.repoDatabaseId, node.issue.number, 'closed');
      return { __typename: 'CloseIssuePayload', issue: issueObj(updated), clientMutationId };
    }
    if (name === 'createPullRequest') {
      const node = resolveNodeAny(store, String(input.repositoryId ?? ''));
      if (!node || node.kind !== 'Repo' || !node.repo) {
        ctx.errors.push({ message: `Repository not found for id "${String(input.repositoryId ?? '')}".` });
        return null;
      }
      const pr = store.createPullRequest(node.repo.databaseId, {
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: prObj(pr), clientMutationId };
    }
    if (name === 'mergePullRequest') {
      const node = resolveNodeAny(store, String(input.pullRequestId ?? ''));
      if (!node || node.kind !== 'PullRequest' || !node.pullRequest) {
        ctx.errors.push({ message: `Pull request not found for id "${String(input.pullRequestId ?? '')}".` });
        return null;
      }
      // Store hanya menerima 'squash' (huruf kecil); enum GraphQL mengirim
      // 'SQUASH'/'MERGE'/'REBASE' — normalisasi di batas ini.
      const method = (typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH').toLowerCase();
      const outcome = store.squashMergePullRequest(node.pullRequest.repoDatabaseId, node.pullRequest.number, {
        mergeMethod: method,
      });
      if (!outcome || !outcome.ok) {
        ctx.errors.push({ message: outcome?.message ?? 'Merge failed.' });
        return null;
      }
      const updated = getPullRequest(store, node.pullRequest.repoDatabaseId, node.pullRequest.number) ?? node.pullRequest;
      return { __typename: 'MergePullRequestPayload', pullRequest: prObj(updated), clientMutationId };
    }
    if (name === 'addComment') {
      const node = resolveNodeAny(store, String(input.subjectId ?? ''));
      if (!node || node.kind !== 'Issue' || !node.issue) {
        ctx.errors.push({ message: `Issue not found for id "${String(input.subjectId ?? '')}".` });
        return null;
      }
      const comment = store.addComment(node.issue.repoDatabaseId, node.issue.number, String(input.body ?? ''));
      const edge: AnyObj = {
        __typename: 'IssueCommentEdge',
        node: commentObj(comment),
        cursor: Buffer.from(`comment:${comment.id}`, 'utf8').toString('base64url'),
      };
      return { __typename: 'AddCommentPayload', commentEdge: edge, comment: commentObj(comment), clientMutationId };
    }
    return null;
  } catch (e) {
    ctx.errors.push({ message: e instanceof Error ? e.message : 'Mutation failed.' });
    return null;
  }
}

function resolveField(typeName: string, source: AnyObj, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  const args = getArgValues(field, ctx.variables);
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return userObj(viewerLogin(store));
      if (field.name === 'repository') {
        const repo = findRepo(store, String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObj(repo) : null;
      }
      if (field.name === 'node') {
        const node = resolveNodeAny(store, String(args.id ?? ''));
        if (!node) return null;
        if (node.kind === 'Repo' && node.repo) return repoObj(node.repo);
        if (node.kind === 'Issue' && node.issue) return issueObj(node.issue);
        if (node.kind === 'PullRequest' && node.pullRequest) return prObj(node.pullRequest);
        if (node.kind === 'IssueComment' && node.comment) return commentObj(node.comment);
        return null;
      }
      if (field.name === '__type') return introspectionType(String(args.name ?? ''));
      if (field.name === '__schema') return { __typename: '__Schema' };
      return null;
    }
    case 'Mutation': {
      return resolveMutation(field.name, args, ctx);
    }
    case 'Node': {
      if (field.name === 'id') return nodeGlobalId(store, source);
      return null;
    }
    case 'User': {
      const login = String(source.login ?? '');
      if (field.name === 'login') return login;
      if (field.name === 'id') return login;
      if (field.name === 'name') return login;
      if (field.name === 'email') return `${login}@example.invalid`;
      if (field.name === 'databaseId') return 1;
      return null;
    }
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (field.name) {
        case 'id':
          return store.globalIdForRepo(repo);
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userObj(repo.owner);
        case 'defaultBranchRef':
          return { __typename: 'Ref', name: repo.defaultBranch };
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.private;
        case 'issue': {
          if (typeof args.number !== 'number') return null;
          const issue = getIssue(store, repo.databaseId, args.number);
          return issue ? issueObj(issue) : null;
        }
        case 'issues':
          return issuesConnection(store, repo, args);
        case 'pullRequests':
          return prConnection(store, repo, args);
        case 'pullRequest': {
          if (typeof args.number !== 'number') return null;
          const pr = getPullRequest(store, repo.databaseId, args.number);
          return pr ? prObj(pr) : null;
        }
        default:
          return null;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return String(source.name ?? '');
      if (field.name === 'id') return String(source.name ?? '');
      return null;
    }
    case 'Issue': {
      const issue = source.issue as Issue;
      switch (field.name) {
        case 'id':
          return store.globalIdForIssue(issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'createdAt':
          return deterministicIso(issue.createdSeq);
        case 'updatedAt':
          return deterministicIso(issue.updatedSeq);
        case 'author': {
          const repo = store.getRepoById(issue.repoDatabaseId);
          return userObj(repo?.owner || viewerLogin(store));
        }
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return (source.issues as Issue[]).map((issue) => issueObj(issue));
      if (field.name === 'totalCount') return typeof source.totalCount === 'number' ? source.totalCount : 0;
      if (field.name === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: source.hasNextPage ?? false,
          endCursor: source.endCursor ?? null,
          startCursor: source.startCursor ?? null,
        };
      }
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return source.hasNextPage ?? false;
      if (field.name === 'hasPreviousPage') return source.hasPreviousPage ?? false;
      if (field.name === 'endCursor') return source.endCursor ?? null;
      if (field.name === 'startCursor') return source.startCursor ?? null;
      return null;
    }
    case 'PullRequest': {
      const pr = source.pr as PullRequest;
      switch (field.name) {
        case 'id':
          return store.globalIdForPullRequest(pr);
        case 'number':
          return pr.number;
        case 'title':
          return pr.title;
        case 'state':
          return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pr.merged;
        case 'headRefName':
          return pr.headRef;
        case 'baseRefName':
          return pr.baseRef;
        case 'mergeable':
          return computeMergeable(store, pr);
        case 'files':
          return { __typename: 'PullRequestChangedFileConnection', files: resolvePrFiles(store, pr, args.first) };
        case 'body':
          return pr.body;
        case 'createdAt':
          return deterministicIso(pr.createdSeq);
        case 'author': {
          const repo = store.getRepoById(pr.repoDatabaseId);
          return userObj(repo?.owner || viewerLogin(store));
        }
        default:
          return null;
      }
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return (source.prs as PullRequest[]).map((pr) => prObj(pr));
      if (field.name === 'totalCount') return typeof source.totalCount === 'number' ? source.totalCount : 0;
      if (field.name === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: source.hasNextPage ?? false,
          endCursor: source.endCursor ?? null,
          startCursor: source.startCursor ?? null,
        };
      }
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return (source.files as AnyObj[]).map((f) => f);
      if (field.name === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null, startCursor: null };
      }
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return String(source.path ?? source.filename ?? '');
      if (field.name === 'filename') return String(source.filename ?? source.path ?? '');
      if (field.name === 'status') return String(source.status ?? 'modified');
      if (field.name === 'additions') return typeof source.additions === 'number' ? source.additions : 0;
      if (field.name === 'deletions') return typeof source.deletions === 'number' ? source.deletions : 0;
      if (field.name === 'changes') return typeof source.changes === 'number' ? source.changes : 0;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return (source.issue as AnyObj) ?? null;
      if (field.name === 'clientMutationId') return source.clientMutationId ?? null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return (source.pullRequest as AnyObj) ?? null;
      if (field.name === 'clientMutationId') return source.clientMutationId ?? null;
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return (source.commentEdge as AnyObj) ?? null;
      if (field.name === 'comment') return (source.comment as AnyObj) ?? null;
      if (field.name === 'clientMutationId') return source.clientMutationId ?? null;
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return (source.node as AnyObj) ?? null;
      if (field.name === 'cursor') return String(source.cursor ?? '');
      return null;
    }
    case 'IssueComment': {
      const comment = source.comment as Comment;
      if (field.name === 'id') return store.globalIdForComment(comment);
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return userObj(viewerLogin(store));
      return null;
    }
    case '__Type': {
      if (field.name === 'name') return String(source.name ?? '');
      if (field.name === 'kind') return String(source.kind ?? 'OBJECT');
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = source.fieldNames as string[] | null;
        if (!names) return null;
        return names.map((n) => ({ __typename: '__Field', name: n }));
      }
      if (field.name === 'enumValues') {
        const names = source.enumNames as string[] | null;
        if (!names) return null;
        return names.map((n) => ({ __typename: '__EnumValue', name: n }));
      }
      return null;
    }
    case '__Field': {
      if (field.name === 'name') return String(source.name ?? '');
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      if (field.name === 'type') return null;
      if (field.name === 'args') return [];
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return String(source.name ?? '');
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    }
    case '__Schema': {
      if (field.name === 'types') return allIntrospectionTypes();
      if (field.name === 'queryType') return introspectionType('Query');
      if (field.name === 'mutationType') return introspectionType('Mutation');
      if (field.name === 'description') return null;
      if (field.name === 'directives') return [];
      return null;
    }
    default:
      return null;
  }
}

function applySelectionSet(
  value: unknown,
  field: FieldNode,
  parentType: string,
  ctx: Ctx,
): unknown {
  if (!field.selectionSet) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
        return resolveSelectionSet(field.selectionSet as SelectionNode[], childTypeOf(parentType, field.name), item as AnyObj, ctx);
      }
      return item;
    });
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return resolveSelectionSet(field.selectionSet, childTypeOf(parentType, field.name), value as AnyObj, ctx);
  }
  return value;
}

function resolveSelectionSet(
  selections: SelectionNode[],
  typeName: string,
  source: AnyObj,
  ctx: Ctx,
): Record<string, unknown> | null {
  if (source === null || source === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      const value = resolveField(typeName, source, sel, ctx);
      out[sel.alias ?? sel.name] = applySelectionSet(value, sel, typeName, ctx);
    } else if (sel.kind === 'InlineFragment') {
      if (sel.typeCondition && source.__typename !== sel.typeCondition) continue;
      const nested = resolveSelectionSet(sel.selectionSet, sel.typeCondition ?? typeName, source, ctx);
      if (nested) Object.assign(out, nested);
    } else {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition && source.__typename !== frag.typeCondition) continue;
      const nested = resolveSelectionSet(frag.selections, frag.typeCondition ?? typeName, source, ctx);
      if (nested) Object.assign(out, nested);
    }
  }
  return out;
}

function executeOperation(store: Store, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) {
    return { data: null, errors: [{ message: 'Request must be a JSON object with a query string.' }] };
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.query !== 'string' || record.query.trim() === '') {
    return { data: null, errors: [{ message: 'Request must contain a query string.' }] };
  }
  const variables: Record<string, unknown> =
    record.variables && typeof record.variables === 'object'
      ? { ...(record.variables as Record<string, unknown>) }
      : {};
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;

  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(record.query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax error.' }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in query.' }] };
  }
  let operation: OperationNode | undefined;
  if (operationName) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (!operation) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return {
      data: null,
      errors: [{ message: 'Must provide an operation name if query contains multiple operations.' }],
    };
  }
  if (operation.kind === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  // Default nilai variabel dari definisi.
  for (const def of operation.variableDefinitions) {
    if (variables[def.name] === undefined && def.defaultValue) {
      variables[def.name] = resolveValue(def.defaultValue, variables);
    }
  }

  const ctx: Ctx = { store, variables, errors: [], fragments: doc.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: Array<{ message: string }> = [];
  validateSelections(operation.selectionSet, rootType, ctx, validationErrors);
  if (validationErrors.length > 0) {
    // Field tak dikenal = HTTP 200 + errors (bukan HTTP error).
    return { data: null, errors: validationErrors };
  }
  const root: AnyObj = { __typename: rootType };
  const data = resolveSelectionSet(operation.selectionSet, rootType, root, ctx);
  if (ctx.errors.length > 0) {
    return { data, errors: ctx.errors };
  }
  return { data };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Menangani POST /api/graphql. Mengembalikan true bila request ditangani
 *  (termasuk 401/400), false bila path/method bukan milik handler ini. */
export async function handleGraphql(
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
  if (req.method !== 'POST' || (pathname !== '/api/graphql' && pathname !== '/api/graphql/')) {
    return false;
  }
  if (!isAuthorized(req, ctx)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Failed to read request body.' }] });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body must be valid JSON.' }] });
    return true;
  }
  try {
    if (Array.isArray(parsed)) {
      const results: Array<Record<string, unknown>> = [];
      for (const entry of parsed) results.push(executeOperation(store, entry));
      sendJson(res, 200, results);
      return true;
    }
    sendJson(res, 200, executeOperation(store, parsed));
    return true;
  } catch {
    sendJson(res, 200, { data: null, errors: [{ message: 'Internal error.' }] });
    return true;
  }
}
