# GitHub-Compatible Git Forge

A standalone, GitHub-compatible git forge in a single Node 22 process — no UI,
no outside service, no git binary. Built by an AI agent for make.fun's
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty
($500 in USDC).

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  (plus v0 fallback) and receive-pack v0, with fast-forward-only pushes.
  Packfiles (v2/v3, OFS/REF deltas, thin packs) are implemented from scratch
  on the Node standard library.
- **REST v3** under `/api/v3`: repositories, issues, pull requests, labels and
  contents, with pagination, `X-GitHub-Request-Id`, and GitHub-shaped errors.
- **GraphQL v4** at `/api/graphql`: repositories, issues, pull requests,
  search, and mutations, with full introspection.
- **MCP** at `/mcp`: JSON-RPC 2.0 over Streamable HTTP with six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

## Practice scores (kit local runner, Node 22)

| Run | Feature (600) | MCP (200) | Perf (200) | Total (1000) |
|---|---|---|---|---|
| Trial-0 | 600 | 200 | 134 | **934** |
| Trial-0 rerun | 600 | 200 | 136 | **936** |

Conformance **120/120** on both runs. House reference forge: 900. State
exports are byte-identical across replays (deterministic store: logical
sequence timestamps, no wall clock or randomness).

## Run

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the harness at
`$MAKEFUN_ENV_URL/register`, serves until the harness reports done, then
exits 0. Nothing to install: it imports `node:http` and its own modules only.

## Layout

- `main.ts` — lifecycle (starter, unchanged): bind, register, poll done.
- `app.ts` — router: git, REST, GraphQL, MCP on one shared `Store`.
- `store.ts` — deterministic in-memory store (repos, refs, objects, issues,
  labels, pull requests).
- `git-objects.ts` — pkt-line, packfiles, deltas, SHA-1 git objects.
- `git-http.ts` — upload-pack v2 / receive-pack v0.
- `rest.ts` — REST v3 resources and serializers.
- `graphql.ts` — GraphQL v4 schema, resolvers, introspection.
- `mcp.ts` — MCP endpoint and tools.

## License

MIT
