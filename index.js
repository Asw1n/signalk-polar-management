'use strict'

const path = require('path')
const { validatePolarTable } = require('polar-format')
const PolarStore = require('./lib/PolarStore')
const PolarService = require('./lib/PolarService')
const { ImportService, ImportError } = require('./lib/import/ImportService')
const { ExportService, ExportError } = require('./lib/export/ExportService')
const { buildCurves, DEFAULT_STEP_DEG } = require('./lib/CurveService')

const ACTIVE_POLAR_PATH = 'polars.activePolar'
const PERFORMANCE_FACTOR_PATH = 'polars.performanceFactor'
const DEFAULT_PERFORMANCE_FACTOR = 1
const RESOURCE_TYPE = 'polars'

module.exports = (app) => {
  let settings = {}
  let store = null
  let importService = null
  let exportService = null
  let polarService = null
  let activePolarPublished = false
  let performanceFactorPublished = false

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
              description: 'Pointer to the selected polar resource.',
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
          }
        ]
      }]
    })
  }

  function publishActivePolar(id) {
    const value = id ? { href: `/resources/${RESOURCE_TYPE}/${id}` } : null
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: ACTIVE_POLAR_PATH, value }] }]
    })
    activePolarPublished = !!id
    polarService?.notify({ type: 'selection' })
  }

  function clearActivePolar() {
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

  plugin.start = (options) => {
    if (polarService) plugin.stop()
    settings = { activePolar: '', performanceFactor: DEFAULT_PERFORMANCE_FACTOR, ...options }
    settings.performanceFactor = sanitizePerformanceFactor(settings.performanceFactor)
    store = new PolarStore(path.join(app.getDataDirPath(), 'polars'))
    importService = new ImportService(store)
    exportService = new ExportService()

    publishMetadata()
    publishPerformanceFactor(settings.performanceFactor)

    if (settings.activePolar && store.exists(settings.activePolar)) {
      publishActivePolar(settings.activePolar)
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
        res.json({ id: req.params.id, ...buildCurves(table, step, performanceFactor) })
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })

    router.access('readonly').get('/polars/:id/validate', (req, res) => {
      let table
      try {
        table = store.get(req.params.id)
      } catch (e) {
        return res.status(404).json({ error: e.message })
      }
      const result = validatePolarTable(table)
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
        publishActivePolar(newId)
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
          publishActivePolar(newId)
        }
        res.json({ id: newId })
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })

    router.access('readonly').get('/internet', async (req, res) => {
      res.json({ online: await checkInternet() })
    })

    router.access('readonly').get('/activePolar', (req, res) => {
      const id = settings.activePolar || null
      if (!id) {
        return res.json({ id: null, exists: false, valid: false, errors: [] })
      }
      if (!store.exists(id)) {
        return res.json({ id, exists: false, valid: false, errors: [`Configured active polar '${id}' was not found`] })
      }
      const result = validatePolarTable(store.get(id))
      res.json({
        id,
        exists: true,
        valid: result.valid,
        errors: result.valid ? [] : result.errors.map(e => `${e.path}: ${e.message}`)
      })
    })

    router.put('/activePolar', (req, res) => {
      const id = req.body?.id
      if (id && !store.exists(id)) {
        return res.status(404).json({ error: `Polar not found: ${id}` })
      }
      const nextSettings = { ...settings, activePolar: id || '' }
      app.savePluginOptions(nextSettings, (err) => {
        if (err) return res.status(500).json({ error: err.message })
        settings.activePolar = nextSettings.activePolar
        if (id) publishActivePolar(id)
        else clearActivePolar()
        res.json({ id: settings.activePolar || null })
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
        const text = exportService.exportText(req.params.format, resource)
        const contentType = req.params.format === 'json' ? 'application/json' : 'text/plain'
        const ext = req.params.format === 'json' ? 'json' : 'txt'
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
