'use strict'

const { preparePolar } = require('./preparePolar')

const QUERY_METHODS = ['speedAt', 'vmgAt', 'targetsAt', 'rangeAt']

function unavailable(reason) {
  return { value: null, state: { available: false, reason, tws: null, twa: null } }
}

// '' keys the best table; any other key is a document-local sailplan id.
function sailplanKey(sailplanId) {
  return sailplanId || ''
}

/**
 * Live calculation handles. Prepared tables stay private and are refreshed only
 * when first needed and after store mutations, never in a calculation call.
 */
class PolarService {
  constructor(store, getSettings, reportError) {
    this.store = store
    this.getSettings = getSettings
    this.reportError = reportError
    this.running = true
    this.cache = new Map() // id -> Map(sailplanKey -> { polar } | { reason })
    this.requested = new Map() // id -> Set(sailplanKey)
    this.listeners = new Set()
    this.prepareIfNeeded(getSettings().activePolar, getSettings().activeSailplan)
    store.onChange = (change) => {
      for (const id of change.ids) {
        if (this.requested.has(id)) this.refresh(id)
      }
      this.notify(change)
    }

    const service = this
    this.api = Object.freeze({
      apiVersion: 1,
      get available() { return service.running },
      activePolar: () => this.createHandle(null, 1),
      polar: (id, { performanceFactor = 1, sailplanId } = {}) => {
        if (typeof id !== 'string' || !id.trim()) {
          throw new TypeError('Polar id must be a non-empty string')
        }
        if (!Number.isFinite(performanceFactor) || performanceFactor < 0) {
          throw new RangeError('Performance factor must be a finite non-negative number')
        }
        if (sailplanId !== undefined && (typeof sailplanId !== 'string' || !sailplanId.trim())) {
          throw new TypeError("'sailplanId' must be a nonempty string, or omitted for best")
        }
        return this.createHandle(id, performanceFactor, sailplanId)
      }
    })
  }

  prepareIfNeeded(id, sailplanId) {
    if (!this.running || !id) return
    const key = sailplanKey(sailplanId)
    let keys = this.requested.get(id)
    if (keys?.has(key)) return
    // Remember missing IDs too, so retained handles recover when a table is created.
    if (!keys) {
      keys = new Set()
      this.requested.set(id, keys)
    }
    keys.add(key)
    this.refreshOne(id, key)
  }

  refresh(id) {
    const keys = this.requested.get(id) || new Set([''])
    for (const key of keys) this.refreshOne(id, key)
  }

  refreshOne(id, key) {
    if (!this.store.exists(id)) {
      this.cache.delete(id)
      return
    }
    let entries = this.cache.get(id)
    if (!entries) {
      entries = new Map()
      this.cache.set(id, entries)
    }
    try {
      entries.set(key, { polar: preparePolar(this.store.get(id), key || undefined).polar })
    } catch (error) {
      const reason = error.code === 'unsupported_math' ? 'unsupported_math'
        : error.code === 'unknown_sailplan' ? 'sailplan_not_found'
          : 'invalid_polar'
      entries.set(key, { reason })
      this.reportError(`Cannot prepare polar '${id}': ${error.message}`)
    }
  }

  createHandle(id, factor, sailplanId) {
    if (id === null) {
      const settings = this.getSettings()
      this.prepareIfNeeded(settings.activePolar, settings.activeSailplan)
    } else {
      this.prepareIfNeeded(id, sailplanId)
    }
    const handle = {
      onChange: (callback) => {
        if (typeof callback !== 'function') throw new TypeError('onChange requires a function')
        if (!this.running) throw new Error('Polar management is stopped')
        const listener = { id, callback }
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }
    }
    for (const method of QUERY_METHODS) {
      handle[method] = (options) => {
        if (!this.running) return unavailable('provider_stopped')
        const settings = this.getSettings()
        const currentId = id === null ? settings.activePolar : id
        if (!currentId) return unavailable('no_active_polar')
        const key = sailplanKey(id === null ? settings.activeSailplan : sailplanId)
        const entry = this.cache.get(currentId)?.get(key)
        if (!entry) return unavailable('polar_not_found')
        if (!entry.polar) return unavailable(entry.reason)
        return entry.polar[method]({
          ...options,
          performanceFactor: id === null ? settings.performanceFactor : factor
        })
      }
    }
    return Object.freeze(handle)
  }

  notify(change) {
    if (change.type === 'selection') {
      const settings = this.getSettings()
      this.prepareIfNeeded(settings.activePolar, settings.activeSailplan)
    }
    const event = Object.freeze({ ...change, ids: Object.freeze([...(change.ids || [])]) })
    for (const listener of [...this.listeners]) {
      if (listener.id !== null && change.type !== 'stopped' && !event.ids.includes(listener.id)) continue
      if (listener.id === null && event.ids.length && !event.ids.includes(this.getSettings().activePolar)) continue
      try {
        listener.callback(event)
      } catch (error) {
        this.reportError(`Polar change listener failed: ${error.message}`)
      }
    }
  }

  stop() {
    if (!this.running) return
    this.running = false
    this.store.onChange = null
    this.cache.clear()
    this.requested.clear()
    this.notify({ type: 'stopped' })
    this.listeners.clear()
  }
}

module.exports = PolarService
