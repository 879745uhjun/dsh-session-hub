/**
 * dsh-session-hub — Host half.
 *
 * Read-only aggregation of the per-session metadata that the small DSH plugins
 * already keep in their own JSON files: star ratings, session todos, session
 * boxes, and finish-alert watches. One GET returns a single map for the
 * workspace UI and for other plugins, so a consumer stops reading four files
 * and four routes by hand.
 *
 *  - GET /session-meta returns the aggregated map with an ETag;
 *  - GET /session-meta with a matching If-None-Match answers 304.
 *
 * This plugin never writes, deletes, or reshapes those files: each one stays
 * owned by its plugin. A source that is missing, unreadable, or malformed is
 * reported in `sources` and does not affect the other sources.
 *
 * @module dsh-session-hub
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-session-hub'

/** Same-origin route the browser half and other plugins read. */
const ROUTE = '/session-meta'
/** Largest source file accepted; bigger files are reported invalid. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
/** Most sessions returned in one document. */
const MAX_SESSIONS = 2000
/** Highest star level accepted. */
const MAX_STARS = 5
/** Accepted todo priorities. */
const PRIORITIES = ['low', 'normal', 'high']

/** File names and the state a source can be in. */
const SOURCE_FILES = {
  stars: 'session-stars.json',
  todos: 'session-todos.json',
  boxes: 'session-boxes.json',
  notify: 'session-notify.json',
}

/** One warning sink that reports each distinct failure once. */
function createLogger() {
  const seen = new Set()
  return (message, error) => {
    const key = error === undefined ? message : message + ': ' + (error?.code ?? error?.message ?? String(error))
    if (seen.has(key)) return
    seen.add(key)
    if (error !== undefined) console.warn('[session-hub] ' + message, error)
    else console.warn('[session-hub] ' + message)
  }
}

/** A non-negative integer timestamp, or 0. */
function toTimestamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

/** A session id, or null. */
function normalizeSessionId(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id === '' ? null : id
}

/** A box id, or null. */
function normalizeBoxId(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id === '' ? null : id
}

/** Clamp one star level into 0..5; anything unusable is 0. */
function clampStars(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.min(Math.trunc(number), MAX_STARS)
}

/** A 0..5 star value, or null when the entry is unusable. */
function readRating(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value.stars
  if (raw === undefined) return null
  const stars = Number(raw)
  if (!Number.isFinite(stars) || stars < 0) return null
  return Math.min(Math.trunc(stars), MAX_STARS)
}

/** One todo entry, or null when it carries nothing usable. */
function readTodo(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const done = value.done === true
  const priority = PRIORITIES.includes(value.priority) ? value.priority : 'normal'
  const dueAt = toTimestamp(value.dueAt)
  if (!done && priority === 'normal' && dueAt === 0) return null
  return { done, priority, dueAt }
}

/**
 * Read and validate one source file once.
 * @param path - absolute source file path.
 * @returns a state record with the parsed value (or null).
 */
async function readSource(path) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    return {
      state: error?.code === 'ENOENT' ? 'missing' : 'invalid',
      updatedAt: 0,
      count: 0,
      reason: error?.code === 'ENOENT' ? undefined : 'stat',
      value: null,
      stamp: 'absent',
    }
  }
  const updatedAt = Math.floor(info.mtimeMs)
  const stamp = info.size + ':' + Math.floor(info.mtimeMs)
  if (info.size > MAX_SOURCE_BYTES) {
    return { state: 'invalid', updatedAt, count: 0, reason: 'too-large', value: null, stamp }
  }
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { state: 'invalid', updatedAt, count: 0, reason: 'read', value: null, stamp }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: 'invalid', updatedAt, count: 0, reason: 'json', value: null, stamp }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'invalid', updatedAt, count: 0, reason: 'shape', value: null, stamp }
  }
  return {
    state: 'ok',
    updatedAt: toTimestamp(parsed.updatedAt) || updatedAt,
    count: 0,
    value: parsed,
    stamp,
  }
}

/** Stars: ratings[session] = { stars } — 0 is kept and differs from absence. */
function collectStars(source) {
  const ratings = source.value?.ratings
  if (ratings === null || ratings === undefined || typeof ratings !== 'object' || Array.isArray(ratings)) {
    return { state: 'invalid', count: 0, reason: 'ratings' }
  }
  const bySession = new Map()
  for (const [rawId, entry] of Object.entries(ratings)) {
    const sessionId = normalizeSessionId(rawId)
    if (sessionId === null) continue
    const stars = readRating(entry)
    if (stars === null) continue
    bySession.set(sessionId, stars)
  }
  return { state: bySession.size === 0 ? 'empty' : 'ok', count: bySession.size, bySession }
}

/** Todos: todos[session] = { done, priority, dueAt }. */
function collectTodos(source) {
  const todos = source.value?.todos
  if (todos === null || todos === undefined || typeof todos !== 'object' || Array.isArray(todos)) {
    return { state: 'invalid', count: 0, reason: 'todos' }
  }
  const bySession = new Map()
  for (const [rawId, entry] of Object.entries(todos)) {
    const sessionId = normalizeSessionId(rawId)
    if (sessionId === null) continue
    const todo = readTodo(entry)
    if (todo === null) continue
    bySession.set(sessionId, todo)
  }
  return { state: bySession.size === 0 ? 'empty' : 'ok', count: bySession.size, bySession }
}

/** Boxes: memberships[session] = [box ids]; the box list supplies the count. */
function collectBoxes(source) {
  const boxes = Array.isArray(source.value?.boxes) ? source.value.boxes : []
  const memberships = source.value?.memberships
  if (memberships === null || memberships === undefined || typeof memberships !== 'object' || Array.isArray(memberships)) {
    return { state: 'invalid', count: 0, reason: 'memberships' }
  }
  const known = new Set()
  for (const box of boxes) {
    if (box !== null && typeof box === 'object' && typeof box.id === 'string') known.add(box.id)
  }
  const bySession = new Map()
  for (const [rawId, ids] of Object.entries(memberships)) {
    const sessionId = normalizeSessionId(rawId)
    if (sessionId === null || !Array.isArray(ids)) continue
    const clean = []
    for (const id of ids) {
      const boxId = normalizeBoxId(id)
      if (boxId !== null && (known.size === 0 || known.has(boxId)) && !clean.includes(boxId)) clean.push(boxId)
    }
    if (clean.length > 0) bySession.set(sessionId, clean)
  }
  return {
    state: bySession.size === 0 ? 'empty' : 'ok',
    count: boxes.length,
    bySession,
  }
}

/** Notify: watched[session] exists → watching true. */
function collectWatched(source) {
  const watched = source.value?.watched
  if (watched === null || watched === undefined || typeof watched !== 'object' || Array.isArray(watched)) {
    return { state: 'invalid', count: 0, reason: 'watched' }
  }
  const watching = new Set()
  for (const rawId of Object.keys(watched)) {
    const sessionId = normalizeSessionId(rawId)
    if (sessionId !== null) watching.add(sessionId)
  }
  return { state: watching.size === 0 ? 'empty' : 'ok', count: watching.size, watching }
}

/**
 * Build the aggregated document.
 * @param reads - the four source reads keyed by source name.
 * @returns the document body.
 */
function buildMeta(reads) {
  // A file that could not be read or parsed already knows why; its collector
  // would only overwrite that reason, so use the read verdict directly.
  const settled = (key, collect) => (reads[key].state === 'ok'
    ? collect(reads[key])
    : { state: reads[key].state, count: 0, reason: reads[key].reason })
  const stars = settled('stars', collectStars)
  const todos = settled('todos', collectTodos)
  const boxes = settled('boxes', collectBoxes)
  const watched = settled('notify', collectWatched)

  const order = []
  const seen = new Set()
  for (const id of stars.bySession?.keys?.() ?? []) { if (!seen.has(id)) { seen.add(id); order.push(id) } }
  for (const id of todos.bySession?.keys?.() ?? []) { if (!seen.has(id)) { seen.add(id); order.push(id) } }
  for (const id of boxes.bySession?.keys?.() ?? []) { if (!seen.has(id)) { seen.add(id); order.push(id) } }
  for (const id of watched.watching?.values?.() ?? []) { if (!seen.has(id)) { seen.add(id); order.push(id) } }

  const total = order.length
  const sessions = {}
  for (const sessionId of order.slice(0, MAX_SESSIONS)) {
    const entry = {}
    const star = stars.bySession?.get(sessionId)
    if (star !== undefined) entry.stars = star
    const todo = todos.bySession?.get(sessionId)
    if (todo !== undefined) entry.todo = todo
    const boxIds = boxes.bySession?.get(sessionId)
    if (boxIds !== undefined) entry.boxes = boxIds
    if (watched.watching?.has(sessionId) === true) entry.watching = true
    sessions[sessionId] = entry
  }

  return {
    ok: true,
    generatedAt: Date.now(),
    truncated: total > MAX_SESSIONS,
    total,
    sources: {
      stars: { state: stars.state, updatedAt: reads.stars.updatedAt, count: stars.count, reason: stars.reason },
      todos: { state: todos.state, updatedAt: reads.todos.updatedAt, count: todos.count, reason: todos.reason },
      boxes: { state: boxes.state, updatedAt: reads.boxes.updatedAt, count: boxes.count, reason: boxes.reason },
      notify: { state: watched.state, updatedAt: reads.notify.updatedAt, count: watched.count, reason: watched.reason },
    },
    sessions,
  }
}

/** One ETag over the four source stamps. */
function etagFor(reads) {
  const text = ['stars', 'todos', 'boxes', 'notify'].map((name) => name + '=' + reads[name].stamp).join('|')
  return '"' + createHash('sha1').update(text).digest('hex') + '"'
}

/** Answer one JSON response. */
function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    ...extraHeaders,
  })
  response.end(body)
}

/** Refuse a cross-site caller; same-origin requests pass. */
function isAcceptableOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * Build the HTTP handler over one DSH home directory.
 * @param home - absolute DSH home.
 * @returns the request handler.
 */
function createMetaHandler(home) {
  return async function handleSessionMeta(request, response) {
    if (!isAcceptableOrigin(request)) {
      sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      return
    }
    try {
      const reads = {}
      await Promise.all(Object.entries(SOURCE_FILES).map(async ([key, file]) => {
        reads[key] = await readSource(join(home, file))
      }))
      const etag = etagFor(reads)
      const previous = request.headers['if-none-match']
      if (typeof previous === 'string' && (previous === '*' || previous.split(',').some((value) => value.trim() === etag))) {
        response.writeHead(304, { etag, 'cache-control': 'no-cache' })
        response.end()
        return
      }
      const body = buildMeta(reads)
      const text = JSON.stringify(body)
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-cache',
        etag,
      })
      if (request.method === 'HEAD') response.end()
      else response.end(text)
    } catch (error) {
      console.warn('[session-hub] request failed', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/**
 * Register the read-only aggregation route.
 * @param ctx - Host context carrying the web server and the DSH home path.
 */
export function apply(ctx) {
  const homePath = ctx.get('dshHomePath')
  const home = typeof homePath === 'function' ? homePath() : join(homedir(), '.dsh')
  const log = createLogger()
  const handler = createMetaHandler(home)

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: ROUTE, handler }), 'session-hub: meta route')
  })
}
