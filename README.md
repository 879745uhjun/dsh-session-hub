# dsh-session-hub

Read-only aggregation of the per-session metadata that the small DSH plugins already keep in their own files. One `GET /session-meta` returns a single session map for the workspace UI and for other plugins, instead of four routes and four reads.

This package currently ships **P2-⑨ only** (Host aggregation, `0.1.0`). The browser event bus (`window.dshSessionEvents`, P2-⑩) lands in a later minor; `client.js` is a lazy shell until then.

**It never writes.** Every source file stays owned by its plugin; this one only reads.

## Route

```
GET /session-meta
```

```json
{
  "ok": true,
  "generatedAt": 1795000000000,
  "truncated": false,
  "total": 12,
  "sources": {
    "stars":  { "state": "ok",      "updatedAt": 1794990000000, "count": 5 },
    "todos":  { "state": "empty",   "updatedAt": 1794990001000, "count": 0 },
    "boxes":  { "state": "ok",      "updatedAt": 1794990002000, "count": 3 },
    "notify": { "state": "missing", "updatedAt": 0,             "count": 0 }
  },
  "sessions": {
    "session-abc": { "stars": 0, "todo": { "done": false, "priority": "high", "dueAt": 1795000000000 }, "boxes": ["b_1"], "watching": true }
  }
}
```

- `stars` is `0..5`; **`0` is a recorded rating and differs from the field being absent**.
- `todo` appears only when that session has one; `boxes` only when it belongs to a box; `watching` only when the finish alert is on.
- `sources.<name>.state` is one of `ok`, `missing`, `invalid`, `empty`; a broken source never hides the others.

## Sources

| Source | File under `$DSH_HOME` | Read key | `count` |
| --- | --- | --- | --- |
| `stars` | `session-stars.json` | `ratings[session].stars` | rating entries |
| `todos` | `session-todos.json` | `todos[session]` → `done`, `priority`, `dueAt` | todo entries |
| `boxes` | `session-boxes.json` | `memberships[session]` → box ids (unknown boxes dropped) | boxes in `boxes[]` |
| `notify` | `session-notify.json` | `watched[session]` exists → `watching: true` | watched sessions |

Each file is read once per request, is capped at 4 MiB (larger files report `invalid` with `reason: "too-large"`), and the union is capped at 2000 sessions (`truncated: true`, `total` keeps the real count).

## Caching

The response carries `ETag` derived from the four files' `(size, mtimeMs)` stamps. Send `If-None-Match` and the route answers `304` with no body when nothing changed. Only `GET` and `HEAD` are accepted (`405` otherwise), and a cross-origin caller gets `403`.

## Browser event bus (P2-⑩, 0.3.0)

The client half publishes one global emitter while the plugin is loaded:

```js
window.__dshSessionEvents = {   // primary name
  version: 1,
  emit({ source, sessionId, kind }),   // source is required, 1..32 characters
  on(listener) => off,                 // off is idempotent
}
window.dshSessionEvents              // same object, public alias
```

The bus never overwrites a name that is already taken. A second live instance
(or a foreign object) pushes the next one to a versioned pair:
`__dshSessionEvents.v2` + `dshSessionEvents.v2`, then `.v3`, up to `.v9`.
Consumers should read `window.__dshSessionEvents ?? window['__dshSessionEvents.v2'] ?? window.dshSessionEvents`.

It bridges the three data plugins into one stream:

| source | stream | event | payload key |
| --- | --- | --- | --- |
| `todos` | `/session-todos/events` | `todos` | `todos` |
| `stars` | `/session-stars/events` | `ratings` | `ratings` |
| `notify` | `/session-notify/events` | `watched` | `watched` |

On connect each source emits one `{ source, sessionId: null, kind: 'snapshot' }`.
The frames carry the whole map, so the bus keeps the previous snapshot and
emits `kind: 'changed'` only for the session ids whose entry appeared,
changed, or disappeared. Malformed frames are ignored, and a missing
`EventSource` or a 404 route is skipped.

Unloading the plugin closes only its own streams and removes exactly the names
this instance claimed (the alias is skipped when it was already taken), so a
reload never disturbs another live instance.

```js
const bus = window.__dshSessionEvents ?? window.dshSessionEvents
const off = bus.on(async (event) => {
  if (event.source !== 'todos') return
  const meta = await fetch('/session-meta').then((response) => response.json())
  // use meta.sessions[event.sessionId]
})
```

## Install

The bundle declares `dsh.bundle.patch`; install it through **Plugins → Add plugin** or the plugin manager's `install_bundle`. This repository does not install itself.

## Tests

```bash
npm test
```

`pretest` runs `scripts/check-syntax.mjs` over every source, then the suite covers aggregation, per-source degradation, truncation, ETag/304, 403, 405, and HEAD.
