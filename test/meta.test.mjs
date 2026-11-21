import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** A Host context fake: one home path, one captured web route. */
function createHarness(home) {
  const routes = new Map()
  const disposers = []
  const webServer = {
    register({ path, handler }) {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  }
  const scope = {
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer,
  }
  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return (...parts) => join(home, ...parts)
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(services, callback) {
      if (services.includes('webServer')) callback(scope)
    },
  }
  return {
    ctx,
    routes,
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

/** Write one JSON source file. */
async function writeSource(home, name, value) {
  await writeFile(join(home, name), JSON.stringify(value), 'utf8')
}

/** Run one request against the captured /session-meta handler. */
async function withRoute(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-hub-'))
  const harness = createHarness(home)
  apply(harness.ctx)
  const handler = harness.routes.get('/session-meta')
  assert.equal(typeof handler, 'function')
  const server = createServer((request, response) => { void handler(request, response) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = 'http://127.0.0.1:' + port
  try {
    await run({ home, base, harness })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    harness.dispose()
    await rm(home, { recursive: true, force: true })
  }
}

/** The four well-formed sources used by most tests. */
async function writeAllSources(home) {
  await writeSource(home, 'session-stars.json', {
    version: 1,
    updatedAt: 111,
    ratings: { 'session-a': { stars: 3 }, 'session-b': { stars: 0 } },
  })
  await writeSource(home, 'session-todos.json', {
    version: 1,
    updatedAt: 222,
    todos: { 'session-a': { done: true, priority: 'high', dueAt: 1234 } },
  })
  await writeSource(home, 'session-boxes.json', {
    version: 1,
    updatedAt: 333,
    boxes: [{ id: 'b_1', name: 'one' }, { id: 'b_2', name: 'two' }],
    memberships: { 'session-b': ['b_2', 'b_unknown'] },
  })
  await writeSource(home, 'session-notify.json', {
    version: 1,
    updatedAt: 444,
    watched: { 'session-a': { title: 'A' } },
  })
}

test('aggregates all four sources into one session map', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    const response = await fetch(base + '/session-meta')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.truncated, false)
    assert.equal(body.total, 2)
    assert.deepEqual(body.sources.stars, { state: 'ok', updatedAt: 111, count: 2 })
    assert.deepEqual(body.sources.todos, { state: 'ok', updatedAt: 222, count: 1 })
    assert.deepEqual(body.sources.boxes, { state: 'ok', updatedAt: 333, count: 2 })
    assert.deepEqual(body.sources.notify, { state: 'ok', updatedAt: 444, count: 1 })

    assert.equal(body.sessions['session-a'].stars, 3)
    assert.deepEqual(body.sessions['session-a'].todo, { done: true, priority: 'high', dueAt: 1234 })
    assert.equal(body.sessions['session-a'].watching, true)
    assert.equal(body.sessions['session-a'].boxes, undefined)

    assert.equal(body.sessions['session-b'].stars, 0, 'zero is preserved')
    assert.deepEqual(body.sessions['session-b'].boxes, ['b_2'], 'unknown boxes are dropped')
    assert.equal(body.sessions['session-b'].todo, undefined)
    assert.equal(body.sessions['session-b'].watching, undefined)
  })
})

test('a missing source is reported without affecting the others', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    await rm(join(home, 'session-stars.json'))
    const body = await (await fetch(base + '/session-meta')).json()
    assert.deepEqual(body.sources.stars, { state: 'missing', updatedAt: 0, count: 0 })
    assert.equal(body.sources.todos.state, 'ok')
    assert.equal(body.sources.boxes.state, 'ok')
    assert.equal(body.sources.notify.state, 'ok')
    assert.equal(body.sessions['session-a'].stars, undefined)
    assert.equal(body.sessions['session-a'].watching, true)
  })
})

test('a malformed source degrades only itself', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    await writeFile(join(home, 'session-stars.json'), '{not json', 'utf8')
    const body = await (await fetch(base + '/session-meta')).json()
    assert.equal(body.sources.stars.state, 'invalid')
    assert.equal(body.sources.stars.reason, 'json')
    assert.equal(body.sources.todos.state, 'ok')
    assert.equal(body.sessions['session-b'].stars, undefined)
    assert.equal(body.sessions['session-a'].watching, true)
  })
})

test('an empty source is reported as empty', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    await writeSource(home, 'session-stars.json', { version: 1, updatedAt: 55, ratings: {} })
    const body = await (await fetch(base + '/session-meta')).json()
    assert.deepEqual(body.sources.stars, { state: 'empty', updatedAt: 55, count: 0 })
    assert.equal(body.sources.todos.state, 'ok')
  })
})

test('a source over the read cap is invalid, not fatal', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    await writeFile(join(home, 'session-todos.json'), ' '.repeat(4 * 1024 * 1024 + 1), 'utf8')
    const body = await (await fetch(base + '/session-meta')).json()
    assert.equal(body.sources.todos.state, 'invalid')
    assert.equal(body.sources.todos.reason, 'too-large')
    assert.equal(body.sources.stars.state, 'ok')
    assert.equal(body.sessions['session-a'].stars, 3)
  })
})

test('the union is truncated at two thousand sessions', async () => {
  await withRoute(async ({ home, base }) => {
    const ratings = {}
    for (let index = 0; index < 2500; index += 1) ratings['s-' + index] = { stars: 1 }
    await writeSource(home, 'session-stars.json', { version: 1, ratings })
    const body = await (await fetch(base + '/session-meta')).json()
    assert.equal(body.sources.stars.count, 2500)
    assert.equal(body.total, 2500)
    assert.equal(body.truncated, true)
    assert.equal(Object.keys(body.sessions).length, 2000)
  })
})

test('ETag revalidates and changes when a source changes', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    const first = await fetch(base + '/session-meta')
    const etag = first.headers.get('etag')
    assert.match(etag, /^"[0-9a-f]{40}"$/)
    const cached = await fetch(base + '/session-meta', { headers: { 'if-none-match': etag } })
    assert.equal(cached.status, 304)
    assert.equal(await cached.text(), '')

    const changed = new Date(Date.now() + 5000)
    await writeSource(home, 'session-stars.json', { version: 1, ratings: { 'session-a': { stars: 5 } } })
    await utimes(join(home, 'session-stars.json'), changed, changed)
    const next = await fetch(base + '/session-meta')
    assert.equal(next.status, 200)
    assert.notEqual(next.headers.get('etag'), etag)
  })
})

test('cross-origin callers are refused', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    const response = await fetch(base + '/session-meta', { headers: { origin: 'http://evil.example' } })
    assert.equal(response.status, 403)
  })
})

test('only GET and HEAD are accepted', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    const response = await fetch(base + '/session-meta', { method: 'POST', body: '{}' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  })
})

test('HEAD returns the same headers without a body', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    const get = await fetch(base + '/session-meta')
    const head = await fetch(base + '/session-meta', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('etag'), get.headers.get('etag'))
    assert.equal(Number(head.headers.get('content-length')) > 0, true)
    assert.equal(await head.text(), '')
  })
})

test('reading the same four files twice keeps one ETag', async () => {
  await withRoute(async ({ home, base }) => {
    await writeAllSources(home)
    const first = await fetch(base + '/session-meta')
    const etag = first.headers.get('etag')
    const second = await fetch(base + '/session-meta')
    assert.equal(second.headers.get('etag'), etag)
    const info = await stat(join(home, 'session-stars.json'))
    assert.equal(info.isFile(), true)
  })
})
