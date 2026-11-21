/**
 * dsh-session-hub — browser half.
 *
 * Publishes the session event bus: one global emitter that mirrors the three
 * per-session data plugins into one stream.
 *
 *   { source: 'todos' | 'stars' | 'notify', sessionId: string | null, kind }
 *
 * On connect each source emits one `{ sessionId: null, kind: 'snapshot' }`;
 * afterwards only the sessions whose entry changed (including disappearing
 * ones) emit `kind: 'changed'`. Plugins subscribe once and re-read
 * `/session-meta` when something they care about arrives.
 *
 * The bus installs itself as `window.__dshSessionEvents` with the public alias
 * `window.dshSessionEvents`. It never overwrites an existing name: when a name
 * is taken (another live instance, or a foreign object), the next free
 * versioned name is used instead (`__dshSessionEvents.v2`, …). Unloading
 * removes exactly the names this instance claimed and closes only its own
 * EventSource connections; a missing EventSource or a 404 route is skipped.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-hub',
  factory() {
    const PRIMARY_KEY = '__dshSessionEvents'
    const ALIAS_KEY = 'dshSessionEvents'
    const MAX_SOURCE_LENGTH = 32
    const VERSION = 1
    const SOURCES = [
      { source: 'todos', url: '/session-todos/events', event: 'todos', pick: (data) => data.todos },
      { source: 'stars', url: '/session-stars/events', event: 'ratings', pick: (data) => data.ratings },
      { source: 'notify', url: '/session-notify/events', event: 'watched', pick: (data) => data.watched },
    ]

    /** A plain object view of one source map. */
    function sourceMap(value) {
      return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    /** Stable per-session serialization used to diff two frames. */
    function serialized(map) {
      const out = {}
      for (const [sessionId, value] of Object.entries(map)) out[sessionId] = JSON.stringify(value)
      return out
    }

    /** Sessions whose entry appeared, changed, or disappeared. */
    function changedSessions(previous, next) {
      const changed = []
      const before = serialized(previous)
      const after = serialized(next)
      for (const sessionId of Object.keys(after)) {
        if (before[sessionId] !== after[sessionId]) changed.push(sessionId)
      }
      for (const sessionId of Object.keys(before)) {
        if (after[sessionId] === undefined) changed.push(sessionId)
      }
      return changed
    }

    /** Create the emitter behind the global. */
    function createBus() {
      const listeners = new Set()
      return {
        version: VERSION,
        /** Fan one event out; a non-empty source of at most 32 characters is required. */
        emit(event) {
          if (event === null || typeof event !== 'object') return false
          const source = typeof event.source === 'string' ? event.source.trim() : ''
          if (source === '' || source.length > MAX_SOURCE_LENGTH) return false
          const payload = {
            source,
            sessionId: typeof event.sessionId === 'string' && event.sessionId !== '' ? event.sessionId : null,
            kind: typeof event.kind === 'string' && event.kind !== '' ? event.kind : 'changed',
          }
          for (const listener of [...listeners]) {
            try {
              listener(payload)
            } catch (error) {
              console.warn('[session-hub] an event listener failed:', error)
            }
          }
          return true
        },
        /** Subscribe; the returned off function is idempotent. */
        on(listener) {
          if (typeof listener !== 'function') return () => {}
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /**
     * Claim the first free pair of global names. Version 1 uses the two primary
     * names; later versions append `.v2`, `.v3`, … and never overwrite.
     * @returns the claimed key list and the bus, or null when every name is taken.
     */
    function install(bus) {
      const claimed = []
      for (let version = 1; version <= 9; version += 1) {
        const suffix = version === 1 ? '' : '.v' + version
        const primary = PRIMARY_KEY + suffix
        const alias = ALIAS_KEY + suffix
        if (window[primary] !== undefined) continue
        window[primary] = bus
        claimed.push(primary)
        if (window[alias] === undefined) {
          window[alias] = bus
          claimed.push(alias)
        }
        return { claimed, primary }
      }
      return null
    }

    return {
      inject: [],
      apply(ctx) {
        if (typeof window === 'undefined') return
        const bus = createBus()
        const installed = install(bus)

        ctx.effect(() => {
          const connections = []
          const closeAll = () => {
            for (const connection of connections.splice(0)) {
              try {
                connection.close()
              } catch (error) {
                console.warn('[session-hub] could not close an event stream:', error)
              }
            }
          }
          if (typeof EventSource !== 'function') return closeAll

          for (const definition of SOURCES) {
            let eventSource
            try {
              eventSource = new EventSource(definition.url)
            } catch {
              continue
            }
            let primed = false
            let previousMap = {}
            const onData = (frame) => {
              let data
              try {
                data = JSON.parse(frame.data)
              } catch {
                return
              }
              if (data === null || typeof data !== 'object' || data.ok !== true) return
              const nextMap = sourceMap(definition.pick(data))
              if (!primed) {
                primed = true
                previousMap = nextMap
                bus.emit({ source: definition.source, sessionId: null, kind: 'snapshot' })
                return
              }
              const changed = changedSessions(previousMap, nextMap)
              previousMap = nextMap
              for (const sessionId of changed) {
                bus.emit({ source: definition.source, sessionId, kind: 'changed' })
              }
            }
            const onError = () => {}
            eventSource.addEventListener(definition.event, onData)
            eventSource.addEventListener('error', onError)
            connections.push({
              close() {
                eventSource.removeEventListener(definition.event, onData)
                eventSource.removeEventListener('error', onError)
                eventSource.close()
              },
            })
          }
          return closeAll
        }, 'session-hub: event bridges')

        ctx.effect(() => () => {
          if (installed === null) return
          for (const key of installed.claimed) {
            if (window[key] === bus) delete window[key]
          }
        }, 'session-hub: bus global')
      },
    }
  },
})
