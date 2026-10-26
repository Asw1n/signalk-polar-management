'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pluginFactory = require('../index')

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
          'GET /activePolar': 'readonly',
          'PUT /activePolar': 'admin',
          'GET /performanceFactor': 'readonly',
          'PUT /performanceFactor': 'admin',
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

  it('registers a resource provider for type polars', () => {
    const app = createFakeApp(dataDir)
    const plugin = createTestPlugin(app)
    plugin.start({})
    assert.equal(app._registeredProviders.length, 1)
    assert.equal(app._registeredProviders[0].type, 'polars')
    plugin.stop()
  })

  it('publishes metadata for active polar and performance factor paths', () => {
    const app = createFakeApp(dataDir)
    const plugin = createTestPlugin(app)

    plugin.start({})
    const meta = app._messages.flatMap(message => message.delta.updates[0].meta || [])

    assert.ok(meta.some(item => item.path === 'polars.activePolar'))
    assert.ok(meta.some(item => item.path === 'polars.performanceFactor'))
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
})
