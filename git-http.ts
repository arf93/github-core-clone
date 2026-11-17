// git-http.ts — smart HTTP git: info/refs, upload-pack (v2 + v0), receive-pack.
//
// Memakai git-objects.ts + Store. Tidak menyimpan state sendiri.
// TypeScript erasable saja; tanpa Date.now()/Math.random()/UUID.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, ZERO_OID } from './store.ts';
import type { Repo } from './store.ts';
import {
  buildPack,
  decodePktLines,
  encodeDelim,
  encodeFlush,
  parsePack,
  pktLineString,
  tagTargetOid,
  wrapSideband,
} from './git-objects.ts';

const HEX40 = /^[0-9a-f]{40}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// ---------------------------------------------------------------------------
// Helper HTTP / parsing kecil
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.length) });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(body, 'utf8'));
}

interface GitPath {
  owner: string;
  repo: string;
  rest: string;
  url: URL;
}

function parseGitPath(rawUrl: string): GitPath | null {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter((p) => p !== '');
  if (parts.length < 3) return null;
  const owner = parts[0];
  const repoGit = parts[1];
  if (!repoGit.endsWith('.git')) return null;
  if (!NAME_RE.test(owner)) return null;
  const repo = repoGit.slice(0, -4);
  if (repo === '' || repo.endsWith('.git') || !NAME_RE.test(repo)) return null;
  return { owner, repo, rest: parts.slice(2).join('/'), url };
}

/**
 * Resolve repo untuk jalur git. Repo yang sudah terikat owner dipakai
 * langsung; repo pending (owner '') diikat ke owner di path lewat
 * bindOwner (lazy binding, architecture.md §3.3). Repo milik owner lain
 * -> null (pemanggil menjawab 404, bukan 403).
 */
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  const direct = store.getRepoByOwnerAndName(owner, name);
  if (direct) return direct;
  const byName = store.findRepoByName(name);
  if (!byName || byName.owner !== '') return null;
  try {
    return store.bindOwner(byName.databaseId, owner);
  } catch {
    return null;
  }
}

/** Ikuti rantai tag sampai commit; null bila target bukan commit. */
function peelToCommit(store: Store, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = store.getObject(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const target = tagTargetOid(obj.data);
    if (target === null) return null;
    current = target;
  }
}

function isVersion2(req: IncomingMessage): boolean {
  const value = req.headers['git-protocol'];
  return typeof value === 'string' && value.trim() === 'version=2';
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

function buildV0Advertisement(store: Store, repo: Repo, caps: string, service: string): Buffer {
  const chunks: Buffer[] = [];
  const refs = store.listRefs(repo.databaseId);
  chunks.push(pktLineString(`# service=${service}\n`));
  chunks.push(encodeFlush());
  if (refs.length === 0) {
    chunks.push(pktLineString(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      chunks.push(pktLineString(`${ref.oid} ${ref.name}${suffix}\n`));
      const peeled = peelToCommit(store, ref.oid);
      if (peeled !== null && peeled !== ref.oid) {
        chunks.push(pktLineString(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  chunks.push(encodeFlush());
  return Buffer.concat(chunks);
}

function buildV2Advertisement(): Buffer {
  const chunks: Buffer[] = [
    pktLineString('# service=git-upload-pack\n'),
    encodeFlush(),
    pktLineString('version 2\n'),
    pktLineString('fetch=shallow\n'),
    pktLineString('ls-refs=unborn\n'),
    pktLineString('object-format=sha1\n'),
    pktLineString('agent=forge/1.0\n'),
    encodeFlush(),
  ];
  return Buffer.concat(chunks);
}

async function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  service: string,
): Promise<void> {
  if (service === 'git-receive-pack') {
    const caps = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0';
    const body = buildV0Advertisement(store, repo, caps, 'git-receive-pack');
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', body);
    return;
  }
  if (service === 'git-upload-pack') {
    if (isVersion2(req)) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', buildV2Advertisement());
      return;
    }
    const caps = 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0';
    const body = buildV0Advertisement(store, repo, caps, 'git-upload-pack');
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', body);
    return;
  }
  sendText(res, 404, 'unknown service\n');
}

// ---------------------------------------------------------------------------
// Upload-pack: ls-refs + fetch
// ---------------------------------------------------------------------------

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
}

function planFetch(store: Store, plan: FetchPlan): { pack: Buffer; boundary: string[] } {
  const haveAll = [...plan.haves, ...plan.shallows];
  if (plan.depth !== null) {
    const result = store.reachableExcludingAtDepth(plan.wants, haveAll, plan.depth);
    return { pack: buildPack(result.objects.values()), boundary: result.shallowBoundary };
  }
  const objects = store.reachableExcluding(plan.wants, haveAll);
  return { pack: buildPack(objects.values()), boundary: [] };
}

function handleLsRefs(res: ServerResponse, store: Store, repo: Repo, args: string[]): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const refs = store.listRefs(repo.databaseId);
  const headTarget = store.getHeadTarget(repo.databaseId);
  const mainRef = refs.find((r) => r.name === headTarget);
  const lines: string[] = [];
  if (prefixes.length === 0 && symrefs) {
    if (mainRef) {
      lines.push(`${mainRef.oid} HEAD symref-target:${headTarget}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${headTarget}\n`);
    }
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelToCommit(store, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const chunks: Buffer[] = lines.map((line) => pktLineString(line));
  chunks.push(encodeFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(chunks));
}

function handleFetchV2(res: ServerResponse, store: Store, plan: FetchPlan): void {
  const { pack, boundary } = planFetch(store, plan);
  const chunks: Buffer[] = [];
  chunks.push(pktLineString('acknowledgments\n'));
  chunks.push(pktLineString('NAK\n'));
  chunks.push(encodeDelim());
  if (boundary.length > 0) {
    chunks.push(pktLineString('shallow-info\n'));
    for (const oid of boundary) chunks.push(pktLineString(`shallow ${oid}\n`));
    chunks.push(encodeDelim());
  }
  chunks.push(pktLineString('packfile\n'));
  chunks.push(wrapSideband(1, pack));
  chunks.push(encodeFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(chunks));
}

function handleFetchV0(res: ServerResponse, store: Store, plan: FetchPlan): void {
  const { pack, boundary } = planFetch(store, plan);
  const chunks: Buffer[] = [];
  chunks.push(pktLineString('NAK\n'));
  for (const oid of boundary) chunks.push(pktLineString(`shallow ${oid}\n`));
  chunks.push(wrapSideband(1, pack));
  chunks.push(encodeFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(chunks));
}

function parseV2Args(args: string[]): FetchPlan {
  const plan: FetchPlan = { wants: [], haves: [], shallows: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      const oid = arg.slice(5, 45);
      if (HEX40.test(oid)) plan.wants.push(oid);
    } else if (arg.startsWith('have ')) {
      const oid = arg.slice(5, 45);
      if (HEX40.test(oid)) plan.haves.push(oid);
    } else if (arg.startsWith('shallow ')) {
      const oid = arg.slice(8, 48);
      if (HEX40.test(oid)) plan.shallows.push(oid);
    } else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) plan.depth = n;
    }
  }
  return plan;
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  if (isVersion2(req)) {
    let decoded;
    try {
      decoded = decodePktLines(body);
    } catch {
      sendText(res, 400, 'malformed pkt-line request\n');
      return;
    }
    const dataPackets = decoded.packets.filter((p) => p.kind === 'data');
    if (dataPackets.length === 0) {
      sendText(res, 400, 'malformed pkt-line request\n');
      return;
    }
    const first = dataPackets[0].payload.toString('utf8').trim();
    if (!first.startsWith('command=')) {
      sendText(res, 400, 'malformed pkt-line request\n');
      return;
    }
    const command = first.slice('command='.length).trim();
    const args = dataPackets.slice(1).map((p) => p.payload.toString('utf8').trim());
    if (command === 'ls-refs') {
      handleLsRefs(res, store, repo, args);
      return;
    }
    if (command === 'fetch') {
      handleFetchV2(res, store, parseV2Args(args));
      return;
    }
    sendText(res, 400, 'unknown command\n');
    return;
  }
  // v0: section 1 (want/shallow/deepen) + flush, section 2 (have/done) + flush.
  let decoded;
  try {
    decoded = decodePktLines(body);
  } catch {
    sendText(res, 400, 'malformed pkt-line request\n');
    return;
  }
  const plan: FetchPlan = { wants: [], haves: [], shallows: [], depth: null };
  let section = 1;
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush' || packet.kind === 'delim') {
      section = 2;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (HEX40.test(oid)) plan.wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (HEX40.test(oid)) plan.shallows.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) plan.depth = n;
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (HEX40.test(oid)) plan.haves.push(oid);
    }
  }
  if (plan.wants.length === 0 && section === 1 && decoded.packets.length === 0) {
    sendText(res, 400, 'malformed pkt-line request\n');
    return;
  }
  handleFetchV0(res, store, plan);
}

// ---------------------------------------------------------------------------
// Receive-pack (push, v0)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function sendPushReport(res: ServerResponse, unpackLine: string, results: Array<{ ref: string; ok: boolean; reason: string | null }>): void {
  const lines: string[] = [unpackLine];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'error'}\n`);
  }
  const report = Buffer.concat(lines.map((line) => pktLineString(line)));
  const body = Buffer.concat([wrapSideband(1, report), encodeFlush()]);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', body);
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  let decoded;
  try {
    decoded = decodePktLines(body);
  } catch {
    sendText(res, 400, 'malformed pkt-line request\n');
    return;
  }
  const commands: PushCommand[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush' || packet.kind === 'delim') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const main = text.split('\0')[0].trim();
    const parts = main.split(/\s+/);
    if (parts.length !== 3 || !HEX40.test(parts[0]) || !HEX40.test(parts[1]) || !parts[2].startsWith('refs/')) {
      sendText(res, 400, 'malformed push command\n');
      return;
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) {
    sendText(res, 400, 'no push commands\n');
    return;
  }
  if (decoded.trailing.length > 0) {
    let parsed;
    try {
      parsed = parsePack(decoded.trailing);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'pack error';
      sendPushReport(res, `unpack ${message}\n`, []);
      return;
    }
    for (const obj of parsed.objects.values()) {
      store.putObject(obj.type, obj.data);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string | null }> = [];
  for (const cmd of commands) {
    if (cmd.newOid === ZERO_OID) {
      const existing = store.getRef(repo.databaseId, cmd.ref);
      if (!existing) {
        results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
        continue;
      }
      if (existing.oid !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      store.deleteRef(repo.databaseId, cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: null });
      continue;
    }
    if (!store.hasObject(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    const ff = store.checkFastForward(repo.databaseId, cmd.ref, cmd.oldOid, cmd.newOid);
    if (!ff.ok) {
      results.push({ ref: cmd.ref, ok: false, reason: ff.reason ?? 'non-fast-forward' });
      continue;
    }
    store.setRef(repo.databaseId, cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: null });
  }
  sendPushReport(res, 'unpack ok\n', results);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Tangani satu request git smart-HTTP. Mengembalikan true bila rute git
 * ditangani (termasuk 404 repo tak dikenal), false bila path bukan rute
 * git sehingga pemanggil (app.ts) dapat me-routing ke handler lain.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ctx: { ownerLogin: string },
): Promise<boolean> {
  const parsed = parseGitPath(req.url ?? '');
  if (!parsed) return false;
  try {
    // Bila viewer belum terikat (ownerLogin ''), lewati gate ini dan biarkan
    // resolveRepo melakukan lazy binding dari nama repo; bila sudah terikat,
    // owner lain tetap 404 (bukan 403).
    if (ctx.ownerLogin !== '' && parsed.owner !== ctx.ownerLogin) {
      sendText(res, 404, 'repository not found\n');
      return true;
    }
    const repo = resolveRepo(store, parsed.owner, parsed.repo);
    if (!repo) {
      sendText(res, 404, 'repository not found\n');
      return true;
    }
    if (req.method === 'GET' && parsed.rest === 'info/refs') {
      const service = parsed.url.searchParams.get('service') ?? '';
      await handleInfoRefs(req, res, store, repo, service);
      return true;
    }
    if (req.method === 'POST' && parsed.rest === 'git-upload-pack') {
      await handleUploadPack(req, res, store, repo);
      return true;
    }
    if (req.method === 'POST' && parsed.rest === 'git-receive-pack') {
      await handleReceivePack(req, res, store, repo);
      return true;
    }
    sendText(res, 404, 'not found\n');
    return true;
  } catch (err) {
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : 'internal error';
      sendText(res, 500, `internal error: ${message}\n`);
    } else {
      try {
        res.end();
      } catch {
        // abaikan: koneksi sudah bermasalah
      }
    }
    return true;
  }
}
