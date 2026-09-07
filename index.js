'use strict'

const path = require('path')
const PolarStore = require('./lib/PolarStore')
const { ImportService, ImportError } = require('./lib/import/ImportService')
const { ExportService, ExportError } = require('./lib/export/ExportService')

const ACTIVE_POLAR_PATH = 'polars.activePolar'
const RESOURCE_TYPE = 'polars'

module.exports = (app) => {
  let settings = {}
  let store = null
  let importService = null
  let exportService = null
  let activePolarPublished = false

  const plugin = {
    id: 'signalk-polar-management',
    name: 'Polar Management'
  }

  function publishActivePolar(id) {
    const value = id ? { href: `/resources/${RESOURCE_TYPE}/${id}` } : null
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: ACTIVE_POLAR_PATH, value }] }]
    })
    activePolarPublished = !!id
  }

  function clearActivePolar() {
    if (!activePolarPublished) return
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: ACTIVE_POLAR_PATH, value: null }] }]
    })
    activePolarPublished = false
  }

  plugin.start = (options) => {
    settings = { activePolar: '', ...options }
    store = new PolarStore(path.join(app.getDataDirPath(), 'polars'))
    importService = new ImportService(store)
    exportService = new ExportService()

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
  }

  plugin.stop = () => {
    clearActivePolar()
    store = null
    importService = null
    exportService = null
  }

  plugin.schema = () => ({ type: 'object', properties: {} })

  plugin.registerWithRouter = (router) => {
    router.get('/polars', (req, res) => {
      res.json(store.listWithMeta())
    })

    router.get('/polars/:id', (req, res) => {
      try {
        res.json({ id: req.params.id, ...store.get(req.params.id) })
      } catch (e) {
        res.status(404).json({ error: e.message })
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

    router.get('/activePolar', (req, res) => {
      res.json({ id: settings.activePolar || null })
    })

    router.put('/activePolar', (req, res) => {
      const id = req.body?.id
      if (id && !store.exists(id)) {
        return res.status(404).json({ error: `Polar not found: ${id}` })
      }
      settings.activePolar = id || ''
      app.savePluginOptions(settings, (err) => {
        if (err) return res.status(500).json({ error: err.message })
        if (id) publishActivePolar(id)
        else clearActivePolar()
        res.json({ id: settings.activePolar || null })
      })
    })

    router.get('/imports/formats', (req, res) => {
      res.json(importService.listFormats())
    })

    router.post('/imports/text/:format', (req, res) => {
      try {
        res.json(importService.importText(req.params.format, req.body))
      } catch (e) {
        res.status(e instanceof ImportError ? e.status : 500).json({ error: e.message })
      }
    })

    router.get('/imports/sources', (req, res) => {
      res.json(importService.listSources())
    })

    router.get('/imports/sources/:source/search', async (req, res) => {
      try {
        res.json(await importService.searchSource(req.params.source, req.query.q))
      } catch (e) {
        res.status(e instanceof ImportError ? e.status : 500).json({ error: e.message })
      }
    })

    router.post('/imports/sources/:source/items/:externalId', async (req, res) => {
      try {
        res.json(await importService.importSource(req.params.source, req.params.externalId, req.body))
      } catch (e) {
        res.status(e instanceof ImportError ? e.status : 500).json({ error: e.message })
      }
    })

    router.get('/exports/formats', (req, res) => {
      res.json([{ id: 'json', name: 'Canonical JSON', description: 'polar-format canonical document' }, ...exportService.listFormats()])
    })

    router.get('/polars/:id/export/:format', (req, res) => {
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
