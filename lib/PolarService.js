'use strict'

const { preparePolar } = require('./preparePolar')
const { validatePolar } = require('polar-format')

const QUERY_METHODS = ['speedAt', 'vmgAt', 'targetsAt', 'rangeAt']

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function readFailure(reason, message) {
  return { value: null, state: { available: false, reason, message } }
}

function readErrorReason(error) {
  if (error.code === 'ENOENT') return 'polar_not_found'
  return error instanceof SyntaxError ? 'parse_error' : 'read_error'
}

function summarizeDocument(id, document) {
  const metadata = document !== null && typeof document === 'object' ? document : {}
  const summary = { id }
  for (const field of ['kind', 'schemaVersion', 'name', 'boatType', 'sailnumber', 'source', 'notes']) {
    summary[field] = typeof metadata[field] === 'string' ? metadata[field] : null
  }
  summary.year = Number.isInteger(metadata.year) ? metadata.year : null
  summary.sailplans = metadata.kind === 'polarSet' && Array.isArray(metadata.sailplans)
    ? metadata.sailplans.filter(plan => plan && typeof plan.id === 'string')
      .map(plan => ({ id: plan.id, name: typeof plan.name === 'string' ? plan.name : null }))
    : []
  summary.hasWaveCorrection = metadata.kind === 'polarSet' && metadata.waveCorrection != null
  return summary
}

function unavailable(reason) {
  return { value: null, state: { available: false, reason, tws: null, twa: null } }
}

function unavailableDescription(reason) {
  return Object.freeze({ available: false, reason })
}

// Frozen descriptive snapshot of a document and its selected table, built once
// at preparation time so describe() stays synchronous and filesystem-free.
function describeDocument(document, table) {
  return Object.freeze({
    name: document.name ?? null,
    boatType: document.boatType ?? null,
    sailnumber: document.sailnumber ?? null,
    year: Number.isInteger(document.year) ? document.year : null,
    source: document.source ?? null,
    notes: document.notes ?? null,
    twsAxis: Object.freeze([...table.axes.tws])
  })
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
      listPolars: () => this.listPolars(),
      getPolar: (id) => this.getPolar(id),
      getSelection: () => this.getSelection(),
      onChange: (callback) => this.subscribe(callback),
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

  listPolars() {
    if (!this.running) return deepFreeze(readFailure('provider_stopped', 'Polar management is stopped'))
    let ids
    try {
      ids = this.store.list()
    } catch (error) {
      this.reportError(`Cannot list polars: ${error.message}`)
      return deepFreeze(readFailure('read_error', error.message))
    }
    const value = ids.map(id => {
      try {
        return summarizeDocument(id, this.store.get(id))
      } catch (error) {
        this.reportError(`Cannot read polar '${id}': ${error.message}`)
        return { id, error: { reason: readErrorReason(error), message: error.message } }
      }
    })
    return deepFreeze({ value, state: { available: true } })
  }

  getPolar(id) {
    this.store.validateId(id)
    if (!this.running) {
      const result = readFailure('provider_stopped', 'Polar management is stopped')
      result.state.valid = null
      return deepFreeze(result)
    }
    let document
    try {
      document = this.store.get(id)
    } catch (error) {
      const reason = readErrorReason(error)
      if (reason !== 'polar_not_found') this.reportError(`Cannot read polar '${id}': ${error.message}`)
      const result = readFailure(reason, error.message)
      result.state.valid = null
      return deepFreeze(result)
    }
    const validation = validatePolar(document)
    const errors = validation.valid ? [] : validation.errors
    if (!validation.valid) {
      this.reportError(`Invalid polar '${id}': ${errors.map(error => `${error.path}: ${error.message}`).join('; ')}`)
    }
    return deepFreeze({
      value: { id, document },
      state: { available: true, valid: validation.valid, errors }
    })
  }

  getSelection() {
    if (!this.running) return deepFreeze(readFailure('provider_stopped', 'Polar management is stopped'))
    const settings = this.getSettings()
    return deepFreeze({
      value: {
        polarId: settings.activePolar || null,
        sailplanId: settings.activePolar ? settings.activeSailplan || null : null,
        performanceFactor: settings.performanceFactor,
        applyWaveCorrection: settings.applyWaveCorrection !== false
      },
      state: { available: true }
    })
  }

  subscribe(callback, id) {
    if (typeof callback !== 'function') throw new TypeError('onChange requires a function')
    if (!this.running) throw new Error('Polar management is stopped')
    const listener = { id, callback }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
      const document = this.store.get(id)
      const { table, polar } = preparePolar(document, key || undefined)
      entries.set(key, { polar, description: describeDocument(document, table) })
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
    // Resolves the handle's current document/table entry, mirroring shared
    // settings per call for active handles and fixed choices for specific ones.
    const resolve = () => {
      if (!this.running) return { reason: 'provider_stopped' }
      const settings = this.getSettings()
      const currentId = id === null ? settings.activePolar : id
      if (!currentId) return { reason: 'no_active_polar' }
      const key = sailplanKey(id === null ? settings.activeSailplan : sailplanId)
      const entry = this.cache.get(currentId)?.get(key)
      if (!entry) return { reason: 'polar_not_found' }
      if (!entry.polar) return { reason: entry.reason }
      return { entry, currentId, key, settings }
    }
    const handle = {
      onChange: (callback) => this.subscribe(callback, id),
      // Descriptive snapshot of the handle's current selection: document
      // metadata, selected sailplan (null for best), the factor the handle
      // applies, and the selected table's TWS axis (canonical m/s). Shares the
      // calculation methods' resolution and unavailability reasons.
      describe: () => {
        const resolved = resolve()
        if (resolved.reason) return unavailableDescription(resolved.reason)
        const { entry, currentId, key, settings } = resolved
        return Object.freeze({
          available: true,
          id: currentId,
          sailplanId: key || null,
          performanceFactor: id === null ? settings.performanceFactor : factor,
          ...entry.description
        })
      }
    }
    for (const method of QUERY_METHODS) {
      handle[method] = (options) => {
        const resolved = resolve()
        if (resolved.reason) return unavailable(resolved.reason)
        const { entry, settings } = resolved
        const callOptions = {
          ...options,
          performanceFactor: id === null ? settings.performanceFactor : factor
        }
        // Active handles mirror every shared setting per call, including the
        // wave-correction toggle: when off, seaState is dropped before reaching
        // math. Specific handles are independent of shared settings; their
        // consumers control wave correction by supplying or omitting seaState.
        if (id === null && settings.applyWaveCorrection === false) delete callOptions.seaState
        return entry.polar[method](callOptions)
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
      if (listener.id !== undefined && listener.id !== null && change.type !== 'stopped' && !event.ids.includes(listener.id)) continue
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
