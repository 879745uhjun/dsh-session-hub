import assert from 'node:assert/strict'
import test from 'node:test'

/** Fake EventSource: records instances and lets a test push named frames. */
class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(listener)
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener)
  }

  close() {
    this.closed = true
  }

  push(name, data) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      listener({ data: typeof data === 'string' ? data : JSON.stringify(data) })
    }
  }
}

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.window.__captured = definition
    },
  },
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: FakeEventSource })

await import('../client.js')

const definition = globalThis.window.__captured
const PRIMARY = '__dshSessionEvents'
const ALIAS = 'dshSessionEvents'

/** A minimal client context: effects are collected for disposal. */
function createContext() {
  const disposers = []
  return {
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

/** Apply one fresh plugin instance with a reset source list. */
function start() {
  FakeEventSource.instances = []
  const before = new Set(Object.keys(globalThis.window))
  const plugin = definition.factory()
  const ctx = createContext()
  plugin.apply(ctx)
  let bus = null
  for (const key of Object.keys(globalThis.window)) {
    if (before.has(key)) continue
    const value = globalThis.window[key]
    if (value !== null && typeof value === 'object' && value.version === 1) {
      bus = value
      break
    }
  }
  return { ctx, sources: FakeEventSource.instances, bus }
}

/** Remove every name this plugin may have claimed. */
function cleanupWindow() {
  for (const key of Object.keys(globalThis.window)) {
    if (key === '__ModuleLoader__' || key === '__captured') continue
    delete globalThis.window[key]
  }
}

test('the bus is published under both names with its version', () => {
  const { bus, ctx } = start()
  assert.equal(bus.version, 1)
  assert.equal(globalThis.window[PRIMARY], bus)
  assert.equal(globalThis.window[ALIAS], bus)
  ctx.dispose()
  cleanupWindow()
})

test('emit fans out, off is idempotent, and listener errors are contained', () => {
  const { bus, ctx } = start()
  const seen = []
  bus.on(() => { throw new Error('boom') })
  const off = bus.on((event) => seen.push(event))
  assert.equal(bus.emit({ source: 'todos', sessionId: 's1', kind: 'changed' }), true)
  assert.deepEqual(seen, [{ source: 'todos', sessionId: 's1', kind: 'changed' }])
  off()
  off()
  bus.emit({ source: 'todos', sessionId: 's1', kind: 'changed' })
  assert.equal(seen.length, 1)
  assert.equal(bus.on(null)(), undefined, 'a null listener yields a callable off')
  ctx.dispose()
  cleanupWindow()
})

test('emit requires a short non-empty source', () => {
  const { bus, ctx } = start()
  const seen = []
  bus.on((event) => seen.push(event))
  assert.equal(bus.emit({ sessionId: 's1' }), false)
  assert.equal(bus.emit({ source: '   ' }), false)
  assert.equal(bus.emit({ source: 'x'.repeat(33) }), false)
  assert.equal(bus.emit({ source: 'x'.repeat(32), sessionId: 's1' }), true)
  assert.equal(seen.length, 1)
  ctx.dispose()
  cleanupWindow()
})

test('the bridges emit one snapshot, then only the sessions that changed', () => {
  const { bus, ctx, sources } = start()
  assert.deepEqual(sources.map((source) => source.url), [
    '/session-todos/events',
    '/session-stars/events',
    '/session-notify/events',
  ])
  const seen = []
  bus.on((event) => seen.push(event))

  const todos = sources[0]
  todos.push('todos', { ok: true, todos: { s1: { done: false }, s2: { done: true } } })
  assert.deepEqual(seen, [{ source: 'todos', sessionId: null, kind: 'snapshot' }])

  seen.length = 0
  todos.push('todos', { ok: true, todos: { s1: { done: false }, s2: { done: true } } })
  assert.deepEqual(seen, [], 'an identical frame emits nothing')

  todos.push('todos', { ok: true, todos: { s1: { done: true }, s2: { done: true } } })
  assert.deepEqual(seen, [{ source: 'todos', sessionId: 's1', kind: 'changed' }])

  seen.length = 0
  todos.push('todos', { ok: true, todos: { s2: { done: true } } })
  assert.deepEqual(seen, [{ source: 'todos', sessionId: 's1', kind: 'changed' }], 'a vanished session is a change')

  seen.length = 0
  todos.push('todos', '{not json')
  assert.deepEqual(seen, [], 'a malformed frame is ignored')
  ctx.dispose()
  cleanupWindow()
})

test('a second instance never overwrites the live one', () => {
  const first = start()
  const firstBus = globalThis.window[PRIMARY]
  const second = start()
  assert.equal(globalThis.window[PRIMARY], firstBus, 'the first name stays untouched')
  assert.equal(globalThis.window[PRIMARY + '.v2'], second.bus)
  assert.equal(globalThis.window[ALIAS + '.v2'], second.bus)

  second.ctx.dispose()
  assert.equal(globalThis.window[PRIMARY + '.v2'], undefined)
  assert.equal(globalThis.window[PRIMARY], firstBus)

  first.ctx.dispose()
  assert.equal(globalThis.window[PRIMARY], undefined)
  assert.equal(globalThis.window[ALIAS], undefined)
  cleanupWindow()
})

test('unloading closes every stream and removes both names', () => {
  const { ctx, sources } = start()
  assert.equal(sources.length, 3)
  ctx.dispose()
  assert.equal(sources.every((source) => source.closed), true)
  assert.equal(PRIMARY in globalThis.window, false)
  assert.equal(ALIAS in globalThis.window, false)
  cleanupWindow()
})

test('a missing EventSource leaves the bus usable', () => {
  const saved = globalThis.EventSource
  delete globalThis.EventSource
  try {
    const { bus, ctx } = start()
    assert.equal(bus.version, 1)
    assert.equal(FakeEventSource.instances.length, 0)
    ctx.dispose()
    cleanupWindow()
  } finally {
    globalThis.EventSource = saved
  }
})
