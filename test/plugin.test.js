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
})
