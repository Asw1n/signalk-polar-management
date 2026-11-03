'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pluginFactory = require('../index')
const PolarStore = require('../lib/PolarStore')
const { Polar } = require('polar-math')
const { polarSet } = require('./fixtures/polarSet')

function withRoutePolicies(router) {
  if (router.routePolicies instanceof Map) return router

  const policies = new Map()
  const methods = ['get', 'post', 'put', 'patch', 'delete']
  const originalMethods = new Map()
  for (const method of methods) {
    if (typeof router[method] !== 'function') continue
    const original = router[method]
    originalMethods.set(method, original)
    router[method] = (route, ...handlers) => {
      policies.set(`${method.toUpperCase()} ${route}`, 'admin')
      return original.call(router, route, ...handlers)
    }
  }

  router.access = (level) => {
    if (level !== 'readonly' && level !== 'readwrite') {
      throw new Error(`Unsupported route access level: ${level}`)
    }
    const scopedRouter = {}
    for (const [method, original] of originalMethods) {
      scopedRouter[method] = (route, ...handlers) => {
        policies.set(`${method.toUpperCase()} ${route}`, level)
        return original.call(router, route, ...handlers)
      }
    }
    return scopedRouter
  }
  router.routePolicies = policies
  return router
}

function createTestPlugin(app) {
  const plugin = pluginFactory(app)
  const registerWithRouter = plugin.registerWithRouter
  plugin.registerWithRouter = (router) => registerWithRouter(withRoutePolicies(router))
  return plugin
}

function createFakeApp(dataDir) {
  const registeredProviders = []
  const messages = []
  const savedOptions = []
  const propertyHistory = [undefined]
  const propertyListeners = new Set()
  return {
    getDataDirPath: () => dataDir,
    handleMessage: (source, delta) => messages.push({ source, delta }),
    setPluginStatus: () => {},
    setPluginError: () => {},
    savePluginOptions: (opts, cb) => {
      savedOptions.push({ ...opts })
      cb && cb(null)
    },
    registerResourceProvider: (provider) => registeredProviders.push(provider),
    emitPropertyValue: (name, value) => {
      propertyHistory.push({ setter: 'signalk-polar-management', name, value })
      for (const callback of propertyListeners) callback(propertyHistory)
    },
    onPropertyValues: (name, callback) => {
      propertyListeners.add(callback)
      callback(propertyHistory)
      return () => propertyListeners.delete(callback)
    },
    _propertyHistory: propertyHistory,
    _registeredProviders: registeredProviders,
    _messages: messages,
    _savedOptions: savedOptions
  }
}

describe('plugin lifecycle', () => {
  let dataDir

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-management-test-'))
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true     })
  })

  describe('plugin route access policies', () => {
    it('allows readonly access only to static import and export catalogs', () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-management-routes-'))
      try {
        const plugin = createTestPlugin(createFakeApp(dataDir))
        const router = {
          get: () => {},
          put: () => {},
          post: () => {},
          delete: () => {}
        }
        plugin.registerWithRouter(router)

        assert.deepEqual(Object.fromEntries(router.routePolicies), {
          'GET /polars': 'readonly',
          'GET /polars/:id': 'readonly',
          'GET /polars/:id/curves': 'readonly',
          'GET /polars/:id/validate': 'readonly',
          'POST /polars/:id/copy': 'admin',
          'PUT /polars/:id': 'admin',
          'DELETE /polars/:id': 'admin',
          'PUT /polars/:id/metadata': 'admin',
          'POST /polars/:id/rename': 'admin',
          'GET /internet': 'readonly',
          'GET /polars/:id/waveCorrection': 'readonly',
          'PUT /polars/:id/waveCorrection': 'admin',
          'POST /polars/:id/waveCorrection/import': 'admin',
          'DELETE /polars/:id/waveCorrection': 'admin',
          'POST /polars/:id/sailplans': 'admin',
          'DELETE /polars/:id/sailplans/:sailplanId': 'admin',
          'PUT /polars/:id/sailplans/:sailplanId/metadata': 'admin',
          'GET /activePolar': 'readonly',
          'PUT /activePolar': 'admin',
          'GET /performanceFactor': 'readonly',
          'PUT /performanceFactor': 'admin',
          'GET /waveCorrection': 'readonly',
          'PUT /waveCorrection': 'admin',
          'GET /imports/formats': 'readonly',
          'POST /imports/text/:format': 'admin',
          'GET /imports/sources': 'readonly',
          'GET /imports/sources/:source/search': 'admin',
          'POST /imports/sources/:source/items/:externalId': 'admin',
          'GET /exports/formats': 'readonly',
          'GET /polars/:id/export/:format': 'readonly'
        })
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true })
      }
    })
  })

  it('start -> stop -> start succeeds with empty config', () => {
    const app = createFakeApp(dataDir)
    const plugin = createTestPlugin(app)

    assert.doesNotThrow(() => plugin.start({}))
    assert.doesNotThrow(() => plugin.stop())
    assert.doesNotThrow(() => plugin.start({}))
    plugin.stop()
  })

  it('announces only lifecycle transitions for early and late consumers and retires old handles', () => {
    const app = createFakeApp(dataDir)
    const plugin = createTestPlugin(app)
    const early = []
    const unsubscribe = app.onPropertyValues('polarManagement', history => early.push(history.at(-1)?.value))
    assert.deepEqual(early, [undefined])
    plugin.start({})
    const first = early.at(-1)
    assert.equal(first.apiVersion, 1)
    assert.equal(first.available, true)
    assert.deepEqual(first.listPolars(), { value: [], state: { available: true } })
    assert.deepEqual(first.getSelection(), {
      value: { polarId: null, sailplanId: null, performanceFactor: 1, applyWaveCorrection: true },
      state: { available: true }
    })
    const events = []
    first.onChange(event => events.push(event.type))
    const handle = first.activePolar()
    let late
    app.onPropertyValues('polarManagement', history => { late = history.at(-1)?.value })
    assert.equal(late, first)
    plugin.stop()
    assert.deepEqual(late, { apiVersion: 1, available: false })
    assert.equal(first.available, false)
    assert.deepEqual(events, ['stopped'])
    assert.equal(first.listPolars().state.reason, 'provider_stopped')
    assert.equal(handle.speedAt({}).state.reason, 'provider_stopped')
    plugin.start({})
    assert.equal(late.available, true)
    assert.notEqual(late, first)
    assert.deepEqual(late.listPolars(), { value: [], state: { available: true } })
    assert.equal(first.getSelection().state.reason, 'provider_stopped')
    assert.equal(handle.speedAt({}).state.reason, 'provider_stopped')
    // Saving options may also call start again without a preceding stop.
    const second = late
    plugin.start({ performanceFactor: 0.8 })
    assert.equal(second.available, false)
    assert.equal(late.available, true)
    assert.equal(early.length, 6)
    unsubscribe()
    plugin.stop()
    assert.equal(early.length, 6)
    assert.equal(app._propertyHistory.length, 7)
  })

  it('registers a resource provider for type polars', () => {
    const app = createFakeApp(dataDir)
    const plugin = createTestPlugin(app)
    plugin.start({})
    assert.equal(app._registeredProviders.length, 1)
    assert.equal(app._registeredProviders[0].type, 'polars')
    plugin.stop()
  })

  it('registers the resource provider before it publishes the active polar', async () => {
    new PolarStore(path.join(dataDir, 'polars')).save('boat', {
      kind: 'polarTable', schemaVersion: '1.0.0', name: 'Boat',
      units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
      symmetry: { portStarboardSymmetric: true },
      axes: { tws: [5], twa: [0, Math.PI] },
      values: { boatSpeedMatrix: [[1, 2]] }
    })
    const app = createFakeApp(dataDir)
    let loaded
    const handleMessage = app.handleMessage
    app.handleMessage = (source, delta) => {
      handleMessage(source, delta)
      const value = delta.updates[0].values?.find(item => item.path === 'polars.activePolar')?.value
      // Load it the moment the delta arrives, as a subscribed consumer would.
      if (value) loaded = app._registeredProviders[0]?.methods.getResource(value.href.split('/').pop())
    }
    const plugin = createTestPlugin(app)

    plugin.start({ activePolar: 'boat' })

    assert.ok(loaded, 'the active polar was published with no provider registered')
    assert.equal((await loaded).name, 'Boat')
    plugin.stop()
  })

  it('publishes metadata for active polar and performance factor paths', () => {
    const app = createFakeApp(dataDir)
    const plugin = createTestPlugin(app)

    plugin.start({})
    const meta = app._messages.flatMap(message => message.delta.updates[0].meta || [])

    assert.ok(meta.some(item => item.path === 'polars.activePolar'))
    assert.ok(meta.some(item => item.path === 'polars.performanceFactor'))
    assert.ok(meta.some(item => item.path === 'polars.applyWaveCorrection'))
    assert.ok(meta.some(item => item.path === 'polars.boatName'))
    assert.ok(meta.some(item => item.path === 'polars.sailPlan'))
    plugin.stop()
  })

  it('publishes, persists and clears the performance factor', () => {
    const app = createFakeApp(dataDir)
    const plugin = createTestPlugin(app)
    plugin.start({ performanceFactor: 0.85 })

    assert.deepEqual(app._messages.at(-1).delta.updates[0].values, [
      { path: 'polars.performanceFactor', value: 0.85 }
    ])

    const routes = {}
    plugin.registerWithRouter({
      get: (route, handler) => { routes[`GET ${route}`] = handler },
      put: (route, handler) => { routes[`PUT ${route}`] = handler },
      post: () => {},
      delete: () => {}
    })

    let responseBody
    routes['PUT /performanceFactor'](
      { body: { value: 0.9 } },
      { status: () => ({ json: (body) => { responseBody = body } }), json: (body) => { responseBody = body } }
    )

    assert.deepEqual(responseBody, { value: 0.9 })
    assert.equal(app._savedOptions.at(-1).performanceFactor, 0.9)
    assert.deepEqual(app._messages.at(-1).delta.updates[0].values, [
      { path: 'polars.performanceFactor', value: 0.9 }
    ])

    plugin.stop()
    assert.deepEqual(app._messages.at(-1).delta.updates[0].values, [
      { path: 'polars.performanceFactor', value: null }
    ])
  })

  it('rejects out-of-range performance factors', () => {
    const app = createFakeApp(dataDir)
    const plugin = createTestPlugin(app)
    plugin.start({})

    const routes = {}
    plugin.registerWithRouter({
      get: () => {},
      put: (route, handler) => { routes[`PUT ${route}`] = handler },
      post: () => {},
      delete: () => {}
    })

    let statusCode
    let responseBody
    routes['PUT /performanceFactor'](
      { body: { value: 1.1 } },
      { status: (code) => { statusCode = code; return { json: (body) => { responseBody = body } } } }
    )

    assert.equal(statusCode, 400)
    assert.equal(responseBody.error, 'Performance factor must be between 0 and 1')
    plugin.stop()
  })

  describe('metadata endpoint', () => {
    let app
    let plugin
    let routes
    let provider
    let original

    beforeEach(() => {
      app = createFakeApp(dataDir)
      plugin = createTestPlugin(app)
      plugin.start({})
      provider = app._registeredProviders[0].methods
      original = {
        kind: 'polarTable', schemaVersion: '1.0.0', name: 'Original boat',
        units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
        symmetry: { portStarboardSymmetric: true },
        axes: { tws: [5], twa: [0, Math.PI] },
        values: { boatSpeedMatrix: [[1, 2]] },
        source: 'ORC', notes: 'Keep notes'
      }
      routes = {}
      plugin.registerWithRouter({
        get: (route, handler) => { routes[`GET ${route}`] = handler },
        put: (route, handler) => { routes[`PUT ${route}`] = handler },
        post: () => {},
        delete: () => {}
      })
    })

      it('preserves complete v2 resources through provider, routes, metadata and active-pointer lifecycle', async () => {
        const app = createFakeApp(dataDir)
        const plugin = createTestPlugin(app)
        plugin.start({})
        try {
          const provider = app._registeredProviders[0].methods
          const original = polarSet()
          await provider.setResource('set', original)
          const routes = {}
          const router = {}
          for (const method of ['get', 'put', 'post', 'delete']) {
            router[method] = (route, handler) => { routes[`${method.toUpperCase()} ${route}`] = handler }
          }
          plugin.registerWithRouter(router)
          const request = (route, req = {}) => {
            let status = 200
            let body
            const headers = {}
            const res = {
              status: code => { status = code; return res },
              json: value => { body = value },
              send: value => { body = value },
              set: (key, value) => { headers[key] = value },
              end: () => {}
            }
            routes[route]({ query: {}, ...req }, res)
            return { status, body, headers }
          }
          assert.deepEqual(await provider.getResource('set'), original)
          assert.deepEqual(request('GET /polars/:id', { params: { id: 'set' } }).body, original)
          assert.equal(request('GET /polars/:id/validate', { params: { id: 'set' } }).body.valid, true)
          assert.equal((await provider.listResources()).set.kind, 'polarSet')
          const exported = request('GET /polars/:id/export/:format', { params: { id: 'set', format: 'json' } })
          assert.deepEqual(JSON.parse(exported.body), original)
          assert.equal(exported.headers['Content-Type'], 'application/json')
          const incompatible = request('GET /polars/:id/export/:format', {
            params: { id: 'set', format: 'expedition' }, query: { scope: 'table', acknowledgeLoss: 'true' }
          })
          assert.equal(incompatible.status, 400)
          assert.match(incompatible.body.error, /missing speeds/)
          assert.equal(request('PUT /activePolar', { body: { id: 'set' } }).status, 409)
          assert.equal(request('GET /activePolar').body.id, null)
          assert.equal(request('PUT /activePolar', { body: { id: 'set', acknowledgeV2: true } }).status, 200)
          assert.deepEqual(app._messages.at(-1).delta.updates[0].values, [
            { path: 'polars.activePolar', value: { href: '/resources/polars/set' } }
          ])
          assert.equal(request('GET /activePolar').body.valid, true)
          const count = app._messages.length
          const curves = request('GET /polars/:id/curves', { params: { id: 'set' }, query: { sailplanId: 'jib' } })
          assert.ok([200, 503].includes(curves.status))
          assert.equal(request('GET /polars/:id/curves', { params: { id: 'set' }, query: { sailplanId: 'unknown' } }).status, 400)
          assert.equal(app._messages.length, count)
          request('PUT /polars/:id/metadata', { params: { id: 'set' }, body: { id: 'renamed', name: 'Edited' } })
          assert.deepEqual(await provider.getResource('renamed'), { ...original, name: 'Edited' })
          assert.equal(request('GET /activePolar').body.id, 'renamed')
          await assert.rejects(provider.deleteResource('renamed'), /active polar/)
          assert.equal(request('DELETE /polars/:id', { params: { id: 'renamed' } }).status, 409)
          assert.equal(request('PUT /activePolar', { body: { id: null } }).status, 200)
          await provider.deleteResource('renamed')
          await assert.rejects(provider.getResource('renamed'), /not found/)
          assert.ok(app._messages.every(message => (message.delta.updates[0].values || []).every(value =>
            ['polars.activePolar', 'polars.performanceFactor', 'polars.applyWaveCorrection', 'polars.boatName', 'polars.sailPlan'].includes(value.path))))
        } finally {
          plugin.stop()
        }
      })

      it('activates, publishes, persists and resets a shared v2 sailplan selection', async () => {
        const app = createFakeApp(dataDir)
        const plugin = createTestPlugin(app)
        plugin.start({})
        try {
          const document = polarSet()
          document.sailplans[0].table.values.boatSpeedMatrix[0][0] = 2.5
          await app._registeredProviders[0].methods.setResource('set', document)
          const routes = {}
          plugin.registerWithRouter({
            get: (route, handler) => { routes[`GET ${route}`] = handler },
            put: (route, handler) => { routes[`PUT ${route}`] = handler },
            post: () => {}, delete: () => {}
          })
          const request = (route, req = {}) => {
            let status = 200
            let body
            const res = { status: code => { status = code; return res }, json: value => { body = value } }
            routes[route]({ query: {}, ...req }, res)
            return { status, body }
          }
          const activated = request('PUT /activePolar', { body: { id: 'set', sailplanId: 'jib', acknowledgeV2: true } })
          assert.equal(activated.status, 200)
          assert.deepEqual(activated.body, { id: 'set', sailplanId: 'jib' })
          assert.deepEqual(app._messages.at(-1).delta.updates[0].values, [
            { path: 'polars.activePolar', value: { href: '/resources/polars/set', sailplanId: 'jib' } }
          ])
          assert.equal(app._savedOptions.at(-1).activeSailplan, 'jib')
          assert.deepEqual(request('GET /activePolar').body,
            { id: 'set', sailplanId: 'jib', exists: true, valid: true, errors: [] })
          const active = app._propertyHistory.at(-1).value.activePolar()
          const input = { tws: 4, twa: Math.PI / 3 }
          if (typeof Polar.fromPolarSet === 'function') {
            assert.equal(active.speedAt(input).value, 2.5)
          } else {
            assert.equal(active.speedAt(input).state.reason, 'unsupported_math')
          }
          const reset = request('PUT /activePolar', { body: { id: 'set', acknowledgeV2: true } })
          assert.deepEqual(reset.body, { id: 'set', sailplanId: null })
          assert.deepEqual(app._messages.at(-1).delta.updates[0].values, [
            { path: 'polars.activePolar', value: { href: '/resources/polars/set' } }
          ])
          assert.equal(app._savedOptions.at(-1).activeSailplan, '')
          if (typeof Polar.fromPolarSet === 'function') {
            assert.equal(active.speedAt(input).value, 2)
          }
        } finally {
          plugin.stop()
        }
      })

      it('publishes the active boat name and sailplan name', async () => {
        const app = createFakeApp(dataDir)
        const plugin = createTestPlugin(app)
        plugin.start({})
        try {
          const identity = () => {
            const latest = {}
            for (const message of app._messages) {
              for (const value of message.delta.updates[0].values || []) {
                if (['polars.boatName', 'polars.sailPlan'].includes(value.path)) latest[value.path] = value.value
              }
            }
            return [latest['polars.boatName'], latest['polars.sailPlan']]
          }
          assert.deepEqual(identity(), [null, null])
          await app._registeredProviders[0].methods.setResource('set', polarSet())
          const routes = {}
          plugin.registerWithRouter({
            get: (route, handler) => { routes[`GET ${route}`] = handler },
            put: (route, handler) => { routes[`PUT ${route}`] = handler },
            post: () => {}, delete: () => {}
          })
          const request = (route, req = {}) => {
            let status = 200
            let body
            const res = { status: code => { status = code; return res }, json: value => { body = value } }
            routes[route]({ query: {}, ...req }, res)
            return { status, body }
          }
          assert.equal(request('PUT /activePolar', { body: { id: 'set', acknowledgeV2: true } }).status, 200)
          assert.deepEqual(identity(), ['Root boat', 'best'])
          assert.equal(request('PUT /activePolar', { body: { id: 'set', sailplanId: 'jib', acknowledgeV2: true } }).status, 200)
          assert.deepEqual(identity(), ['Root boat', 'Headsail'])
          assert.equal(request('PUT /polars/:id/sailplans/:sailplanId/metadata',
            { params: { id: 'set', sailplanId: 'jib' }, body: { name: 'Genoa' } }).status, 200)
          assert.deepEqual(identity(), ['Root boat', 'Genoa'])
          assert.equal(request('PUT /polars/:id/metadata',
            { params: { id: 'set' }, body: { id: 'set', name: 'Edited boat' } }).status, 200)
          assert.deepEqual(identity(), ['Edited boat', 'Genoa'])
          assert.equal(request('PUT /activePolar', { body: { id: null } }).status, 200)
          assert.deepEqual(identity(), [null, null])
        } finally {
          plugin.stop()
        }
      })

      it('rejects unusable shared sailplan selections without changing the active pointer', async () => {
        const app = createFakeApp(dataDir)
        const plugin = createTestPlugin(app)
        plugin.start({})
        try {
          const provider = app._registeredProviders[0].methods
          await provider.setResource('set', polarSet())
          await provider.setResource('v1', {
            kind: 'polarTable', schemaVersion: '1.0.0', name: 'V1',
            units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
            symmetry: { portStarboardSymmetric: true },
            axes: { tws: [5], twa: [0, Math.PI] },
            values: { boatSpeedMatrix: [[1, 2]] }
          })
          const routes = {}
          plugin.registerWithRouter({
            get: (route, handler) => { routes[`GET ${route}`] = handler },
            put: (route, handler) => { routes[`PUT ${route}`] = handler },
            post: () => {}, delete: () => {}
          })
          const request = (route, req = {}) => {
            let status = 200
            let body
            const res = { status: code => { status = code; return res }, json: value => { body = value } }
            routes[route]({ query: {}, ...req }, res)
            return { status, body }
          }
          const unknown = request('PUT /activePolar', { body: { id: 'set', sailplanId: 'unknown', acknowledgeV2: true } })
          assert.equal(unknown.status, 400)
          assert.match(unknown.body.error, /Active sailplan 'unknown' was not found in 'set'/)
          const v1 = request('PUT /activePolar', { body: { id: 'v1', sailplanId: 'jib' } })
          assert.equal(v1.status, 400)
          assert.match(v1.body.error, /v1 document without sailplans/)
          assert.equal(request('PUT /activePolar', { body: { id: null, sailplanId: 'jib' } }).status, 400)
          assert.equal(request('PUT /activePolar', { body: { id: 'set', sailplanId: '', acknowledgeV2: true } }).status, 400)
          assert.equal(request('PUT /activePolar', { body: { id: 'set', sailplanId: 7, acknowledgeV2: true } }).status, 400)
          assert.deepEqual(request('GET /activePolar').body,
            { id: null, sailplanId: null, exists: false, valid: false, errors: [] })
          assert.deepEqual(app._savedOptions, [])
        } finally {
          plugin.stop()
        }
      })

      it('strictly invalidates a removed active sailplan and refuses to publish it on restart', async () => {
        const app = createFakeApp(dataDir)
        const pluginErrors = []
        app.setPluginError = message => pluginErrors.push(message)
        const plugin = createTestPlugin(app)
        plugin.start({})
        try {
          await app._registeredProviders[0].methods.setResource('set', polarSet())
          const routes = {}
          plugin.registerWithRouter({
            get: (route, handler) => { routes[`GET ${route}`] = handler },
            put: (route, handler) => { routes[`PUT ${route}`] = handler },
            post: () => {}, delete: () => {}
          })
          const request = (route, req = {}) => {
            let status = 200
            let body
            const res = { status: code => { status = code; return res }, json: value => { body = value } }
            routes[route]({ query: {}, ...req }, res)
            return { status, body }
          }
          assert.equal(request('PUT /activePolar', { body: { id: 'set', sailplanId: 'jib', acknowledgeV2: true } }).status, 200)
          const active = app._propertyHistory.at(-1).value.activePolar()
          // Replace the document with a valid v2 that no longer contains 'jib'.
          const replaced = polarSet()
          replaced.sailplans[0].id = 'genoa'
          delete replaced.best.sailplanIdMatrix
          delete replaced.best.derived.rows[0].beat.sailplanId
          assert.equal(request('PUT /polars/:id', { params: { id: 'set' }, body: replaced }).status, 200)
          const status = request('GET /activePolar').body
          assert.equal(status.sailplanId, 'jib')
          assert.equal(status.valid, false)
          assert.match(status.errors.join('; '), /Active sailplan 'jib' was not found in 'set'/)
          assert.equal(active.speedAt({ tws: 4, twa: 1 }).state.reason, 'sailplan_not_found')
          // Restarting with the persisted broken selection reports an error, never publishes it.
          plugin.stop()
          plugin.start({ activePolar: 'set', activeSailplan: 'jib' })
          assert.ok(pluginErrors.some(message => /Active sailplan 'jib' was not found in 'set'/.test(message)))
          const pointerValues = app._messages.flatMap(message =>
            (message.delta.updates[0].values || []).filter(value => value.path === 'polars.activePolar'))
          assert.equal(pointerValues.at(-1).value, null)
        } finally {
          plugin.stop()
        }
      })

      it('publishes the wave toggle as null whenever the active polar cannot use it', async () => {
        const app = createFakeApp(dataDir)
        const plugin = createTestPlugin(app)
        plugin.start({})
        try {
          const waveValues = () => app._messages.flatMap(message =>
            (message.delta.updates[0].values || []).filter(value => value.path === 'polars.applyWaveCorrection'))
          // No active polar: the path explicitly carries null while the stored setting stays on.
          assert.equal(waveValues().at(-1).value, null)
          const provider = app._registeredProviders[0].methods
          await provider.setResource('set', polarSet())
          await provider.setResource('plain', {
            kind: 'polarTable', schemaVersion: '1.0.0', name: 'V1',
            units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
            symmetry: { portStarboardSymmetric: true },
            axes: { tws: [5], twa: [0, Math.PI] },
            values: { boatSpeedMatrix: [[1, 2]] }
          })
          const routes = {}
          plugin.registerWithRouter({
            get: (route, handler) => { routes[`GET ${route}`] = handler },
            put: (route, handler) => { routes[`PUT ${route}`] = handler },
            post: () => {}, delete: () => {}
          })
          const request = (route, req = {}) => {
            let status = 200
            let body
            const res = { status: code => { status = code; return res }, json: value => { body = value } }
            routes[route]({ query: {}, ...req }, res)
            return { status, body }
          }
          assert.deepEqual(request('GET /waveCorrection').body, { apply: true })
          assert.equal(request('PUT /activePolar', { body: { id: 'set', acknowledgeV2: true } }).status, 200)
          assert.equal(waveValues().at(-1).value, true)
          const active = app._propertyHistory.at(-1).value.activePolar()
          const input = { tws: 4, twa: Math.PI / 3, seaState: { significantWaveHeight: 1, wavePeriod: 5, waveAngle: 0 } }
          if (typeof Polar.fromPolarSet === 'function') {
            assert.ok(Math.abs(active.speedAt(input).value - 1.6) < 1e-12)
          }
          const off = request('PUT /waveCorrection', { body: { apply: false } })
          assert.equal(off.status, 200)
          assert.deepEqual(off.body, { apply: false })
          assert.equal(app._savedOptions.at(-1).applyWaveCorrection, false)
          assert.equal(waveValues().at(-1).value, false)
          if (typeof Polar.fromPolarSet === 'function') {
            assert.equal(active.speedAt(input).value, 2)
          }
          // A v1 active polar nulls the path; the stored setting is kept.
          assert.equal(request('PUT /activePolar', { body: { id: 'plain' } }).status, 200)
          assert.equal(waveValues().at(-1).value, null)
          assert.equal(request('PUT /waveCorrection', { body: { apply: true } }).status, 200)
          assert.deepEqual(request('GET /waveCorrection').body, { apply: true })
          assert.equal(waveValues().at(-1).value, null)
          assert.equal(request('PUT /waveCorrection', { body: { apply: 'yes' } }).status, 400)
          // Reactivating a wave-capable polar republishes the stored setting.
          assert.equal(request('PUT /activePolar', { body: { id: 'set', acknowledgeV2: true } }).status, 200)
          assert.equal(waveValues().at(-1).value, true)
          // Replacing the active document without a wave table nulls the path again.
          const replaced = polarSet()
          delete replaced.waveCorrection
          assert.equal(request('PUT /polars/:id', { params: { id: 'set' }, body: replaced }).status, 200)
          assert.equal(waveValues().at(-1).value, null)
          plugin.stop()
          assert.equal(waveValues().at(-1).value, null)
        } finally {
          plugin.stop()
        }
      })

      it('does not change the active document when persisting a v2 activation fails', async () => {
        const app = createFakeApp(dataDir)
        const plugin = createTestPlugin(app)
        plugin.start({})
        try {
          await app._registeredProviders[0].methods.setResource('set', polarSet())
          const routes = {}
          plugin.registerWithRouter({
            get: (route, handler) => { routes[`GET ${route}`] = handler },
            put: (route, handler) => { routes[`PUT ${route}`] = handler },
            post: () => {}, delete: () => {}
          })
          app.savePluginOptions = (_, callback) => callback(new Error('Disk full'))
          const count = app._messages.length
          let status
          const res = { status: code => { status = code; return res }, json: () => {} }
          routes['PUT /activePolar']({ body: { id: 'set', acknowledgeV2: true } }, res)
          assert.equal(status, 500)
          assert.equal(app._messages.length, count)
          let body
          routes['GET /activePolar']({}, { json: value => { body = value } })
          assert.equal(body.id, null)
        } finally {
          plugin.stop()
        }
      })

    afterEach(() => plugin.stop())

    function request(route, req) {
      let status = 200
      let body
      const res = {
        status: code => { status = code; return res },
        json: value => { body = value }
      }
      routes[route](req, res)
      return { status, body }
    }

    it('keeps acquired handles live through resource writes, selection, factors and metadata renames', async () => {
      await provider.setResource('original', original)
      const api = app._propertyHistory.at(-1).value
      const active = api.activePolar()
      const specific = api.polar('original')
      const activeEvents = []
      const specificEvents = []
      active.onChange(event => activeEvents.push(event.type))
      specific.onChange(event => specificEvents.push(event.type))
      const input = { tws: 5, twa: 0, extrapolate: false }
      assert.equal(active.speedAt(input).state.reason, 'no_active_polar')
      assert.equal(request('PUT /activePolar', { body: { id: 'original' } }).status, 200)
      assert.equal(active.speedAt(input).value, 1)
      request('PUT /performanceFactor', { body: { value: 0.5 } })
      assert.equal(active.speedAt(input).value, 0.5)
      assert.equal(specific.speedAt(input).value, 1)
      const updated = { ...original, values: { boatSpeedMatrix: [[4, 8]] } }
      assert.equal(request('PUT /polars/:id', { params: { id: 'original' }, body: updated }).status, 200)
      assert.equal(active.speedAt(input).value, 2)
      assert.equal(specific.speedAt(input).value, 4)
      await provider.setResource('original', original)
      assert.equal(active.speedAt(input).value, 0.5)
      request('PUT /polars/:id/metadata', { params: { id: 'original' }, body: { id: 'renamed' } })
      assert.equal(active.speedAt(input).value, 0.5)
      assert.equal(specific.speedAt(input).state.reason, 'polar_not_found')
      const renamed = api.polar('renamed')
      request('PUT /activePolar', { body: { id: null } })
      assert.equal(active.speedAt(input).state.reason, 'no_active_polar')
      await provider.deleteResource('renamed')
      assert.equal(renamed.speedAt(input).state.reason, 'polar_not_found')
      assert.ok(activeEvents.includes('selection'))
      assert.ok(activeEvents.includes('performanceFactor'))
      assert.ok(activeEvents.includes('saved'))
      assert.ok(activeEvents.includes('modified'))
      assert.ok(!specificEvents.includes('selection'))
      assert.ok(!specificEvents.includes('performanceFactor'))
      assert.equal(app._propertyHistory.length, 2)
    })

    it('does not expose failed selection or factor saves to live calculations', async () => {
      await provider.setResource('original', original)
      const active = app._propertyHistory.at(-1).value.activePolar()
      request('PUT /activePolar', { body: { id: 'original' } })
      const events = []
      active.onChange(event => events.push(event))
      app.savePluginOptions = (_options, callback) => callback(new Error('Cannot save'))
      assert.equal(request('PUT /activePolar', { body: { id: null } }).status, 500)
      assert.equal(request('PUT /performanceFactor', { body: { value: 0.1 } }).status, 500)
      assert.equal(active.speedAt({ tws: 5, twa: 0, extrapolate: false }).value, 1)
      assert.deepEqual(events, [])
    })

    it('modifies metadata visible through both plugin and resource provider APIs', async () => {
      await provider.setResource('original', original)
      const result = request('PUT /polars/:id/metadata', {
        params: { id: 'original' },
        body: { id: 'new-id', name: 'New boat', boatType: 'Racer', sailnumber: 'GB 123', year: 2026 }
      })
      assert.deepEqual(result, { status: 200, body: { id: 'new-id' } })
      assert.deepEqual(await provider.getResource('new-id'), {
        ...original, name: 'New boat', boatType: 'Racer', sailnumber: 'GB 123', year: 2026
      })
      assert.equal(request('GET /polars', {}).body[0].id, 'new-id')
      await assert.rejects(provider.getResource('original'), /not found/)
      assert.equal(app._savedOptions.length, 0)
    })

    it('persists and publishes the new id when modifying the active polar', async () => {
      await provider.setResource('original', original)
      request('PUT /activePolar', { body: { id: 'original' } })
      const result = request('PUT /polars/:id/metadata', {
        params: { id: 'original' }, body: { id: 'new-id', name: 'New boat' }
      })
      assert.equal(result.status, 200)
      assert.equal(app._savedOptions.at(-1).activePolar, 'new-id')
      assert.deepEqual(app._messages.at(-1).delta.updates[0].values, [
        { path: 'polars.activePolar', value: { href: '/resources/polars/new-id' } }
      ])
      const active = request('GET /activePolar', {}).body
      assert.equal(active.id, 'new-id')
      assert.equal(active.valid, true)
      const restartedApp = createFakeApp(dataDir)
      const restarted = createTestPlugin(restartedApp)
      restarted.start(app._savedOptions.at(-1))
      assert.ok(restartedApp._messages.some(message =>
        message.delta.updates[0].values?.some(value => value.value?.href === '/resources/polars/new-id')
      ))
      restarted.stop()
    })

    it('leaves the active selection untouched for a same-id metadata edit', async () => {
      await provider.setResource('original', original)
      request('PUT /activePolar', { body: { id: 'original' } })
      const count = app._messages.length
      request('PUT /polars/:id/metadata', {
        params: { id: 'original' }, body: { id: 'original', year: 2026 }
      })
      assert.equal(request('GET /activePolar', {}).body.id, 'original')
      assert.equal(app._messages.length, count)
      assert.equal((await provider.getResource('original')).year, 2026)
    })

    it('rejects missing polars and invalid metadata', async () => {
      await provider.setResource('original', original)
      assert.equal(request('PUT /polars/:id/metadata', {
        params: { id: 'missing' }, body: { id: 'new-id' }
      }).status, 404)
      assert.equal(request('PUT /polars/:id/metadata', {
        params: { id: 'original' }, body: { id: 'new-id', year: 1.5 }
      }).status, 400)
      assert.deepEqual(await provider.getResource('original'), original)
    })

    it('restores the original polar and selection if saving options fails', async () => {
      await provider.setResource('original', original)
      request('PUT /activePolar', { body: { id: 'original' } })
      const count = app._messages.length
      app.savePluginOptions = (options, callback) => callback(new Error('Disk full'))
      const result = request('PUT /polars/:id/metadata', {
        params: { id: 'original' }, body: { id: 'new-id', name: 'New boat' }
      })
      assert.equal(result.status, 500)
      assert.match(result.body.error, /Disk full/)
      assert.deepEqual(await provider.getResource('original'), original)
      await assert.rejects(provider.getResource('new-id'), /not found/)
      assert.equal(request('GET /activePolar', {}).body.id, 'original')
      assert.equal(app._messages.length, count)
    })
  })

  describe('document editing endpoints', () => {
    let app
    let plugin
    let provider
    let routes

    const v1Table = () => ({
      kind: 'polarTable', schemaVersion: '1.0.0', name: 'Storm table',
      units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
      symmetry: { portStarboardSymmetric: true },
      axes: { tws: [5], twa: [0, Math.PI] },
      values: { boatSpeedMatrix: [[1, 2]] }
    })

    beforeEach(() => {
      app = createFakeApp(dataDir)
      plugin = createTestPlugin(app)
      plugin.start({})
      provider = app._registeredProviders[0].methods
      routes = {}
      plugin.registerWithRouter({
        get: (route, handler) => { routes[`GET ${route}`] = handler },
        put: (route, handler) => { routes[`PUT ${route}`] = handler },
        post: (route, handler) => { routes[`POST ${route}`] = handler },
        delete: (route, handler) => { routes[`DELETE ${route}`] = handler }
      })
    })

    afterEach(() => plugin.stop())

    function request(route, req = {}) {
      let status = 200
      let body
      const res = {
        status: code => { status = code; return res },
        json: value => { body = value },
        end: () => {}
      }
      routes[route]({ query: {}, ...req }, res)
      return { status, body }
    }

    const waveValues = () => app._messages.flatMap(message =>
      (message.delta.updates[0].values || []).filter(value => value.path === 'polars.applyWaveCorrection'))

    it('imports, exports and deletes a wave correction with explicit null publication', async () => {
      const bare = polarSet()
      delete bare.waveCorrection
      await provider.setResource('set', bare)
      await provider.setResource('plain', v1Table())
      assert.equal(request('GET /polars/:id/waveCorrection', { params: { id: 'set' } }).status, 404)
      assert.equal(request('PUT /activePolar', { body: { id: 'set', acknowledgeV2: true } }).status, 200)
      assert.equal(waveValues().at(-1).value, null)

      const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'timezero', 'Wave_Polar.xml'), 'utf8')
      const imported = request('POST /polars/:id/waveCorrection/import', { params: { id: 'set' }, body: { content: xml } })
      assert.equal(imported.status, 200)
      assert.deepEqual(imported.body, { heights: 6 })
      assert.equal(waveValues().at(-1).value, true)

      // UTF-16 content decoded as UTF-8 (NUL-padded) still imports.
      const nulPadded = [...xml].map(character => character + '\u0000').join('')
      assert.equal(request('POST /polars/:id/waveCorrection/import', {
        params: { id: 'set' }, body: { content: nulPadded }
      }).status, 200)

      const exported = request('GET /polars/:id/waveCorrection', { params: { id: 'set' } })
      assert.equal(exported.status, 200)
      const { waveCorrection } = exported.body
      assert.deepEqual(waveCorrection.heights.map(layer => layer.significantWaveHeight), [0, 0.5, 2, 5, 10, 15])
      assert.ok(Math.abs(waveCorrection.heights[0].axes.waveAngle.at(-1) - Math.PI) < 1e-12)
      assert.ok(waveCorrection.heights[0].values.speedFactorMatrix.every(row => row.every(factor => factor === 1)))

      // Canonical JSON fragments round-trip through PUT and import.
      assert.equal(request('PUT /polars/:id/waveCorrection', {
        params: { id: 'set' }, body: { waveCorrection }
      }).status, 200)
      assert.equal(request('POST /polars/:id/waveCorrection/import', {
        params: { id: 'set' }, body: { content: JSON.stringify({ waveCorrection }) }
      }).status, 200)

      // Invalid fragments are rejected and leave the document unchanged.
      const broken = structuredClone(waveCorrection)
      broken.heights[0].values.speedFactorMatrix[0][0] = 0.5
      const rejected = request('PUT /polars/:id/waveCorrection', { params: { id: 'set' }, body: { waveCorrection: broken } })
      assert.equal(rejected.status, 400)
      assert.deepEqual((await provider.getResource('set')).waveCorrection, waveCorrection)

      assert.equal(request('DELETE /polars/:id/waveCorrection', { params: { id: 'set' } }).status, 204)
      assert.equal(request('GET /polars/:id/waveCorrection', { params: { id: 'set' } }).status, 404)
      assert.equal(waveValues().at(-1).value, null)
      assert.equal(request('DELETE /polars/:id/waveCorrection', { params: { id: 'set' } }).status, 404)

      // v1 documents can never carry a wave correction.
      assert.equal(request('PUT /polars/:id/waveCorrection', { params: { id: 'plain' }, body: { waveCorrection } }).status, 400)
      assert.equal(request('POST /polars/:id/waveCorrection/import', { params: { id: 'plain' }, body: { content: xml } }).status, 400)
      assert.equal(request('GET /polars/:id/waveCorrection', { params: { id: 'plain' } }).status, 404)
    })

    it('edits polar notes through the metadata endpoint', async () => {
      await provider.setResource('plain', v1Table())
      assert.equal(request('PUT /polars/:id/metadata', {
        params: { id: 'plain' }, body: { id: 'plain', notes: 'Fresh notes' }
      }).status, 200)
      assert.equal((await provider.getResource('plain')).notes, 'Fresh notes')
      assert.equal(request('PUT /polars/:id/metadata', {
        params: { id: 'plain' }, body: { id: 'plain', notes: '' }
      }).status, 200)
      assert.equal(Object.hasOwn(await provider.getResource('plain'), 'notes'), false)
    })

    it('imports, edits and deletes sailplans with strict reference handling', async () => {
      await provider.setResource('set', polarSet())
      await provider.setResource('plain', v1Table())

      // 'jib' is referenced by best's winning-sailplan data: deletion is rejected.
      const referenced = request('DELETE /polars/:id/sailplans/:sailplanId', { params: { id: 'set', sailplanId: 'jib' } })
      assert.equal(referenced.status, 409)
      assert.match(referenced.body.error, /references it/)

      // Import a new sailplan from canonical v1 single-table content.
      const added = request('POST /polars/:id/sailplans', {
        params: { id: 'set' }, body: { content: JSON.stringify(v1Table()), name: 'Storm set' }
      })
      assert.equal(added.status, 200)
      assert.deepEqual(added.body, { id: 'storm-set' })
      const stored = await provider.getResource('set')
      const storm = stored.sailplans.find(plan => plan.id === 'storm-set')
      assert.equal(storm.name, 'Storm set')
      assert.deepEqual(storm.table, { axes: v1Table().axes, values: v1Table().values })
      assert.equal(request('POST /polars/:id/sailplans', {
        params: { id: 'set' }, body: { content: JSON.stringify(v1Table()), name: 'Storm set' }
      }).status, 400)

      // Sailplan metadata edits, including an id rename that updates best's
      // winning references and follows the shared active selection.
      assert.equal(request('PUT /activePolar', { body: { id: 'set', sailplanId: 'jib', acknowledgeV2: true } }).status, 200)
      const renamed = request('PUT /polars/:id/sailplans/:sailplanId/metadata', {
        params: { id: 'set', sailplanId: 'jib' }, body: { id: 'headsail', name: 'Headsail', notes: 'Renamed' }
      })
      assert.equal(renamed.status, 200)
      assert.deepEqual(renamed.body, { id: 'headsail' })
      const updated = await provider.getResource('set')
      assert.equal(updated.sailplans.find(plan => plan.id === 'headsail').notes, 'Renamed')
      assert.equal(updated.best.sailplanIdMatrix[0][0], 'headsail')
      assert.equal(updated.best.derived.rows[0].beat.sailplanId, 'headsail')
      assert.equal(request('GET /activePolar', {}).body.sailplanId, 'headsail')
      assert.deepEqual(app._messages.at(-1).delta.updates[0].values, [
        { path: 'polars.activePolar', value: { href: '/resources/polars/set', sailplanId: 'headsail' } }
      ])

      // The active sailplan cannot be deleted; unreferenced inactive ones can.
      const active = request('DELETE /polars/:id/sailplans/:sailplanId', { params: { id: 'set', sailplanId: 'headsail' } })
      assert.equal(active.status, 409)
      assert.match(active.body.error, /active sailplan/)
      assert.equal(request('DELETE /polars/:id/sailplans/:sailplanId', { params: { id: 'set', sailplanId: 'storm-set' } }).status, 204)
      assert.equal((await provider.getResource('set')).sailplans.some(plan => plan.id === 'storm-set'), false)
      assert.equal(request('DELETE /polars/:id/sailplans/:sailplanId', { params: { id: 'set', sailplanId: 'storm-set' } }).status, 404)

      // Duplicate ids and v1 targets are rejected.
      assert.equal(request('PUT /polars/:id/sailplans/:sailplanId/metadata', {
        params: { id: 'set', sailplanId: 'headsail' }, body: { id: 'headsail', name: 'Headsail' }
      }).status, 200)
      assert.equal(request('POST /polars/:id/sailplans', {
        params: { id: 'plain' }, body: { content: JSON.stringify(v1Table()), name: 'Nope' }
      }).status, 400)
      assert.equal(request('POST /polars/:id/sailplans', {
        params: { id: 'set' }, body: { content: JSON.stringify(polarSet()), name: 'Nope' }
      }).status, 400)
    })
  })
})
