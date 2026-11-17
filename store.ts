// store.ts — satu-satunya sumber kebenaran state forge github-core-clone-01.
//
// Kontrak arsitektur: ../spec/architecture.md (baca itu dulu).
// Aturan file ini:
//   - Tidak tahu HTTP, JSON wire, atau token. Semua permukaan (git, REST,
//     GraphQL, MCP) membaca/menulis lewat class Store di sini.
//   - Tidak ada Date.now() / Math.random() / UUID di file ini. Satu-satunya
//     "waktu" adalah counter sekuens (lihat nextSeq / deterministicEpoch).
//   - TypeScript erasable saja (Node 22 --experimental-strip-types):
//     tanpa enum, tanpa parameter properties, tanpa namespace.
//     Import antar file memakai ekstensi .ts (di sini tidak ada import file
//     lain; hanya node:crypto).
//   - Method yang bertubuh stub melempar Error('not implemented: ...').
//     Yang sudah diimplementasikan: konstruktor, struktur data in-memory,
//     getter trivial satu baris, dan helper deterministik murni
//     (sha1, git object id, pembangun byte tree/commit/tag, global id,
//     counter/timestamp deterministik, JSON kanonik).
//     Implementer (git / REST / GraphQL+MCP) mengisi stub sesuai JSDoc
//     kontrak di tiap method — JANGAN mengubah signature.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

/** OID nol git: "tidak ada objek / ref belum lahir". */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Basis epoch deterministik untuk timestamp yang dibuat server (git.md §0.4:
 *  timestamp default commit suite adalah 1700000000). Timestamp server =
 *  basis + seq, jadi monoton dan unik per commit tanpa jam dinding. */
export const DETERMINISTIC_EPOCH_BASE = 1_700_000_000;

/** Cabang default setiap repo. */
export const DEFAULT_BRANCH = 'main';

/** Ref HEAD selalu menunjuk ke sini. */
export const HEAD_TARGET = 'refs/heads/main';

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export type RefKind = 'head' | 'tag';
export type IssueState = 'open' | 'closed';
export type PullRequestState = 'open' | 'closed';
export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type ChangedFileStatus = 'added' | 'modified' | 'removed';
export type GlobalIdKind = 'Repo' | 'Issue' | 'PullRequest' | 'IssueComment';

export interface User {
  login: string;
  name: string;
  email: string;
  databaseId: number;
}

export interface Repo {
  databaseId: number;
  name: string;
  /** Login pemilik. '' = belum terikat (lazy binding, architecture.md §3.3). */
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export interface Ref {
  /** Nama penuh, mis. 'refs/heads/main' atau 'refs/tags/v1'. */
  name: string;
  oid: string;
  kind: RefKind;
}

export interface GitObject {
  type: GitObjectType;
  oid: string;
  data: Buffer;
}

export interface TreeEntry {
  /** '100644' file, '40000' direktori; mode lain diteruskan apa adanya. */
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  oid: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  /** Pesan dinormalisasi tepat satu '\n' di akhir. */
  message: string;
  /** depth = 1 + max(depth parent); root commit = 0. Dipakai merge-base. */
  depth: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  repoDatabaseId: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  /** Nama-nama label (bukan objek) — label didefinisikan per repo. */
  labels: string[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Comment {
  id: number;
  repoDatabaseId: number;
  issueNumber: number;
  body: string;
  createdSeq: number;
}

export interface PullRequest {
  repoDatabaseId: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  /** Tip head/base PADA SAAT PR dibuat (dibekukan). */
  headSha: string;
  baseSha: string;
  state: PullRequestState;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface ChangedFile {
  filename: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  changes: number;
}

export interface MergeOutcome {
  ok: boolean;
  mergeCommitSha: string | null;
  /** Path yang konflik (kosong bila ok). */
  conflicts: string[];
  message: string;
}

export interface CommitInput {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  message: string;
}

export interface TagInput {
  object: string;
  tag: string;
  taggerName: string;
  taggerEmail: string;
  taggerEpoch: number;
  message: string;
}

export interface CreateRepoInput {
  name: string;
  description: string;
  private: boolean;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface CreatePullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface ContentsPutInput {
  repoDatabaseId: number;
  /** Nama branch tanpa prefix 'refs/heads/'; kosong = default branch. */
  branch: string;
  path: string;
  /** Isi file sebagai byte (sudah di-decode dari base64 oleh pemanggil). */
  content: Buffer;
  message: string;
  /** Sha blob saat ini; undefined = tidak disertakan (jalur create). */
  sha: string | undefined;
}

export interface ContentsPutResult {
  blobSha: string;
  commitSha: string;
  /** 201 bila file baru, 200 bila update file yang sudah ada. */
  status: 200 | 201;
}

export interface ContentsDeleteInput {
  repoDatabaseId: number;
  branch: string;
  path: string;
  message: string;
  sha: string | undefined;
}

export interface DecodedGlobalId {
  kind: GlobalIdKind;
  /** Bagian setelah kind, sebagai string apa adanya (pemanggil parse angka). */
  parts: string[];
}

export interface FastForwardCheck {
  ok: boolean;
  /** null bila ok; persis 'non-fast-forward' bila ditolak. */
  reason: string | null;
}

export interface FileAtRef {
  blobOid: string;
  content: Buffer;
}

/** Error yang dilempar Store; handler HTTP memetakannya ke status + {"message"}. */
export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Helper deterministik murni (diimplementasikan penuh)
// ---------------------------------------------------------------------------

/** SHA-1 hex dari byte/string. */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** SHA-1 id objek git: sha1("<type> <len>\0" + bytes). */
export function gitObjectSha(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** SHA-1 blob git dari isi file. */
export function gitBlobSha(content: Buffer): string {
  return gitObjectSha('blob', content);
}

export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}

/** Kunci urut entri tree aturan git: nama direktori dibandingkan seolah
 *  berakhir '/'. Perbandingan byte-wise (Buffer.compare), bukan locale. */
export function gitTreeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  return Buffer.compare(
    Buffer.from(gitTreeSortKey(a), 'utf8'),
    Buffer.from(gitTreeSortKey(b), 'utf8'),
  );
}

/** Byte tree git dari entri (diurutkan aturan git di dalam fungsi ini).
 *  Format per entri: "<mode> <nama>\0" + 20 byte oid biner. */
export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** Normalisasi pesan commit/tag: tepat satu '\n' di akhir. */
export function normalizeCommitMessage(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`;
}

/** Byte commit git persis seperti buildCommit suite:
 *  tree / parent* / author / committer / blank / pesan. */
export function buildCommitBytes(input: CommitInput): Buffer {
  const lines: string[] = [];
  lines.push(`tree ${input.tree}`);
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.authorName} <${input.authorEmail}> ${input.authorEpoch} +0000`);
  lines.push(`committer ${input.committerName} <${input.committerEmail}> ${input.committerEpoch} +0000`);
  lines.push('');
  lines.push(normalizeCommitMessage(input.message));
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Byte annotated tag git persis seperti buildTag suite. */
export function buildTagBytes(input: TagInput): Buffer {
  const lines: string[] = [];
  lines.push(`object ${input.object}`);
  lines.push('type commit');
  lines.push(`tag ${input.tag}`);
  lines.push(`tagger ${input.taggerName} <${input.taggerEmail}> ${input.taggerEpoch} +0000`);
  lines.push('');
  lines.push(normalizeCommitMessage(input.message));
  return Buffer.from(lines.join('\n'), 'utf8');
}

// --- Global ID GraphQL (opaque, base64url dari "Kind:bagian:…") -------------

/** Encode global id. Contoh: encodeGlobalId('Repo', [3]) -> base64url('Repo:3'). */
export function encodeGlobalId(kind: GlobalIdKind, parts: Array<string | number>): string {
  const payload = [kind, ...parts.map((p) => String(p))].join(':');
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Decode + validasi ketat global id. Gagal validasi -> null (bukan throw):
 *  decode harus berhasil, re-encode harus sama persis, kind dikenal,
 *  semua bagian setelah kind harus digit (semua payload kita numerik). */
export function decodeGlobalId(id: string): DecodedGlobalId | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== id) return null;
  const segments = decoded.split(':');
  const kind = segments[0];
  if (kind !== 'Repo' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
  const parts = segments.slice(1);
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return null;
  }
  return { kind, parts };
}

/** Epoch deterministik untuk commit yang dibuat server: basis + seq. */
export function deterministicEpoch(seq: number): number {
  return DETERMINISTIC_EPOCH_BASE + seq;
}

/** ISO timestamp deterministik dari seq. new Date di sini deterministik
 *  karena argumennya berasal dari counter, bukan jam dinding. */
export function deterministicIso(seq: number): string {
  return new Date(deterministicEpoch(seq) * 1000).toISOString();
}

/** JSON kanonik: key objek diurutkan rekursif — snapshot byte-identik. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`);
  return `{${parts.join(',')}}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  /** Login viewer; null = belum terikat (lazy binding, architecture.md §3.3). */
  viewerLogin: string | null;
  /** Counter sekuens deterministik; mulai 0, nextSeq() mengembalikan 1, 2, … */
  seq: number;
  nextRepoDatabaseId: number;
  nextCommentId: number;

  /** Semua state ada di Map di bawah ini — tidak ada state di luar Store. */
  repos: Map<number, Repo>;
  reposByOwnerName: Map<string, number>;
  reposByName: Map<string, number>;
  refs: Map<number, Map<string, Ref>>;
  objects: Map<string, GitObject>;
  commits: Map<string, CommitInfo>;
  trees: Map<string, TreeEntry[]>;
  issues: Map<number, Map<number, Issue>>;
  labels: Map<number, Map<string, Label>>;
  comments: Map<number, Comment>;
  commentsByIssue: Map<string, Comment[]>;
  pullRequests: Map<number, Map<number, PullRequest>>;

  constructor(viewerLogin: string | null = null) {
    this.viewerLogin = viewerLogin;
    this.seq = 0;
    this.nextRepoDatabaseId = 1;
    this.nextCommentId = 1;
    this.repos = new Map();
    this.reposByOwnerName = new Map();
    this.reposByName = new Map();
    this.refs = new Map();
    this.objects = new Map();
    this.commits = new Map();
    this.trees = new Map();
    this.issues = new Map();
    this.labels = new Map();
    this.comments = new Map();
    this.commentsByIssue = new Map();
    this.pullRequests = new Map();
  }

  // --- Determinisme -------------------------------------------------------

  /** Ambil nomor sekuens berikutnya (1, 2, 3, …). Setiap mutasi yang
   *  membuat/mengubah objek memanggil ini sekali dan menyimpan hasilnya
   *  sebagai createdSeq/updatedSeq. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  peekSeq(): number {
    return this.seq;
  }

  // --- Viewer ---------------------------------------------------------------

  /** Tetapkan login viewer (dari env override atau lazy binding).
   *  Bila login berubah dari null ke nilai, repo pending milik viewer
   *  diikat ulang lewat bindOwner oleh pemanggil. */
  setViewerLogin(login: string): void {
    this.viewerLogin = login;
  }

  getViewerLogin(): string | null {
    return this.viewerLogin;
  }

  /** User viewer untuk commit server-generated dan query viewer GraphQL.
   *  name = login; email = "<login>@example.invalid" (pola skenario).
   *  Bila login belum dikenal, lempar StoreError 500 — pemanggil (GraphQL
   *  viewer) harus sudah memastikan login terikat lewat fixture repo. */
  getViewerUser(): User {
    const login = this.viewerLogin;
    if (login === null || login === '') {
      throw new StoreError(500, 'viewer login is not known');
    }
    return { login, name: login, email: `${login}@example.invalid`, databaseId: 1000 };
  }

  /** Ikat repo pending (owner '') ke owner yang disebut di path request.
   *  Bila repo sudah terikat ke owner lain, lempar StoreError 404
   *  (jangan 403 — owner lain tidak boleh dibocorkan). */
  bindOwner(repoDatabaseId: number, owner: string): Repo {
    const repo = this.repos.get(repoDatabaseId) ?? null;
    if (repo === null) throw new StoreError(404, 'repository not found');
    if (repo.owner !== '' && repo.owner !== owner) {
      throw new StoreError(404, 'repository not found');
    }
    // Bila viewer sudah dikenal dan owner di path bukan viewer, jangan ikat:
    // itu pemilik lain (404, bukan 403).
    if (this.viewerLogin !== null && this.viewerLogin !== owner) {
      throw new StoreError(404, 'repository not found');
    }
    if (repo.owner === '') {
      repo.owner = owner;
      this.reposByOwnerName.set(`${owner}/${repo.name}`, repo.databaseId);
    }
    if (this.viewerLogin === null) this.viewerLogin = owner;
    return repo;
  }

  // --- Repo -----------------------------------------------------------------

  /** Buat repo. Owner = viewerLogin bila sudah dikenal, sonst '' (pending,
   *  diikat belakangan oleh bindOwner). databaseId dari counter, mulai 1,
   *  tidak pernah dipakai ulang. defaultBranch selalu 'main'.
   *  Duplikat nama di bawah owner yang sama -> StoreError 422 dengan
   *  message mengandung 'already exists'. */
  createRepo(input: CreateRepoInput): Repo {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new StoreError(422, 'repository name is required');
    }
    const owner = this.viewerLogin ?? '';
    // Forge ini satu viewer: nama repo yang sama (di bawah owner mana pun
    // yang terlihat) adalah duplikat.
    if (this.findRepoByName(input.name) !== null) {
      throw new StoreError(422, `repository ${input.name} already exists`);
    }
    const databaseId = this.nextRepoDatabaseId;
    this.nextRepoDatabaseId += 1;
    const repo: Repo = {
      databaseId,
      name: input.name,
      owner,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(databaseId, repo);
    if (!this.reposByName.has(input.name)) this.reposByName.set(input.name, databaseId);
    if (owner !== '') this.reposByOwnerName.set(`${owner}/${input.name}`, databaseId);
    this.refs.set(databaseId, new Map());
    this.issues.set(databaseId, new Map());
    this.labels.set(databaseId, new Map());
    this.pullRequests.set(databaseId, new Map());
    return repo;
  }

  getRepoById(databaseId: number): Repo | null {
    return this.repos.get(databaseId) ?? null;
  }

  /** Lookup ketat owner+name. Bila owner tidak cocok dengan repo yang ada
   *  (atau repo tidak ada), kembalikan null — pemanggil menjawab 404. */
  getRepoByOwnerAndName(owner: string, name: string): Repo | null {
    const id = this.reposByOwnerName.get(`${owner}/${name}`);
    if (id === undefined) return null;
    return this.repos.get(id) ?? null;
  }

  /** Lookup longgar berdasarkan nama saja (untuk repo pending sebelum
   *  owner terikat, dan untuk git/REST yang datang sebelum binding).
   *  Bila ada beberapa repo bernama sama, kembalikan yang databaseId
   *  terkecil (paling dulu dibuat). */
  findRepoByName(name: string): Repo | null {
    const id = this.reposByName.get(name);
    if (id === undefined) return null;
    return this.repos.get(id) ?? null;
  }

  /** Semua repo milik owner, urut databaseId naik. */
  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.databaseId - b.databaseId);
    return out;
  }

  /** Semua repo, urut databaseId naik. */
  listAllRepos(): Repo[] {
    const out: Repo[] = [...this.repos.values()];
    out.sort((a, b) => a.databaseId - b.databaseId);
    return out;
  }

  /** PATCH repo: hanya description yang diuji suite; field lain di patch
   *  diterima dan disimpan bila ada di type Repo (private, defaultBranch
   *  tidak diubah lewat sini). Kembalikan repo sesudah patch. */
  patchRepo(databaseId: number, patch: { description?: string; private?: boolean }): Repo {
    const repo = this.repos.get(databaseId) ?? null;
    if (repo === null) throw new StoreError(404, 'repository not found');
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.private !== undefined) repo.private = patch.private;
    return repo;
  }

  /** Hapus repo + ref + issue/label/PR/komentar di bawahnya. Objek git
   *  global TIDAK dihapus (content-addressed, dipakai repo lain).
   *  Repo yang tidak ada -> StoreError 404. */
  deleteRepo(databaseId: number): void {
    const repo = this.repos.get(databaseId) ?? null;
    if (repo === null) throw new StoreError(404, 'repository not found');
    this.repos.delete(databaseId);
    if (repo.owner !== '') this.reposByOwnerName.delete(`${repo.owner}/${repo.name}`);
    if (this.reposByName.get(repo.name) === databaseId) {
      this.reposByName.delete(repo.name);
      let next: number | undefined;
      for (const other of this.repos.values()) {
        if (other.name === repo.name && (next === undefined || other.databaseId < next)) next = other.databaseId;
      }
      if (next !== undefined) this.reposByName.set(repo.name, next);
    }
    this.refs.delete(databaseId);
    this.issues.delete(databaseId);
    this.labels.delete(databaseId);
    this.pullRequests.delete(databaseId);
    for (const [commentId, comment] of this.comments) {
      if (comment.repoDatabaseId === databaseId) this.comments.delete(commentId);
    }
    for (const key of [...this.commentsByIssue.keys()]) {
      if (key.startsWith(`${databaseId}:`)) this.commentsByIssue.delete(key);
    }
  }

  getDefaultBranchName(repoDatabaseId: number): string {
    return DEFAULT_BRANCH;
  }

  // --- Ref ------------------------------------------------------------------

  getRef(repoDatabaseId: number, refName: string): Ref | null {
    return this.refs.get(repoDatabaseId)?.get(refName) ?? null;
  }

  /** Semua ref repo, urut nama (byte) naik. */
  listRefs(repoDatabaseId: number): Ref[] {
    const refs = [...(this.refs.get(repoDatabaseId)?.values() ?? [])];
    refs.sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
    return refs;
  }

  listHeads(repoDatabaseId: number): Ref[] {
    return this.listRefs(repoDatabaseId).filter((r) => r.name.startsWith('refs/heads/'));
  }

  listTags(repoDatabaseId: number): Ref[] {
    return this.listRefs(repoDatabaseId).filter((r) => r.name.startsWith('refs/tags/'));
  }

  /** Buat ref baru. Ref sudah ada -> StoreError 422. oid harus 40-hex
   *  (kecuali ZERO_OID tidak boleh dipakai sebagai target ref hidup). */
  createRef(repoDatabaseId: number, refName: string, oid: string): Ref {
    const repo = this.getRepoById(repoDatabaseId);
    if (!repo) throw new StoreError(404, 'repository not found');
    if (!/^[0-9a-f]{40}$/.test(oid) || isZeroOid(oid)) {
      throw new StoreError(422, 'invalid object id');
    }
    let repoRefs = this.refs.get(repoDatabaseId);
    if (!repoRefs) {
      repoRefs = new Map<string, Ref>();
      this.refs.set(repoDatabaseId, repoRefs);
    }
    if (repoRefs.has(refName)) throw new StoreError(422, 'reference already exists');
    const ref: Ref = {
      name: refName,
      oid,
      kind: refName.startsWith('refs/tags/') ? 'tag' : 'head',
    };
    repoRefs.set(refName, ref);
    return ref;
  }

  /** Gerakkan/buat ref tanpa cek fast-forward (cek FF adalah tugas
   *  pemanggil via checkFastForward). */
  setRef(repoDatabaseId: number, refName: string, oid: string): Ref {
    const repo = this.getRepoById(repoDatabaseId);
    if (!repo) throw new StoreError(404, 'repository not found');
    if (!/^[0-9a-f]{40}$/.test(oid) || isZeroOid(oid)) {
      throw new StoreError(422, 'invalid object id');
    }
    let repoRefs = this.refs.get(repoDatabaseId);
    if (!repoRefs) {
      repoRefs = new Map<string, Ref>();
      this.refs.set(repoDatabaseId, repoRefs);
    }
    const ref: Ref = {
      name: refName,
      oid,
      kind: refName.startsWith('refs/tags/') ? 'tag' : 'head',
    };
    repoRefs.set(refName, ref);
    return ref;
  }

  /** Hapus ref. Ref tidak ada -> StoreError 404. */
  deleteRef(repoDatabaseId: number, refName: string): void {
    const repoRefs = this.refs.get(repoDatabaseId);
    if (!repoRefs || !repoRefs.has(refName)) throw new StoreError(404, 'reference not found');
    repoRefs.delete(refName);
  }

  /** Resolve ref ke oid tip; null bila ref tidak ada. */
  resolveRef(repoDatabaseId: number, refName: string): string | null {
    if (refName === 'HEAD') {
      return this.resolveRef(repoDatabaseId, this.getHeadTarget(repoDatabaseId));
    }
    return this.getRef(repoDatabaseId, refName)?.oid ?? null;
  }

  /** HEAD selalu menunjuk 'refs/heads/main'. */
  getHeadTarget(repoDatabaseId: number): string {
    return HEAD_TARGET;
  }

  // --- Objek git ------------------------------------------------------------

  /** Simpan objek dari byte-nya; sha dihitung dari byte (gitObjectSha).
   *  Bila commit: parse byte -> CommitInfo (tree, parents, author,
   *  committer, message, depth = 1 + max depth parent, root = 0).
   *  Bila tree: parse entri -> trees cache.
   *  Objek duplikat (oid sama) diterima diam-diam, kembalikan yang lama. */
  putObject(type: GitObjectType, data: Buffer): GitObject {
    const oid = gitObjectSha(type, data);
    const existing = this.objects.get(oid);
    if (existing) return existing;
    const obj: GitObject = { type, oid, data };
    this.objects.set(oid, obj);
    if (type === 'tree') {
      const entries: TreeEntry[] = [];
      let off = 0;
      while (off < data.length) {
        const sp = data.indexOf(0x20, off);
        if (sp === -1) break;
        const mode = data.subarray(off, sp).toString('utf8');
        const nul = data.indexOf(0x00, sp + 1);
        if (nul === -1 || nul + 21 > data.length) break;
        const name = data.subarray(sp + 1, nul).toString('utf8');
        const entryOid = data.subarray(nul + 1, nul + 21).toString('hex');
        entries.push({ mode, name, oid: entryOid });
        off = nul + 21;
      }
      this.trees.set(oid, entries);
    } else if (type === 'commit') {
      const text = data.toString('utf8');
      const sep = text.indexOf('\n\n');
      const header = sep === -1 ? text : text.slice(0, sep);
      const message = sep === -1 ? '' : normalizeCommitMessage(text.slice(sep + 2));
      let tree = '';
      const parents: string[] = [];
      let authorName = '';
      let authorEmail = '';
      let authorEpoch = 0;
      let committerName = '';
      let committerEmail = '';
      let committerEpoch = 0;
      const parseIdent = (s: string): { name: string; email: string; epoch: number } => {
        const lt = s.lastIndexOf('<');
        const gt = lt === -1 ? -1 : s.indexOf('>', lt);
        if (lt === -1 || gt === -1) return { name: s.trim(), email: '', epoch: 0 };
        const rest = s.slice(gt + 1).trim().split(/\s+/);
        const epoch = rest.length > 0 ? Number.parseInt(rest[0], 10) : 0;
        return { name: s.slice(0, lt).trim(), email: s.slice(lt + 1, gt), epoch: Number.isFinite(epoch) ? epoch : 0 };
      };
      for (const line of header.split('\n')) {
        if (line.startsWith('tree ')) tree = line.slice(5).trim();
        else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
        else if (line.startsWith('author ')) {
          const p = parseIdent(line.slice(7));
          authorName = p.name; authorEmail = p.email; authorEpoch = p.epoch;
        } else if (line.startsWith('committer ')) {
          const p = parseIdent(line.slice(10));
          committerName = p.name; committerEmail = p.email; committerEpoch = p.epoch;
        }
      }
      let depth = 0;
      for (const parent of parents) {
        const parentDepth = this.commits.get(parent)?.depth;
        depth = Math.max(depth, parentDepth === undefined ? 1 : parentDepth + 1);
      }
      this.commits.set(oid, {
        oid, tree, parents, authorName, authorEmail, authorEpoch,
        committerName, committerEmail, committerEpoch, message, depth,
      });
    }
    return obj;
  }

  getObject(oid: string): GitObject | null {
    return this.objects.get(oid) ?? null;
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  getCommitInfo(oid: string): CommitInfo | null {
    return this.commits.get(oid) ?? null;
  }

  getTreeEntries(treeOid: string): TreeEntry[] | null {
    const cached = this.trees.get(treeOid);
    if (cached) return cached.map((e) => ({ mode: e.mode, name: e.name, oid: e.oid }));
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return null;
    const data = obj.data;
    const entries: TreeEntry[] = [];
    let off = 0;
    while (off < data.length) {
      const sp = data.indexOf(0x20, off);
      if (sp === -1) break;
      const mode = data.subarray(off, sp).toString('utf8');
      const nul = data.indexOf(0x00, sp + 1);
      if (nul === -1 || nul + 21 > data.length) break;
      entries.push({
        mode,
        name: data.subarray(sp + 1, nul).toString('utf8'),
        oid: data.subarray(nul + 1, nul + 21).toString('hex'),
      });
      off = nul + 21;
    }
    this.trees.set(treeOid, entries);
    return entries.map((e) => ({ mode: e.mode, name: e.name, oid: e.oid }));
  }

  /** Bangun (rekursif) tree dari map path file -> {oid blob, mode}.
   *  Membuat semua tree perantara (direktori '40000'), menyimpan tiap
   *  tree baru lewat putObject, mengembalikan oid tree root + daftar
   *  objek tree yang dibuat. Entri diurutkan aturan git. */
  buildTreeForFiles(files: Map<string, { oid: string; mode: string }>): { treeOid: string; created: GitObject[] } {
    const created: GitObject[] = [];
    const seen = new Set<string>();
    const buildLevel = (levelFiles: Map<string, { oid: string; mode: string }>): GitObject => {
      const entries: TreeEntry[] = [];
      const subdirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, value] of levelFiles) {
        const slash = path.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: value.mode, name: path, oid: value.oid });
        } else {
          const dir = path.slice(0, slash);
          let sub = subdirs.get(dir);
          if (!sub) {
            sub = new Map<string, { oid: string; mode: string }>();
            subdirs.set(dir, sub);
          }
          sub.set(path.slice(slash + 1), value);
        }
      }
      for (const [dir, sub] of subdirs) {
        const subTree = buildLevel(sub);
        entries.push({ mode: '40000', name: dir, oid: subTree.oid });
      }
      const obj = this.putObject('tree', buildTreeBytes(entries));
      if (!seen.has(obj.oid)) {
        seen.add(obj.oid);
        created.push(obj);
      }
      return obj;
    };
    const root = buildLevel(files);
    return { treeOid: root.oid, created };
  }

  /** Bangun objek commit dari CommitInput (byte via buildCommitBytes),
   *  simpan lewat putObject, kembalikan GitObject-nya. */
  buildCommitObject(input: CommitInput): GitObject {
    return this.putObject('commit', buildCommitBytes(input));
  }

  /** Bangun objek annotated tag dari TagInput (byte via buildTagBytes),
   *  simpan lewat putObject, kembalikan GitObject-nya. */
  buildTagObject(input: TagInput): GitObject {
    return this.putObject('tag', buildTagBytes(input));
  }

  // --- Reachability / history / merge-base ---------------------------------

  /** Semua objek reachable dari oids (commit -> tree + parents; tree ->
   *  entri kecuali gitlink '160000' dilewati; tag -> target; blob berhenti).
   *  Urutan iterasi hasil deterministik (BFS/DFS dengan visited Set,
   *  anak dikunjungi dalam urutan byte objek). */
  reachableObjects(oids: string[]): Map<string, GitObject> {
    const result = new Map<string, GitObject>();
    const visited = new Set<string>();
    const queue: string[] = [...oids];
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head];
      head += 1;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = this.objects.get(oid);
      if (!obj) continue;
      result.set(oid, obj);
      if (obj.type === 'commit') {
        const info = this.commits.get(oid);
        if (info) {
          if (info.tree !== '') queue.push(info.tree);
          for (const parent of info.parents) queue.push(parent);
        }
      } else if (obj.type === 'tree') {
        const entries = this.trees.get(oid) ?? [];
        for (const entry of entries) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      } else if (obj.type === 'tag') {
        const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
        if (firstLine.startsWith('object ')) queue.push(firstLine.slice(7).trim());
      }
    }
    return result;
  }

  /** Objek reachable dari want minus reachable dari have (fetch
   *  incremental; want == have -> map kosong). */
  reachableExcluding(wantOids: string[], haveOids: string[]): Map<string, GitObject> {
    const result = this.reachableObjects(wantOids);
    const have = this.reachableObjects(haveOids);
    for (const oid of have.keys()) result.delete(oid);
    return result;
  }

  /** Seperti reachableExcluding tetapi dibatasi depth commit: hanya commit
   *  dengan jarak <= depth dari want (depth 1 = tip saja) beserta tree +
   *  blob-nya. shallowBoundary = commit-commit di batas depth (tip-tip
   *  shallow yang harus dilaporkan sebagai 'shallow <oid>'). */
  reachableExcludingAtDepth(
    wantOids: string[],
    haveOids: string[],
    depth: number,
  ): { objects: Map<string, GitObject>; shallowBoundary: string[] } {
    const included = new Map<string, GitObject>();
    const shallowBoundary: string[] = [];
    if (depth <= 0) return { objects: included, shallowBoundary };
    const commitGen = new Map<string, number>();
    const visitedCommits = new Set<string>();
    const queue: Array<{ oid: string; gen: number }> = [];
    let head = 0;
    const peelTagTarget = (tagOid: string): string | null => {
      let current = tagOid;
      const seenTags = new Set<string>();
      while (true) {
        if (seenTags.has(current)) return null;
        seenTags.add(current);
        const obj = this.objects.get(current);
        if (!obj || obj.type !== 'tag') return null;
        const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
        if (!firstLine.startsWith('object ')) return null;
        const target = firstLine.slice(7).trim();
        const targetObj = this.objects.get(target);
        if (!targetObj) return target;
        if (targetObj.type === 'tag') {
          current = target;
          continue;
        }
        return target;
      }
    };
    for (const oid of wantOids) {
      const obj = this.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        included.set(oid, obj);
        const target = peelTagTarget(oid);
        if (target === null) continue;
        const targetObj = this.objects.get(target);
        if (targetObj?.type === 'commit') queue.push({ oid: target, gen: 0 });
        else if (targetObj) {
          for (const [key, value] of this.reachableObjects([target])) included.set(key, value);
        }
      } else if (obj.type === 'commit') {
        queue.push({ oid, gen: 0 });
      } else {
        for (const [key, value] of this.reachableObjects([oid])) included.set(key, value);
      }
    }
    while (head < queue.length) {
      const item = queue[head];
      head += 1;
      if (visitedCommits.has(item.oid)) continue;
      visitedCommits.add(item.oid);
      if (item.gen >= depth) continue;
      const info = this.commits.get(item.oid);
      if (!info) continue;
      commitGen.set(item.oid, item.gen);
      const commitObj = this.objects.get(item.oid);
      if (commitObj) included.set(item.oid, commitObj);
      if (info.tree !== '') {
        for (const [key, value] of this.reachableObjects([info.tree])) included.set(key, value);
      }
      for (const parent of info.parents) queue.push({ oid: parent, gen: item.gen + 1 });
    }
    // Pengecualian have yang sadar-depth: walk dari setiap have-commit
    // menyertakan commit itu + tree/blob-nya, tetapi TIDAK menembus ke
    // parent yang berada di dalam jendela depth want. Itu yang membuat
    // deepen benar: have = tip shallow (mis. third) tidak ikut
    // menghapus parent-nya (second) yang justru harus dikirim, karena
    // klien shallow tidak memiliki parent tersebut.
    const excluded = new Set<string>();
    const excludeCommitClosure = (commitOid: string): void => {
      const info = this.commits.get(commitOid);
      if (!info) return;
      excluded.add(commitOid);
      if (info.tree !== '') {
        for (const key of this.reachableObjects([info.tree]).keys()) excluded.add(key);
      }
    };
    for (const haveOid of haveOids) {
      const haveObj = this.objects.get(haveOid);
      if (!haveObj) continue;
      if (haveObj.type === 'commit') {
        const queue: string[] = [haveOid];
        const visitedHave = new Set<string>();
        let hHead = 0;
        while (hHead < queue.length) {
          const current = queue[hHead];
          hHead += 1;
          if (visitedHave.has(current)) continue;
          visitedHave.add(current);
          excludeCommitClosure(current);
          const info = this.commits.get(current);
          if (!info) continue;
          for (const parent of info.parents) {
            if (!commitGen.has(parent)) queue.push(parent);
          }
        }
      } else {
        for (const key of this.reachableObjects([haveOid]).keys()) excluded.add(key);
      }
    }
    for (const oid of excluded) included.delete(oid);
    for (const [oid, gen] of commitGen) {
      if (gen !== depth - 1) continue;
      if (!included.has(oid)) continue;
      const info = this.commits.get(oid);
      if (info && info.parents.length > 0) shallowBoundary.push(oid);
    }
    shallowBoundary.sort();
    return { objects: included, shallowBoundary };
  }

  /** History commit dari tip ref, mengikuti parent pertama (rantai linear
   *  suite; bila commit punya >1 parent, kunjungi semua parent dengan
   *  urutan deterministik: parent pertama dulu, lalu sisanya).
   *  Urut terbaru dulu. limit undefined = seluruh history. */
  commitHistory(repoDatabaseId: number, refName: string, limit?: number): CommitInfo[] {
    let oid: string | null = this.resolveRef(repoDatabaseId, refName);
    if (oid === null && !refName.startsWith('refs/')) {
      oid = this.resolveRef(repoDatabaseId, `refs/heads/${refName}`);
    }
    if (oid === null) return [];
    const seenTags = new Set<string>();
    while (true) {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tag' || seenTags.has(oid)) break;
      seenTags.add(oid);
      const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
      if (!firstLine.startsWith('object ')) break;
      oid = firstLine.slice(7).trim();
    }
    const result: CommitInfo[] = [];
    const visited = new Set<string>();
    const stack: string[] = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      const info = this.commits.get(current);
      if (!info) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) break;
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
    }
    return result;
  }

  /** True bila ancestorOid == descendantOid atau ancestor adalah leluhur
   *  descendant (walk parent). Oid yang tidak dikenal -> false. */
  isAncestor(ancestorOid: string, descendantOid: string): boolean {
    if (ancestorOid === descendantOid) return true;
    const visited = new Set<string>();
    const stack: string[] = [descendantOid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      const info = this.commits.get(current);
      if (!info) continue;
      for (const parent of info.parents) {
        if (parent === ancestorOid) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** Merge-base: ancestor bersama dengan depth terbesar (bila seri,
   *  oid terkecil secara byte). null bila tidak ada ancestor bersama
   *  (riwayat tak terkait) atau salah satu oid tidak dikenal. */
  mergeBase(aOid: string, bOid: string): string | null {
    if (!this.commits.has(aOid) || !this.commits.has(bOid)) return null;
    const collectAncestors = (start: string): Set<string> => {
      const seen = new Set<string>();
      const stack: string[] = [start];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        const info = this.commits.get(current);
        if (!info) continue;
        for (const parent of info.parents) stack.push(parent);
      }
      return seen;
    };
    const ancestorsA = collectAncestors(aOid);
    const ancestorsB = collectAncestors(bOid);
    let best: string | null = null;
    let bestDepth = -1;
    for (const oid of ancestorsA) {
      if (!ancestorsB.has(oid)) continue;
      const depth = this.commits.get(oid)?.depth ?? 0;
      if (depth > bestDepth || (depth === bestDepth && (best === null || oid < best))) {
        best = oid;
        bestDepth = depth;
      }
    }
    return best;
  }

  /** Aturan fast-forward untuk satu command push:
   *  - oldOid ZERO_OID (create) -> selalu ok.
   *  - newOid ZERO_OID (delete) -> ok (penghapusan bukan soal FF).
   *  - newOid keturunan oldOid (isAncestor, termasuk sama) -> ok.
   *  - selain itu -> {ok:false, reason:'non-fast-forward'} (PERSIS).
   *  Ref yang tidak ada + oldOid bukan nol -> {ok:false,
   *  reason:'non-fast-forward'} (keputusan: old yang salah = bukan FF). */
  checkFastForward(
    repoDatabaseId: number,
    refName: string,
    oldOid: string,
    newOid: string,
  ): FastForwardCheck {
    if (isZeroOid(newOid)) return { ok: true, reason: null };
    const ref = this.getRef(repoDatabaseId, refName);
    if (isZeroOid(oldOid)) {
      if (ref === null) return { ok: true, reason: null };
      return { ok: false, reason: 'non-fast-forward' };
    }
    if (ref === null) return { ok: false, reason: 'non-fast-forward' };
    if (ref.oid !== oldOid) return { ok: false, reason: 'non-fast-forward' };
    if (this.isAncestor(oldOid, newOid)) return { ok: true, reason: null };
    return { ok: false, reason: 'non-fast-forward' };
  }

  // --- Contents (seam git <-> REST) ----------------------------------------

  /** Flatten tree ke map path lengkap -> entri (rekursif, direktori
   *  tidak masuk map; hanya file/gitlink). */
  readTreeFlat(treeOid: string): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.getTreeEntries(oid);
      if (!entries) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, name: entry.name, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Baca satu file pada tip ref. null bila ref/path tidak ada atau path
   *  adalah direktori. content = byte blob. */
  getFileAtRef(repoDatabaseId: number, refName: string, path: string): FileAtRef | null {
    let oid: string | null = this.resolveRef(repoDatabaseId, refName);
    if (oid === null && !refName.startsWith('refs/')) {
      oid = this.resolveRef(repoDatabaseId, `refs/heads/${refName}`);
    }
    if (oid === null) return null;
    const seenTags = new Set<string>();
    while (true) {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tag' || seenTags.has(oid)) break;
      seenTags.add(oid);
      const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
      if (!firstLine.startsWith('object ')) break;
      oid = firstLine.slice(7).trim();
    }
    const info = this.commits.get(oid);
    if (!info) return null;
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    let treeOid = info.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.getTreeEntries(treeOid);
      if (!entries) return null;
      const entry = entries.find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') return null;
        const blob = this.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { blobOid: entry.oid, content: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** Daftar entri langsung di bawah direktori pada tip ref (file + subdir).
   *  dirPath '' atau '/' = root. null bila ref tidak ada; [] bila direktori
   *  tidak ada (pemanggil membedakan dari respons 404). */
  listDirectoryAtRef(repoDatabaseId: number, refName: string, dirPath: string): TreeEntry[] | null {
    let oid: string | null = this.resolveRef(repoDatabaseId, refName);
    if (oid === null && !refName.startsWith('refs/')) {
      oid = this.resolveRef(repoDatabaseId, `refs/heads/${refName}`);
    }
    if (oid === null) return null;
    const seenTags = new Set<string>();
    while (true) {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tag' || seenTags.has(oid)) break;
      seenTags.add(oid);
      const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
      if (!firstLine.startsWith('object ')) break;
      oid = firstLine.slice(7).trim();
    }
    const info = this.commits.get(oid);
    if (!info) return null;
    const normalized = dirPath.replace(/^\/+|\/+$/g, '');
    if (normalized === '') {
      return this.getTreeEntries(info.tree) ?? [];
    }
    const segments = normalized.split('/').filter((s) => s.length > 0);
    let treeOid = info.tree;
    for (const segment of segments) {
      const entries = this.getTreeEntries(treeOid);
      if (!entries) return [];
      const entry = entries.find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') return [];
      treeOid = entry.oid;
    }
    return this.getTreeEntries(treeOid) ?? [];
  }

  /** PUT contents -> blob + tree + commit (architecture.md §4.1).
   *  Parent = tip branch (atau tidak ada bila unborn). Commit dibuat
   *  dengan author/committer viewer, epoch deterministik, pesan verbatim.
   *  File sudah ada + sha disertakan dan salah -> StoreError 409.
   *  File sudah ada + sha benar -> update (status 200). File baru -> 201.
   *  Branch tidak ada (dan bukan default unborn) -> StoreError 404. */
  applyContentsPut(input: ContentsPutInput): ContentsPutResult {
    const repo = this.getRepoById(input.repoDatabaseId);
    if (!repo) throw new StoreError(404, 'repository not found');
    const branch = input.branch === '' ? DEFAULT_BRANCH : input.branch;
    const refName = `refs/heads/${branch}`;
    const ref = this.getRef(input.repoDatabaseId, refName);
    if (!ref && branch !== DEFAULT_BRANCH) throw new StoreError(404, 'branch not found');
    const cleanPath = input.path.replace(/^\/+/, '');
    let tipOid: string | null = null;
    let flat = new Map<string, TreeEntry>();
    if (ref) {
      let peeled = ref.oid;
      const seenTags = new Set<string>();
      while (true) {
        const obj = this.objects.get(peeled);
        if (!obj || obj.type !== 'tag' || seenTags.has(peeled)) break;
        seenTags.add(peeled);
        const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
        if (!firstLine.startsWith('object ')) break;
        peeled = firstLine.slice(7).trim();
      }
      tipOid = peeled;
      const info = this.commits.get(peeled);
      if (info) flat = this.readTreeFlat(info.tree);
    }
    const existing = flat.get(cleanPath);
    if (existing && input.sha !== undefined && input.sha !== existing.oid) {
      throw new StoreError(409, 'sha does not match the current blob');
    }
    const status: 200 | 201 = existing ? 200 : 201;
    const blob = this.putObject('blob', input.content);
    const files = new Map<string, { oid: string; mode: string }>();
    for (const [path, entry] of flat) files.set(path, { oid: entry.oid, mode: entry.mode });
    files.set(cleanPath, { oid: blob.oid, mode: existing ? existing.mode : '100644' });
    const { treeOid } = this.buildTreeForFiles(files);
    const seq = this.nextSeq();
    const login = this.viewerLogin ?? '';
    const commit = this.buildCommitObject({
      tree: treeOid,
      parents: tipOid === null ? [] : [tipOid],
      authorName: login,
      authorEmail: `${login}@example.invalid`,
      authorEpoch: deterministicEpoch(seq),
      committerName: login,
      committerEmail: `${login}@example.invalid`,
      committerEpoch: deterministicEpoch(seq),
      message: input.message,
    });
    this.setRef(input.repoDatabaseId, refName, commit.oid);
    return { blobSha: blob.oid, commitSha: commit.oid, status };
  }

  /** DELETE contents -> commit yang menghapus path (direktori yang menjadi
   *  kosong ikut hilang dari tree induk). sha disertakan dan salah ->
   *  StoreError 409. File tidak ada -> StoreError 404. */
  applyContentsDelete(input: ContentsDeleteInput): { commitSha: string } {
    const repo = this.getRepoById(input.repoDatabaseId);
    if (!repo) throw new StoreError(404, 'repository not found');
    const branch = input.branch === '' ? DEFAULT_BRANCH : input.branch;
    const refName = `refs/heads/${branch}`;
    const ref = this.getRef(input.repoDatabaseId, refName);
    if (!ref) throw new StoreError(404, 'branch not found');
    const cleanPath = input.path.replace(/^\/+/, '');
    let peeled = ref.oid;
    const seenTags = new Set<string>();
    while (true) {
      const obj = this.objects.get(peeled);
      if (!obj || obj.type !== 'tag' || seenTags.has(peeled)) break;
      seenTags.add(peeled);
      const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
      if (!firstLine.startsWith('object ')) break;
      peeled = firstLine.slice(7).trim();
    }
    const info = this.commits.get(peeled);
    if (!info) throw new StoreError(404, 'file not found');
    const flat = this.readTreeFlat(info.tree);
    const existing = flat.get(cleanPath);
    if (!existing) throw new StoreError(404, 'file not found');
    if (input.sha !== undefined && input.sha !== existing.oid) {
      throw new StoreError(409, 'sha does not match the current blob');
    }
    flat.delete(cleanPath);
    const files = new Map<string, { oid: string; mode: string }>();
    for (const [path, entry] of flat) files.set(path, { oid: entry.oid, mode: entry.mode });
    const { treeOid } = this.buildTreeForFiles(files);
    const seq = this.nextSeq();
    const login = this.viewerLogin ?? '';
    const commit = this.buildCommitObject({
      tree: treeOid,
      parents: [peeled],
      authorName: login,
      authorEmail: `${login}@example.invalid`,
      authorEpoch: deterministicEpoch(seq),
      committerName: login,
      committerEmail: `${login}@example.invalid`,
      committerEpoch: deterministicEpoch(seq),
      message: input.message,
    });
    this.setRef(input.repoDatabaseId, refName, commit.oid);
    return { commitSha: commit.oid };
  }

  // --- Label -----------------------------------------------------------------

  /** Buat label repo. Duplikat nama -> kembalikan yang sudah ada (201,
   *  idempotent). color disimpan apa adanya (tidak diasertasi suite). */
  createLabel(repoDatabaseId: number, input: { name: string; color: string }): Label {
    const repo = this.repos.get(repoDatabaseId) ?? null;
    if (repo === null) throw new StoreError(404, 'repository not found');
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new StoreError(422, 'label name is required');
    }
    let map = this.labels.get(repoDatabaseId);
    if (map === undefined) {
      map = new Map();
      this.labels.set(repoDatabaseId, map);
    }
    const existing = map.get(input.name);
    if (existing !== undefined) return existing;
    const label: Label = { name: input.name, color: input.color ?? '' };
    map.set(input.name, label);
    return label;
  }

  getLabel(repoDatabaseId: number, name: string): Label | null {
    return this.labels.get(repoDatabaseId)?.get(name) ?? null;
  }

  listLabels(repoDatabaseId: number): Label[] {
    const map = this.labels.get(repoDatabaseId);
    return map === undefined ? [] : [...map.values()];
  }

  hasLabel(repoDatabaseId: number, name: string): boolean {
    return this.labels.get(repoDatabaseId)?.has(name) ?? false;
  }

  // --- Issue -----------------------------------------------------------------

  /** Buat issue. Setiap label di input harus sudah ada (hasLabel) —
   *  satu label tak dikenal -> StoreError 422 (jangan auto-create).
   *  number dari repo.nextIssueNumber (mulai 1, +1). state awal 'open'.
   *  title/body disimpan verbatim. */
  createIssue(repoDatabaseId: number, input: CreateIssueInput): Issue {
    const repo = this.repos.get(repoDatabaseId) ?? null;
    if (repo === null) throw new StoreError(404, 'repository not found');
    const labels = [...new Set(input.labels ?? [])];
    for (const name of labels) {
      if (!this.hasLabel(repoDatabaseId, name)) {
        throw new StoreError(422, `label "${name}" does not exist`);
      }
    }
    const seq = this.nextSeq();
    const issue: Issue = {
      repoDatabaseId,
      number: repo.nextIssueNumber,
      title: input.title ?? '',
      body: input.body ?? '',
      state: 'open',
      labels,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.nextIssueNumber += 1;
    let map = this.issues.get(repoDatabaseId);
    if (map === undefined) {
      map = new Map();
      this.issues.set(repoDatabaseId, map);
    }
    map.set(issue.number, issue);
    return issue;
  }

  getIssue(repoDatabaseId: number, number: number): Issue | null {
    return this.issues.get(repoDatabaseId)?.get(number) ?? null;
  }

  /** Daftar issue repo. Filter state bila diberikan; sort 'created'
   *  menurut createdSeq (asc = tertua dulu, desc = terbaru dulu;
   *  default desc? — pemanggil GraphQL/REST menentukan; bila filter
   *  tidak menyebut direction, kembalikan asc = urutan pembuatan). */
  listIssues(
    repoDatabaseId: number,
    filter?: { state?: IssueState; sort?: 'created'; direction?: 'asc' | 'desc' },
  ): Issue[] {
    const map = this.issues.get(repoDatabaseId);
    let out: Issue[] = map === undefined ? [] : [...map.values()];
    if (filter?.state !== undefined) out = out.filter((issue) => issue.state === filter.state);
    const direction = filter?.direction ?? 'asc';
    out.sort((a, b) => (direction === 'desc' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
    return out;
  }

  /** Ubah state issue ('open' | 'closed'). Issue tidak ada ->
   *  StoreError 404. Mengembalikan issue sesudah diubah. */
  updateIssueState(repoDatabaseId: number, number: number, state: IssueState): Issue {
    const issue = this.issues.get(repoDatabaseId)?.get(number) ?? null;
    if (issue === null) throw new StoreError(404, 'issue not found');
    issue.state = state;
    issue.updatedSeq = this.nextSeq();
    return issue;
  }

  /** PATCH issue generik (title/body/labels bila diberikan). Hanya state
   *  yang diuji suite; method ini ada untuk kelengkapan — validasi label
   *  sama seperti createIssue (label tak dikenal -> 422). */
  updateIssue(
    repoDatabaseId: number,
    number: number,
    patch: { title?: string; body?: string; labels?: string[]; state?: IssueState },
  ): Issue {
    const issue = this.issues.get(repoDatabaseId)?.get(number) ?? null;
    if (issue === null) throw new StoreError(404, 'issue not found');
    if (patch.labels !== undefined) {
      for (const name of patch.labels) {
        if (!this.hasLabel(repoDatabaseId, name)) {
          throw new StoreError(422, `label "${name}" does not exist`);
        }
      }
      issue.labels = [...new Set(patch.labels)];
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) issue.state = patch.state;
    issue.updatedSeq = this.nextSeq();
    return issue;
  }

  // --- Komentar ---------------------------------------------------------------

  /** Tambah komentar ke issue. id dari counter global Store (mulai 1).
   *  Issue tidak ada -> StoreError 404. */
  addComment(repoDatabaseId: number, issueNumber: number, body: string): Comment {
    const issue = this.issues.get(repoDatabaseId)?.get(issueNumber) ?? null;
    if (issue === null) throw new StoreError(404, 'issue not found');
    const comment: Comment = {
      id: this.nextCommentId,
      repoDatabaseId,
      issueNumber,
      body,
      createdSeq: this.nextSeq(),
    };
    this.nextCommentId += 1;
    this.comments.set(comment.id, comment);
    const key = `${repoDatabaseId}:${issueNumber}`;
    const list = this.commentsByIssue.get(key);
    if (list === undefined) this.commentsByIssue.set(key, [comment]);
    else list.push(comment);
    return comment;
  }

  /** Komentar satu issue, urut id naik (= urutan pembuatan). */
  listComments(repoDatabaseId: number, issueNumber: number): Comment[] {
    const list = this.commentsByIssue.get(`${repoDatabaseId}:${issueNumber}`) ?? [];
    return [...list].sort((a, b) => a.id - b.id);
  }

  getCommentById(repoDatabaseId: number, id: number): Comment | null {
    const comment = this.comments.get(id) ?? null;
    if (comment === null || comment.repoDatabaseId !== repoDatabaseId) return null;
    return comment;
  }

  // --- Pull request -----------------------------------------------------------

  /** Buat PR. head/base adalah nama branch (tanpa 'refs/heads/').
   *  headSha = tip head saat ini; baseSha = tip base saat ini (dibekukan).
   *  Branch head/base tidak ada -> StoreError 422 (suite tidak menguji,
   *  tetapi 422 konsisten dengan validasi GitHub).
   *  number dari repo.nextPullNumber (mulai 1, +1; counter TERPISAH dari
   *  issue — architecture.md §10.2). */
  createPullRequest(repoDatabaseId: number, input: CreatePullRequestInput): PullRequest {
    const repo = this.repos.get(repoDatabaseId) ?? null;
    if (repo === null) throw new StoreError(404, 'repository not found');
    const headSha = this.resolveRef(repoDatabaseId, `refs/heads/${input.head}`);
    if (headSha === null) throw new StoreError(422, `head branch "${input.head}" does not exist`);
    const baseSha = this.resolveRef(repoDatabaseId, `refs/heads/${input.base}`);
    if (baseSha === null) throw new StoreError(422, `base branch "${input.base}" does not exist`);
    const pr: PullRequest = {
      repoDatabaseId,
      number: repo.nextPullNumber,
      title: input.title ?? '',
      body: input.body ?? '',
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.nextPullNumber += 1;
    let map = this.pullRequests.get(repoDatabaseId);
    if (map === undefined) {
      map = new Map();
      this.pullRequests.set(repoDatabaseId, map);
    }
    map.set(pr.number, pr);
    return pr;
  }

  getPullRequest(repoDatabaseId: number, number: number): PullRequest | null {
    return this.pullRequests.get(repoDatabaseId)?.get(number) ?? null;
  }

  /** Daftar PR repo. state 'all' (atau tidak difilter) = semua;
   *  'open'/'closed' = filter. Urut number naik. */
  listPullRequests(
    repoDatabaseId: number,
    filter?: { state?: PullRequestState | 'all' },
  ): PullRequest[] {
    const map = this.pullRequests.get(repoDatabaseId);
    let out: PullRequest[] = map === undefined ? [] : [...map.values()];
    if (filter?.state !== undefined && filter.state !== 'all') {
      out = out.filter((pr) => pr.state === filter.state);
    }
    out.sort((a, b) => a.number - b.number);
    return out;
  }

  /** Diff file antara dua commit (flatten tree base vs head):
   *  hanya di head -> 'added'; hanya di base -> 'removed';
   *  blob berbeda -> 'modified'. additions = jumlah baris di blob baru
   *  yang tidak ada di blob lama (set-difference per baris; file baru =
   *  semua baris); deletions analog; changes = additions + deletions.
   *  File 'modified' dengan isi berubah dijamin additions >= 1.
   *  Urut filename naik. */
  computeChangedFiles(repoDatabaseId: number, baseSha: string, headSha: string): ChangedFile[] {
    const baseInfo = this.getCommitInfo(baseSha);
    const headInfo = this.getCommitInfo(headSha);
    if (baseInfo === null || headInfo === null) throw new StoreError(404, 'commit not found');
    const baseFlat = this.readTreeFlat(baseInfo.tree);
    const headFlat = this.readTreeFlat(headInfo.tree);
    // Baris isi file: split '\n', buang '' akhir bila isi berakhir '\n'.
    const contentLines = (data: Buffer): string[] => {
      const text = data.toString('utf8');
      if (text === '') return [];
      const lines = text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const linesOf = (oid: string): string[] => contentLines(this.getObject(oid)?.data ?? Buffer.alloc(0));
    const names = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    const out: ChangedFile[] = [];
    for (const filename of [...names].sort()) {
      const baseEntry = baseFlat.get(filename);
      const headEntry = headFlat.get(filename);
      if (baseEntry !== undefined && headEntry !== undefined && baseEntry.oid === headEntry.oid) continue;
      if (baseEntry === undefined && headEntry !== undefined) {
        const count = linesOf(headEntry.oid).length;
        out.push({ filename, status: 'added', additions: count, deletions: 0, changes: count });
      } else if (baseEntry !== undefined && headEntry === undefined) {
        const count = linesOf(baseEntry.oid).length;
        out.push({ filename, status: 'removed', additions: 0, deletions: count, changes: count });
      } else if (baseEntry !== undefined && headEntry !== undefined) {
        const oldSet = new Set(linesOf(baseEntry.oid));
        const newSet = new Set(linesOf(headEntry.oid));
        let additions = 0;
        for (const line of newSet) if (!oldSet.has(line)) additions += 1;
        let deletions = 0;
        for (const line of oldSet) if (!newSet.has(line)) deletions += 1;
        // Isi berubah tetapi himpunan baris sama (mis. hanya newline akhir):
        // tetap laporkan >= 1 baris berubah agar 'modified' terhitung.
        if (additions === 0 && deletions === 0) additions = 1;
        out.push({ filename, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Three-way merge file-level (architecture.md §4.2):
   *  base = merge-base, ours = tip base saat ini, theirs = tip head.
   *  Per path: satu sisi berubah -> ambil yang berubah; kedua sisi sama
   *  -> ambil itu; kedua sisi berubah berbeda -> konflik (masuk daftar,
   *  tidak masuk merged). merged = map path -> isi byte hasil (file yang
   *  dihapus di satu sisi dan tidak diubah di sisi lain tidak masuk map). */
  threeWayMergeFiles(
    baseSha: string,
    oursSha: string,
    theirsSha: string,
  ): { merged: Map<string, Buffer>; conflicts: string[] } {
    const baseInfo = this.getCommitInfo(baseSha);
    const oursInfo = this.getCommitInfo(oursSha);
    const theirsInfo = this.getCommitInfo(theirsSha);
    if (baseInfo === null || oursInfo === null || theirsInfo === null) {
      throw new StoreError(404, 'commit not found');
    }
    const baseFlat = this.readTreeFlat(baseInfo.tree);
    const oursFlat = this.readTreeFlat(oursInfo.tree);
    const theirsFlat = this.readTreeFlat(theirsInfo.tree);
    const contentOf = (flat: Map<string, TreeEntry>, path: string): Buffer | undefined => {
      const entry = flat.get(path);
      if (entry === undefined) return undefined;
      return this.getObject(entry.oid)?.data;
    };
    const merged = new Map<string, Buffer>();
    const conflicts: string[] = [];
    const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
    for (const path of [...paths].sort()) {
      const baseOid = baseFlat.get(path)?.oid;
      const oursOid = oursFlat.get(path)?.oid;
      const theirsOid = theirsFlat.get(path)?.oid;
      if (oursOid === theirsOid) {
        // Kedua sisi sama (termasuk sama-sama tidak ada) -> ambil ours.
        if (oursOid !== undefined) {
          const content = contentOf(oursFlat, path);
          if (content !== undefined) merged.set(path, content);
        }
        continue;
      }
      if (oursOid === baseOid) {
        // Hanya theirs berubah -> ambil theirs (undefined = dihapus).
        if (theirsOid !== undefined) {
          const content = contentOf(theirsFlat, path);
          if (content !== undefined) merged.set(path, content);
        }
        continue;
      }
      if (theirsOid === baseOid) {
        // Hanya ours berubah -> ambil ours (undefined = dihapus).
        if (oursOid !== undefined) {
          const content = contentOf(oursFlat, path);
          if (content !== undefined) merged.set(path, content);
        }
        continue;
      }
      // Kedua sisi berubah secara berbeda (termasuk hapus-vs-ubah).
      conflicts.push(path);
    }
    return { merged, conflicts };
  }

  /** Squash merge PR (architecture.md §4.2). Hanya 'squash' yang
   *  didukung; mergeMethod lain (bila diberikan dan bukan 'squash') ->
   *  StoreError 405. PR tidak ada -> 404. PR sudah merged/closed ->
   *  {ok:false, conflicts:[], message:'pull request is already closed'}.
   *  Merge-base null atau konflik three-way -> {ok:false, conflicts,
   *  message:'Merge conflict in <path pertama>'} dan TIDAK ADA state
   *  yang berubah. Sukses: satu commit squash (parent = [tip base]),
   *  ref base digerakkan, PR state 'closed', merged true,
   *  mergedAt = deterministicIso(seq), mergeCommitSha terisi. */
  squashMergePullRequest(
    repoDatabaseId: number,
    number: number,
    input?: { mergeMethod?: string },
  ): MergeOutcome {
    if (input?.mergeMethod !== undefined && input.mergeMethod !== 'squash') {
      throw new StoreError(405, `merge method "${input.mergeMethod}" is not supported`);
    }
    const repo = this.repos.get(repoDatabaseId) ?? null;
    if (repo === null) throw new StoreError(404, 'repository not found');
    const pr = this.pullRequests.get(repoDatabaseId)?.get(number) ?? null;
    if (pr === null) throw new StoreError(404, 'pull request not found');
    if (pr.state === 'closed' || pr.merged) {
      return { ok: false, mergeCommitSha: null, conflicts: [], message: 'pull request is already closed' };
    }
    const baseRefName = `refs/heads/${pr.baseRef}`;
    const headRefName = `refs/heads/${pr.headRef}`;
    const baseShaNow = this.resolveRef(repoDatabaseId, baseRefName);
    const headShaNow = this.resolveRef(repoDatabaseId, headRefName);
    if (baseShaNow === null || headShaNow === null) {
      return { ok: false, mergeCommitSha: null, conflicts: [], message: 'base or head branch not found' };
    }
    const ancestor = this.mergeBase(baseShaNow, headShaNow);
    if (ancestor === null) {
      return { ok: false, mergeCommitSha: null, conflicts: [], message: 'no common ancestor (unrelated histories)' };
    }
    const { merged, conflicts } = this.threeWayMergeFiles(ancestor, baseShaNow, headShaNow);
    if (conflicts.length > 0) {
      return { ok: false, mergeCommitSha: null, conflicts, message: `Merge conflict in ${conflicts[0]}` };
    }
    const files = new Map<string, { oid: string; mode: string }>();
    for (const [path, content] of merged) {
      const blob = this.putObject('blob', content);
      files.set(path, { oid: blob.oid, mode: '100644' });
    }
    const { treeOid } = this.buildTreeForFiles(files);
    const login = this.viewerLogin !== null && this.viewerLogin !== '' ? this.viewerLogin : repo.owner;
    if (login === '') throw new StoreError(500, 'viewer login is not known');
    const seq = this.nextSeq();
    const epoch = deterministicEpoch(seq);
    const commit = this.buildCommitObject({
      tree: treeOid,
      parents: [baseShaNow],
      authorName: login,
      authorEmail: `${login}@example.invalid`,
      authorEpoch: epoch,
      committerName: login,
      committerEmail: `${login}@example.invalid`,
      committerEpoch: epoch,
      message: `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`,
    });
    this.setRef(repoDatabaseId, baseRefName, commit.oid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = deterministicIso(seq);
    pr.mergeCommitSha = commit.oid;
    return { ok: true, mergeCommitSha: commit.oid, conflicts: [], message: `Merged pull request #${pr.number}` };
  }

  // --- Global ID / node -------------------------------------------------------

  globalIdForRepo(repo: Repo): string {
    return encodeGlobalId('Repo', [repo.databaseId]);
  }

  globalIdForIssue(issue: Issue): string {
    return encodeGlobalId('Issue', [issue.repoDatabaseId, issue.number]);
  }

  globalIdForPullRequest(pr: PullRequest): string {
    return encodeGlobalId('PullRequest', [pr.repoDatabaseId, pr.number]);
  }

  globalIdForComment(comment: Comment): string {
    return encodeGlobalId('IssueComment', [comment.repoDatabaseId, comment.issueNumber, comment.id]);
  }

  /** Resolve global id ke objeknya. null bila id tidak valid atau objek
   *  tidak ada. Dipakai node(id:) dan semua mutasi GraphQL berbasis id. */
  resolveNode(id: string): { kind: GlobalIdKind; repo?: Repo; issue?: Issue; pullRequest?: PullRequest; comment?: Comment } | null {
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repo') {
      const repo = this.repos.get(Number(decoded.parts[0])) ?? null;
      if (repo === null) return null;
      return { kind: 'Repo', repo };
    }
    if (decoded.kind === 'Issue') {
      const repo = this.repos.get(Number(decoded.parts[0])) ?? null;
      const issue = repo === null ? null : (this.issues.get(repo.databaseId)?.get(Number(decoded.parts[1])) ?? null);
      if (repo === null || issue === null) return null;
      return { kind: 'Issue', repo, issue };
    }
    if (decoded.kind === 'PullRequest') {
      const repo = this.repos.get(Number(decoded.parts[0])) ?? null;
      const pr = repo === null ? null : (this.pullRequests.get(repo.databaseId)?.get(Number(decoded.parts[1])) ?? null);
      if (repo === null || pr === null) return null;
      return { kind: 'PullRequest', repo, pullRequest: pr };
    }
    const repo = this.repos.get(Number(decoded.parts[0])) ?? null;
    const comment = this.comments.get(Number(decoded.parts[2])) ?? null;
    if (repo === null || comment === null) return null;
    if (comment.repoDatabaseId !== Number(decoded.parts[0]) || comment.issueNumber !== Number(decoded.parts[1])) return null;
    return { kind: 'IssueComment', repo, comment };
  }

  // --- Snapshot -----------------------------------------------------------------

  /** Snapshot kanonik seluruh state (key terurut, array terurut) untuk
   *  debugging/ekspor. Byte-identik untuk urutan operasi yang sama.
   *  Bukan jalur panas — jangan dipanggil per request. */
  snapshotJson(): string {
    const refs: Array<{ repoDatabaseId: number; name: string; oid: string; kind: RefKind }> = [];
    for (const [repoId, map] of this.refs) {
      for (const ref of map.values()) {
        refs.push({ repoDatabaseId: repoId, name: ref.name, oid: ref.oid, kind: ref.kind });
      }
    }
    refs.sort((a, b) => a.repoDatabaseId - b.repoDatabaseId || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const objects = [...this.objects.values()]
      .map((o) => ({ oid: o.oid, type: o.type, data: o.data.toString('base64') }))
      .sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
    const commits = [...this.commits.values()]
      .sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
    const trees = [...this.trees.entries()]
      .map(([oid, entries]) => ({ oid, entries }))
      .sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
    const issues = [...this.issues.values()]
      .flatMap((m) => [...m.values()])
      .sort((a, b) => a.repoDatabaseId - b.repoDatabaseId || a.number - b.number);
    const labels = [...this.labels.entries()]
      .flatMap(([repoId, m]) => [...m.values()].map((l) => ({ repoDatabaseId: repoId, name: l.name, color: l.color })))
      .sort((a, b) => a.repoDatabaseId - b.repoDatabaseId || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const comments = [...this.comments.values()].sort((a, b) => a.id - b.id);
    const pullRequests = [...this.pullRequests.values()]
      .flatMap((m) => [...m.values()])
      .sort((a, b) => a.repoDatabaseId - b.repoDatabaseId || a.number - b.number);
    return canonicalStringify({
      viewerLogin: this.viewerLogin,
      seq: this.seq,
      nextRepoDatabaseId: this.nextRepoDatabaseId,
      nextCommentId: this.nextCommentId,
      repos: this.listAllRepos(),
      refs,
      objects,
      commits,
      trees,
      issues,
      labels,
      comments,
      pullRequests,
    });
  }
}
