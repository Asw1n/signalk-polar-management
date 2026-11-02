'use strict'

const path = require('path')
const { validatePolar } = require('polar-format')
const PolarStore = require('./lib/PolarStore')
const PolarService = require('./lib/PolarService')
const { ImportService, ImportError, autoId } = require('./lib/import/ImportService')
const { ExportService, ExportError } = require('./lib/export/ExportService')
const { parseWaveCorrection } = require('./lib/waveCorrection')
const { buildCurves, DEFAULT_STEP_DEG } = require('./lib/CurveService')

const ACTIVE_POLAR_PATH = 'polars.activePolar'
const PERFORMANCE_FACTOR_PATH = 'polars.performanceFactor'
const APPLY_WAVE_CORRECTION_PATH = 'polars.applyWaveCorrection'
const BOAT_NAME_PATH = 'polars.boatName'
const SAIL_PLAN_PATH = 'polars.sailPlan'
const DEFAULT_PERFORMANCE_FACTOR = 1
const DEFAULT_APPLY_WAVE_CORRECTION = true
const RESOURCE_TYPE = 'polars'

module.exports = (app) => {
  let settings = {}
  let store = null
  let importService = null
  let exportService = null
  let polarService = null
  let activePolarPublished = false
  let performanceFactorPublished = false
  let publishedWaveValue // undefined until first wave-correction publication
  let publishedBoatName // undefined until first identity publication
  let publishedSailPlan // undefined until first identity publication

  const plugin = {
    id: 'signalk-polar-management',
    name: 'Polar Management'
  }

  function sanitizePerformanceFactor(value) {
    const factor = Number(value)
    if (!Number.isFinite(factor)) return DEFAULT_PERFORMANCE_FACTOR
    return Math.min(1, Math.max(0, factor))
  }

  function isValidPerformanceFactor(value) {
    const factor = Number(value)
    return Number.isFinite(factor) && factor >= 0 && factor <= 1
  }

  // '' / null / undefined mean best. Returns an error string when the configured
  // sailplan cannot be used with the document; selection is strict, never a
  // silent fallback to best.
  function activeSailplanError(document, sailplanId, id) {
    if (!sailplanId) return null
    if (document.kind !== 'polarSet') {
      return `Active sailplan '${sailplanId}' is configured but '${id}' is a v1 document without sailplans`
    }
    if (!(document.sailplans || []).some(plan => plan.id === sailplanId)) {
      return `Active sailplan '${sailplanId}' was not found in '${id}'`
    }
    return null
  }

  // Lightweight internet connectivity probe (mirrors signalk-polar-performance-plugin).
  // Attempts a HEAD request to Cloudflare's public DNS (1.1.1.1) with a 3s timeout.
  async function checkInternet() {
    const TIMEOUT_MS = 3000
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      const response = await fetch('https://1.1.1.1', { method: 'HEAD', signal: controller.signal })
        .finally(() => clearTimeout(timer))
      return response.status < 600
    } catch (_) {
      return false
    }
  }

  function publishMetadata() {
    app.handleMessage(plugin.id, {
      updates: [{
        meta: [
          {
            path: ACTIVE_POLAR_PATH,
            value: {
              type: 'object',
              displayName: 'Active polar',
              description: 'Pointer to the selected polar resource and, for v2 documents, the shared sailplan selection (absent for best).',
              // Only emitted on change, not periodically -> exempt from stale-data timeout.
              updateContract: 'event'
            }
          },
          {
            path: PERFORMANCE_FACTOR_PATH,
            value: {
              type: 'number',
              units: 'ratio',
              displayName: 'Polar performance factor',
              description: 'Multiplier applied by polar consumers to reduce polar speed values.',
              // Only emitted on change, not periodically -> exempt from stale-data timeout.
              updateContract: 'event'
            }
          },
          {
            path: APPLY_WAVE_CORRECTION_PATH,
            value: {
              type: 'boolean',
              displayName: 'Apply wave correction',
              description: 'Whether polar consumers should apply the active document\'s wave correction; null when the active polar cannot use wave correction.',
              // Only emitted on change, not periodically -> exempt from stale-data timeout.
              updateContract: 'event'
            }
          },
          {
            path: BOAT_NAME_PATH,
            value: {
              type: 'string',
              displayName: 'Active polar boat name',
              description: 'Boat name of the active polar document (resource id when the document has no name); null when no usable polar is active.',
              // Only emitted on change, not periodically -> exempt from stale-data timeout.
              updateContract: 'event'
            }
          },
          {
            path: SAIL_PLAN_PATH,
            value: {
              type: 'string',
              displayName: 'Active sailplan name',
              description: 'Name of the shared active sailplan; \'best\' for a v2 best selection, null for v1 documents, unusable selections or no active polar.',
              // Only emitted on change, not periodically -> exempt from stale-data timeout.
              updateContract: 'event'
            }
          }
        ]
      }]
    })
  }

  function publishActivePolar(id, sailplanId) {
    refreshApplyWaveCorrection()
    refreshIdentity()
    const value = id
      ? { href: `/resources/${RESOURCE_TYPE}/${id}`, ...(sailplanId ? { sailplanId } : {}) }
      : null
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: ACTIVE_POLAR_PATH, value }] }]
    })
    activePolarPublished = !!id
    polarService?.notify({ type: 'selection' })
  }

  function clearActivePolar() {
    refreshApplyWaveCorrection()
    refreshIdentity()
    if (!activePolarPublished) {
      polarService?.notify({ type: 'selection' })
      return
    }
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: ACTIVE_POLAR_PATH, value: null }] }]
    })
    activePolarPublished = false
    polarService?.notify({ type: 'selection' })
  }

  function publishPerformanceFactor(value) {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: PERFORMANCE_FACTOR_PATH, value }] }]
    })
    performanceFactorPublished = true
    polarService?.notify({ type: 'performanceFactor' })
  }

  function clearPerformanceFactor() {
    if (!performanceFactorPublished) return
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: PERFORMANCE_FACTOR_PATH, value: null }] }]
    })
    performanceFactorPublished = false
  }

  function publishApplyWaveCorrection(value) {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: APPLY_WAVE_CORRECTION_PATH, value }] }]
    })
    publishedWaveValue = value
    polarService?.notify({ type: 'waveCorrection' })
  }

  // The published path reflects usability, not just the stored setting: null
  // whenever the active polar is v1, has no wave correction table, or no
  // usable polar is active. Only changes are emitted.
  function waveCorrectionValue() {
    if (!store || !settings.activePolar || !store.exists(settings.activePolar)) return null
    let document
    try {
      document = store.get(settings.activePolar)
    } catch (_) {
      return null
    }
    if (document.kind !== 'polarSet' || !document.waveCorrection) return null
    return settings.applyWaveCorrection
  }

  function refreshApplyWaveCorrection() {
    const value = waveCorrectionValue()
    if (value !== publishedWaveValue) publishApplyWaveCorrection(value)
  }

  function clearApplyWaveCorrection() {
    if (publishedWaveValue !== undefined && publishedWaveValue !== null) {
      app.handleMessage(plugin.id, {
        updates: [{ values: [{ path: APPLY_WAVE_CORRECTION_PATH, value: null }] }]
      })
    }
    publishedWaveValue = undefined
  }

  // Human-readable identity of the active selection: the document's boat name
  // (resource id when the document has no name) and the selected sailplan's
  // name ('best' for a v2 best selection). Both are null when no usable polar
  // is active; sailPlan is also null for v1 documents and for a configured
  // sailplan that is missing from the document.
  function identityValues() {
    const empty = { boatName: null, sailPlan: null }
    if (!store || !settings.activePolar || !store.exists(settings.activePolar)) return empty
    let document
    try {
      document = store.get(settings.activePolar)
    } catch (_) {
      return empty
    }
    const boatName = document.name || settings.activePolar
    if (document.kind !== 'polarSet') return { boatName, sailPlan: null }
    if (!settings.activeSailplan) return { boatName, sailPlan: 'best' }
    const plan = (document.sailplans || []).find(candidate => candidate.id === settings.activeSailplan)
    return { boatName, sailPlan: plan ? plan.name || plan.id : null }
  }

  function refreshIdentity() {
    const { boatName, sailPlan } = identityValues()
    const values = []
    if (boatName !== publishedBoatName) {
      values.push({ path: BOAT_NAME_PATH, value: boatName })
      publishedBoatName = boatName
    }
    if (sailPlan !== publishedSailPlan) {
      values.push({ path: SAIL_PLAN_PATH, value: sailPlan })
      publishedSailPlan = sailPlan
    }
    if (values.length) {
      app.handleMessage(plugin.id, { updates: [{ values }] })
    }
  }

  function clearIdentity() {
    const values = []
    if (publishedBoatName !== undefined && publishedBoatName !== null) {
      values.push({ path: BOAT_NAME_PATH, value: null })
    }
    if (publishedSailPlan !== undefined && publishedSailPlan !== null) {
      values.push({ path: SAIL_PLAN_PATH, value: null })
    }
    if (values.length) {
      app.handleMessage(plugin.id, { updates: [{ values }] })
    }
    publishedBoatName = undefined
    publishedSailPlan = undefined
  }

  plugin.start = (options) => {
    if (polarService) plugin.stop()
    settings = { activePolar: '', activeSailplan: '', performanceFactor: DEFAULT_PERFORMANCE_FACTOR, applyWaveCorrection: DEFAULT_APPLY_WAVE_CORRECTION, ...options }
    settings.performanceFactor = sanitizePerformanceFactor(settings.performanceFactor)
    if (typeof settings.activeSailplan !== 'string') settings.activeSailplan = ''
    if (typeof settings.applyWaveCorrection !== 'boolean') settings.applyWaveCorrection = DEFAULT_APPLY_WAVE_CORRECTION
    store = new PolarStore(path.join(app.getDataDirPath(), 'polars'))
    importService = new ImportService(store)
    exportService = new ExportService()

    publishMetadata()
    refreshApplyWaveCorrection()
    refreshIdentity()
    publishPerformanceFactor(settings.performanceFactor)

    if (settings.activePolar && store.exists(settings.activePolar)) {
      const sailplanError = activeSailplanError(store.get(settings.activePolar), settings.activeSailplan, settings.activePolar)
      if (sailplanError) app.setPluginError(sailplanError)
      else publishActivePolar(settings.activePolar, settings.activeSailplan)
    } else if (settings.activePolar) {
      app.setPluginError(`Configured active polar '${settings.activePolar}' was not found`)
    }

    app.registerResourceProvider({
      type: RESOURCE_TYPE,
      methods: {
        listResources: async () => {
          const result = {}
          for (const meta of store.listWithMeta()) {
            const { id, ...rest } = meta
            result[id] = rest
          }
          return result
        },
        getResource: async (id) => {
          if (!store.exists(id)) throw new Error(`Polar not found: ${id}`)
          return store.get(id)
        },
        setResource: async (id, value) => {
          store.save(id, value)
          if (id === settings.activePolar) {
            refreshApplyWaveCorrection()
            refreshIdentity()
          }
        },
        deleteResource: async (id) => {
          if (settings.activePolar === id) {
            throw new Error(`Cannot delete '${id}': it is the active polar`)
          }
          store.delete(id)
        }
      }
    })

    app.setPluginStatus(`Managing ${store.list().length} polar(s)`)
    polarService = new PolarService(store, () => settings, (message) => app.setPluginError(message))
    app.emitPropertyValue('polarManagement', polarService.api)
  }

  plugin.stop = () => {
    if (polarService) {
      polarService.stop()
      polarService = null
      app.emitPropertyValue('polarManagement', { apiVersion: 1, available: false })
    }
    clearActivePolar()
    clearIdentity()
    clearApplyWaveCorrection()
    clearPerformanceFactor()
    store = null
    importService = null
    exportService = null
  }

  plugin.schema = () => ({ type: 'object', properties: {} })

  plugin.registerWithRouter = (router) => {
    router.access('readonly').get('/polars', (req, res) => {
      res.json(store.listWithMeta())
    })

    router.access('readonly').get('/polars/:id', (req, res) => {
      try {
        res.json(store.get(req.params.id))
      } catch (e) {
        res.status(404).json({ error: e.message })
      }
    })

    router.access('readonly').get('/polars/:id/curves', (req, res) => {
      const step = req.query.step === undefined ? DEFAULT_STEP_DEG : Number(req.query.step)
      let table
      try {
        table = store.get(req.params.id)
      } catch (e) {
        return res.status(404).json({ error: e.message })
      }
      const performanceFactor = req.query.corrected === 'true' ? settings.performanceFactor : 1
      try {
        res.json({ id: req.params.id, ...buildCurves(table, step, performanceFactor, req.query.sailplanId) })
      } catch (e) {
        res.status(e.status || 400).json({ error: e.message })
      }
    })

    router.access('readonly').get('/polars/:id/validate', (req, res) => {
      let table
      try {
        table = store.get(req.params.id)
      } catch (e) {
        return res.status(404).json({ error: e.message })
      }
      const result = validatePolar(table)
      res.json({
        valid: result.valid,
        errors: result.valid ? [] : result.errors.map(e => `${e.path}: ${e.message}`)
      })
    })

    router.post('/polars/:id/copy', (req, res) => {
      const newId = req.body?.id
      if (typeof newId !== 'string' || !newId.trim()) {
        return res.status(400).json({ error: "'id' is required" })
      }
      try {
        store.copy(req.params.id, newId)
        res.json({ id: newId })
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })

    router.put('/polars/:id', (req, res) => {
      try {
        store.save(req.params.id, req.body)
        if (req.params.id === settings.activePolar) {
          refreshApplyWaveCorrection()
          refreshIdentity()
        }
        res.json({ id: req.params.id })
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })

    router.delete('/polars/:id', (req, res) => {
      if (settings.activePolar === req.params.id) {
        return res.status(409).json({ error: `Cannot delete '${req.params.id}': it is the active polar` })
      }
      try {
        store.delete(req.params.id)
        res.status(204).end()
      } catch (e) {
        res.status(404).json({ error: e.message })
      }
    })

    router.put('/polars/:id/metadata', (req, res) => {
      const oldId = req.params.id
      if (!store.exists(oldId)) {
        return res.status(404).json({ error: `Polar not found: ${oldId}` })
      }
      let original
      let newId
      try {
        original = store.get(oldId)
        newId = store.modify(oldId, req.body)
      } catch (e) {
        return res.status(400).json({ error: e.message })
      }
      if (settings.activePolar !== oldId || newId === oldId) {
        // A name edit that keeps the active id must still refresh the
        // published boat name.
        if (settings.activePolar === oldId) refreshIdentity()
        return res.json({ id: newId })
      }
      const nextSettings = { ...settings, activePolar: newId }
      app.savePluginOptions(nextSettings, (err) => {
        if (err) {
          try {
            store.save(newId, original)
            store.rename(newId, oldId)
          } catch (rollbackError) {
            app.setPluginError(`Could not restore polar '${oldId}': ${rollbackError.message}`)
            return res.status(500).json({
              error: `Could not save active polar selection: ${err.message}. Could not restore polar: ${rollbackError.message}`
            })
          }
          return res.status(500).json({ error: `Could not save active polar selection: ${err.message}` })
        }
        settings.activePolar = newId
        publishActivePolar(newId, settings.activeSailplan)
        res.json({ id: newId })
      })
    })

    router.post('/polars/:id/rename', (req, res) => {
      const newId = req.body?.id
      if (typeof newId !== 'string' || !newId.trim()) {
        return res.status(400).json({ error: "'id' is required" })
      }
      try {
        store.rename(req.params.id, newId)
        if (settings.activePolar === req.params.id) {
          settings.activePolar = newId
          app.savePluginOptions(settings, () => {})
          publishActivePolar(newId, settings.activeSailplan)
        }
        res.json({ id: newId })
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })

    router.access('readonly').get('/internet', async (req, res) => {
      res.json({ online: await checkInternet() })
    })

    // ── Document editing: wave correction and sailplans ───────────────────────
    // All mutations validate the complete updated document before saving; the
    // in-memory copy is simply discarded on validation failure.
    const loadDocument = (req, res) => {
      try {
        return store.get(req.params.id)
      } catch (e) {
        res.status(404).json({ error: e.message })
        return null
      }
    }

    const saveEditedDocument = (res, id, document, respond) => {
      const validation = validatePolar(document)
      if (!validation.valid) {
        return res.status(400).json({ error: validation.errors.map(error => `${error.path}: ${error.message}`).join('; ') })
      }
      store.save(id, document)
      if (id === settings.activePolar) refreshApplyWaveCorrection()
      respond()
      // After respond(): a sailplan rename updates the shared selection inside
      // respond, so the identity refresh sees the final selection.
      if (id === settings.activePolar) refreshIdentity()
    }

    router.access('readonly').get('/polars/:id/waveCorrection', (req, res) => {
      const document = loadDocument(req, res)
      if (!document) return
      if (document.kind !== 'polarSet' || !document.waveCorrection) {
        return res.status(404).json({ error: `Polar '${req.params.id}' has no wave correction` })
      }
      res.json({ waveCorrection: document.waveCorrection })
    })

    router.put('/polars/:id/waveCorrection', (req, res) => {
      const document = loadDocument(req, res)
      if (!document) return
      if (document.kind !== 'polarSet') {
        return res.status(400).json({ error: 'Only v2 polarSet documents can carry a wave correction' })
      }
      const fragment = req.body?.waveCorrection
      if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
        return res.status(400).json({ error: "A 'waveCorrection' object is required" })
      }
      document.waveCorrection = fragment
      saveEditedDocument(res, req.params.id, document, () =>
        res.json({ heights: Array.isArray(fragment.heights) ? fragment.heights.length : 0 }))
    })

    router.post('/polars/:id/waveCorrection/import', (req, res) => {
      const document = loadDocument(req, res)
      if (!document) return
      if (document.kind !== 'polarSet') {
        return res.status(400).json({ error: 'Only v2 polarSet documents can carry a wave correction' })
      }
      let fragment
      try {
        fragment = parseWaveCorrection(req.body?.content)
      } catch (e) {
        return res.status(400).json({ error: e.message })
      }
      document.waveCorrection = fragment
      saveEditedDocument(res, req.params.id, document, () =>
        res.json({ heights: fragment.heights.length }))
    })

    router.delete('/polars/:id/waveCorrection', (req, res) => {
      const document = loadDocument(req, res)
      if (!document) return
      if (document.kind !== 'polarSet' || !document.waveCorrection) {
        return res.status(404).json({ error: `Polar '${req.params.id}' has no wave correction` })
      }
      delete document.waveCorrection
      saveEditedDocument(res, req.params.id, document, () => res.status(204).end())
    })

    const sailplanReferencedByBest = (document, sailplanId) => {
      const matrixReference = (document.best.sailplanIdMatrix || []).some(row => row.includes(sailplanId))
      const targetReference = (document.best.derived?.rows || []).some(row =>
        ['beat', 'run'].some(role => row[role]?.sailplanId === sailplanId))
      return matrixReference || targetReference
    }

    router.post('/polars/:id/sailplans', (req, res) => {
      const document = loadDocument(req, res)
      if (!document) return
      if (document.kind !== 'polarSet') {
        return res.status(400).json({ error: 'Only v2 polarSet documents have sailplans' })
      }
      const name = req.body?.name
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: "'name' is required" })
      }
      if (req.body?.id !== undefined && (typeof req.body.id !== 'string' || !req.body.id.trim())) {
        return res.status(400).json({ error: "'id' must be a nonempty string, or omitted to derive it from the name" })
      }
      let resource
      try {
        resource = importService.parseTable(req.body?.content ?? '')
      } catch (e) {
        return res.status(e instanceof ImportError ? e.status : 500).json({ error: e.message })
      }
      if (!!resource.symmetry?.portStarboardSymmetric !== !!document.symmetry?.portStarboardSymmetric) {
        return res.status(400).json({ error: 'The imported table\u2019s port/starboard symmetry does not match this document' })
      }
      const sailplanId = req.body?.id !== undefined ? req.body.id.trim() : autoId(name, 'sailplan')
      if ((document.sailplans || []).some(plan => plan.id === sailplanId)) {
        return res.status(400).json({ error: `Sailplan id '${sailplanId}' already exists` })
      }
      const table = {
        axes: resource.axes,
        values: resource.values,
        ...(resource.derived ? { derived: resource.derived } : {})
      }
      document.sailplans = [...(document.sailplans || []), { id: sailplanId, name: name.trim(), table }]
      saveEditedDocument(res, req.params.id, document, () => res.json({ id: sailplanId }))
    })

    router.delete('/polars/:id/sailplans/:sailplanId', (req, res) => {
      const document = loadDocument(req, res)
      if (!document) return
      if (document.kind !== 'polarSet') {
        return res.status(400).json({ error: 'Only v2 polarSet documents have sailplans' })
      }
      const sailplanId = req.params.sailplanId
      const index = (document.sailplans || []).findIndex(plan => plan.id === sailplanId)
      if (index === -1) {
        return res.status(404).json({ error: `Unknown sailplan: ${sailplanId}` })
      }
      if (settings.activePolar === req.params.id && settings.activeSailplan === sailplanId) {
        return res.status(409).json({ error: `Cannot delete '${sailplanId}': it is the active sailplan` })
      }
      if (sailplanReferencedByBest(document, sailplanId)) {
        return res.status(409).json({ error: `Cannot delete '${sailplanId}': the best table references it as a winning sailplan` })
      }
      document.sailplans.splice(index, 1)
      if (document.sailplans.length === 0) delete document.sailplans
      saveEditedDocument(res, req.params.id, document, () => res.status(204).end())
    })

    router.put('/polars/:id/sailplans/:sailplanId/metadata', (req, res) => {
      const document = loadDocument(req, res)
      if (!document) return
      if (document.kind !== 'polarSet') {
        return res.status(400).json({ error: 'Only v2 polarSet documents have sailplans' })
      }
      const plan = (document.sailplans || []).find(candidate => candidate.id === req.params.sailplanId)
      if (!plan) {
        return res.status(404).json({ error: `Unknown sailplan: ${req.params.sailplanId}` })
      }
      const { id: newId, name, notes } = req.body || {}
      if (newId !== undefined && (typeof newId !== 'string' || !newId.trim())) {
        return res.status(400).json({ error: "'id' must be a nonempty string" })
      }
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return res.status(400).json({ error: "'name' must be a nonempty string" })
      }
      if (notes !== undefined && notes !== null && typeof notes !== 'string') {
        return res.status(400).json({ error: "'notes' must be a string or null" })
      }
      const oldId = plan.id
      const targetId = newId !== undefined ? newId.trim() : oldId
      if (targetId !== oldId && document.sailplans.some(candidate => candidate.id === targetId)) {
        return res.status(400).json({ error: `Sailplan id '${targetId}' already exists` })
      }
      plan.id = targetId
      if (name !== undefined) plan.name = name.trim()
      if (notes !== undefined) {
        if (notes === null || notes === '') delete plan.notes
        else plan.notes = notes
      }
      if (targetId !== oldId) {
        // Winning references follow the rename so the document stays valid.
        if (document.best.sailplanIdMatrix) {
          document.best.sailplanIdMatrix = document.best.sailplanIdMatrix.map(row =>
            row.map(cell => (cell === oldId ? targetId : cell)))
        }
        for (const row of document.best.derived?.rows || []) {
          for (const role of ['beat', 'run']) {
            if (row[role]?.sailplanId === oldId) row[role].sailplanId = targetId
          }
        }
      }
      saveEditedDocument(res, req.params.id, document, () => {
        // The shared active-sailplan selection follows the rename, like the
        // active polar follows a document rename.
        if (targetId !== oldId && settings.activePolar === req.params.id && settings.activeSailplan === oldId) {
          settings.activeSailplan = targetId
          app.savePluginOptions(settings, () => {})
          publishActivePolar(settings.activePolar, settings.activeSailplan)
        }
        res.json({ id: targetId })
      })
    })

    router.access('readonly').get('/activePolar', (req, res) => {
      const id = settings.activePolar || null
      const sailplanId = settings.activeSailplan || null
      if (!id) {
        return res.json({ id: null, sailplanId: null, exists: false, valid: false, errors: [] })
      }
      if (!store.exists(id)) {
        return res.json({ id, sailplanId, exists: false, valid: false, errors: [`Configured active polar '${id}' was not found`] })
      }
      const document = store.get(id)
      const result = validatePolar(document)
      const errors = result.valid ? [] : result.errors.map(e => `${e.path}: ${e.message}`)
      if (result.valid) {
        const sailplanError = activeSailplanError(document, sailplanId, id)
        if (sailplanError) errors.push(sailplanError)
      }
      res.json({
        id,
        sailplanId,
        exists: true,
        valid: errors.length === 0,
        errors
      })
    })

    router.put('/activePolar', (req, res) => {
      const id = req.body?.id
      const sailplanId = req.body?.sailplanId
      if (id !== undefined && id !== null && typeof id !== 'string') {
        return res.status(400).json({ error: "'id' must be a string or null" })
      }
      if (sailplanId !== undefined && sailplanId !== null && (typeof sailplanId !== 'string' || !sailplanId.trim())) {
        return res.status(400).json({ error: "'sailplanId' must be a nonempty string, or omitted/null for best" })
      }
      if (!id && sailplanId) {
        return res.status(400).json({ error: "'sailplanId' requires an active polar 'id'" })
      }
      if (id && !store.exists(id)) {
        return res.status(404).json({ error: `Polar not found: ${id}` })
      }
      if (id) {
        const document = store.get(id)
        const validation = validatePolar(document)
        if (!validation.valid) {
          return res.status(400).json({ error: validation.errors.map(error => `${error.path}: ${error.message}`).join('; ') })
        }
        if (document.kind === 'polarSet' && req.body?.acknowledgeV2 !== true) {
          return res.status(409).json({
            error: 'Activating v2 requires acknowledgeV2: true after verifying all active-polar consumers support polarSet v2. This pointer selects the complete document and the shared active sailplan (omit sailplanId for best).'
          })
        }
        const sailplanError = activeSailplanError(document, sailplanId, id)
        if (sailplanError) {
          return res.status(400).json({ error: sailplanError })
        }
      }
      const nextSettings = { ...settings, activePolar: id || '', activeSailplan: (id && sailplanId) || '' }
      app.savePluginOptions(nextSettings, (err) => {
        if (err) return res.status(500).json({ error: err.message })
        settings.activePolar = nextSettings.activePolar
        settings.activeSailplan = nextSettings.activeSailplan
        if (id) publishActivePolar(id, settings.activeSailplan)
        else clearActivePolar()
        res.json({ id: settings.activePolar || null, sailplanId: settings.activeSailplan || null })
      })
    })

    router.access('readonly').get('/performanceFactor', (req, res) => {
      res.json({ value: settings.performanceFactor })
    })

    router.put('/performanceFactor', (req, res) => {
      if (!isValidPerformanceFactor(req.body?.value)) {
        return res.status(400).json({ error: 'Performance factor must be between 0 and 1' })
      }
      const nextSettings = { ...settings, performanceFactor: sanitizePerformanceFactor(req.body?.value) }
      app.savePluginOptions(nextSettings, (err) => {
        if (err) return res.status(500).json({ error: err.message })
        settings.performanceFactor = nextSettings.performanceFactor
        publishPerformanceFactor(settings.performanceFactor)
        res.json({ value: settings.performanceFactor })
      })
    })

    router.access('readonly').get('/waveCorrection', (req, res) => {
      res.json({ apply: settings.applyWaveCorrection })
    })

    router.put('/waveCorrection', (req, res) => {
      if (typeof req.body?.apply !== 'boolean') {
        return res.status(400).json({ error: "'apply' must be a boolean" })
      }
      const nextSettings = { ...settings, applyWaveCorrection: req.body.apply }
      app.savePluginOptions(nextSettings, (err) => {
        if (err) return res.status(500).json({ error: err.message })
        settings.applyWaveCorrection = nextSettings.applyWaveCorrection
        refreshApplyWaveCorrection()
        res.json({ apply: settings.applyWaveCorrection })
      })
    })

    router.access('readonly').get('/imports/formats', (req, res) => {
      res.json(importService.listFormats())
    })

    router.post('/imports/text/:format', (req, res) => {
      try {
        res.json(importService.importText(req.params.format, req.body))
      } catch (e) {
        res.status(e instanceof ImportError ? e.status : 500).json({ error: e.message })
      }
    })

    router.access('readonly').get('/imports/sources', (req, res) => {
      res.json(importService.listSources())
    })

    router.get('/imports/sources/:source/search', async (req, res) => {
      if (!await checkInternet()) {
        return res.status(503).json({ error: 'No internet connection — external source imports are unavailable' })
      }
      try {
        res.json(await importService.searchSource(req.params.source, req.query.q))
      } catch (e) {
        res.status(e instanceof ImportError ? e.status : 500).json({ error: e.message })
      }
    })

    router.post('/imports/sources/:source/items/:externalId', async (req, res) => {
      if (!await checkInternet()) {
        return res.status(503).json({ error: 'No internet connection — external source imports are unavailable' })
      }
      try {
        res.json(await importService.importSource(req.params.source, req.params.externalId, req.body))
      } catch (e) {
        res.status(e instanceof ImportError ? e.status : 500).json({ error: e.message })
      }
    })

    router.access('readonly').get('/exports/formats', (req, res) => {
      res.json([{ id: 'json', name: 'Canonical JSON', description: 'polar-format canonical document' }, ...exportService.listFormats()])
    })

    router.access('readonly').get('/polars/:id/export/:format', (req, res) => {
      try {
        const resource = store.get(req.params.id)
        const text = exportService.exportText(req.params.format, resource, req.query)
        const json = ['json', 'json-v1'].includes(req.params.format)
        const contentType = json ? 'application/json' : 'text/plain'
        const ext = json ? 'json' : 'txt'
        res.set('Content-Type', contentType)
        res.set('Content-Disposition', `attachment; filename="${req.params.id}.${ext}"`)
        res.send(text)
      } catch (e) {
        res.status(e instanceof ExportError ? e.status : 404).json({ error: e.message })
      }
    })
  }

  plugin.getOpenApi = () => require('./openApi.json')

  return plugin
}
