// Entry point: the conversation between this forge and the harness that runs
// it. The harness (the "env") starts next to us, waits for us to tell it which
// port we bound, drives our forge through the suite, and finally tells us the
// trial is over. Our whole job here is that handshake:
//
//   - Read the env's origin from MAKEFUN_ENV_URL. With no origin there is no
//     harness to talk to, so we stop right away with exit code 1.
//   - Start the forge (app.ts) on a port the kernel picks for us (listen on
//     port 0). Port 8080 belongs to the env; we never touch it.
//   - Announce the port with POST /register. The env remembers the address
//     our request came from plus that port and calls us there from then on.
//     The first registration wins: a 409 only means someone else already
//     registered, which is not ours to fix, so we carry on waiting.
//   - Ask GET /done over and over until it says {"done": true}. The env
//     answers immediately every time ({"done": false} while the suite is
//     still running), so this is a plain poll. A failed or slow poll just
//     means "not done yet" and we try again after a short wait.
//   - Close the server and exit 0. The harness then stops the env, which
//     writes the export the scorer reads.
//
// Nothing here calls a model and nothing here is the contest itself: the
// forge lives in app.ts and its modules, this file only runs the handshake.

import { createApp } from './app.ts';

// Where the harness lives, without any trailing slash.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request gets this long before we give up on it.
const CALL_BUDGET_MS = 30_000;
// The pause after a failed attempt starts here and doubles, up to this cap.
const PAUSE_FIRST_MS = 250;
const PAUSE_MAX_MS = 2_000;

/** Wait `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait after the `n`th failed attempt: the first pause, doubled
 * each time, never above the cap.
 */
function pauseAfter(n: number): number {
  return Math.min(PAUSE_MAX_MS, PAUSE_FIRST_MS * 2 ** Math.min(n, 8));
}

/**
 * Tell the env which port we bound, and keep trying until it accepts. A 200
 * is the normal answer and a 409 means a first register already won, so both
 * end the loop. A 400 or 405 is a contract error and ends the program. Any
 * other failure (the env still starting, a dropped connection, another
 * status) is retried, since the env may simply not be ready yet.
 */
async function announcePort(port: number): Promise<void> {
  for (let n = 0; ; n += 1) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(pauseAfter(n));
  }
}

/**
 * Poll GET /done until the env says the trial is over. A successful reply
 * whose body is {"done": true} ends the wait; anything else — a false body,
 * a bad status, a timeout — just means we poll again.
 */
async function awaitFinish(): Promise<void> {
  for (let n = 0; ; n += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(CALL_BUDGET_MS) });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: not done, so keep polling.
    }
    await pause(pauseAfter(n));
  }
}

/** Bind the forge, announce it, then wait for the env: the process's life. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitFinish();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
