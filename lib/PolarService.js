'use strict'

const { Polar } = require('polar-math')

const QUERY_METHODS = ['speedAt', 'vmgAt', 'targetsAt', 'rangeAt']

function unavailable(reason) {
  return { value: null, state: { available: false, reason, tws: null, twa: null } }
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
    this.cache = new Map()
    this.requested = new Set()
    this.listeners = new Set()
    this.prepareIfNeeded(getSettings().activePolar)
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
      polar: (id, { performanceFactor = 1 } = {}) => {
        if (typeof id !== 'string' || !id.trim()) {
          throw new TypeError('Polar id must be a non-empty string')
        }
        if (!Number.isFinite(performanceFactor) || performanceFactor < 0) {
          throw new RangeError('Performance factor must be a finite non-negative number')
        }
        return this.createHandle(id, performanceFactor)
      }
    })
  }

  prepareIfNeeded(id) {
    if (!this.running || !id || this.requested.has(id)) return
    // Remember missing IDs too, so retained handles recover when a table is created.
    this.requested.add(id)
    this.refresh(id)
  }

  refresh(id) {
    if (!this.store.exists(id)) {
      this.cache.delete(id)
      return
    }
    try {
      this.cache.set(id, { polar: Polar.fromTable(this.store.get(id)) })
    } catch (error) {
      this.cache.set(id, { reason: 'invalid_polar' })
      this.reportError(`Cannot prepare polar '${id}': ${error.message}`)
    }
  }

  createHandle(id, factor) {
    this.prepareIfNeeded(id === null ? this.getSettings().activePolar : id)
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
        const entry = this.cache.get(currentId)
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
    if (change.type === 'selection') this.prepareIfNeeded(this.getSettings().activePolar)
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
