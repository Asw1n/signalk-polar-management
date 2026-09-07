'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

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
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('start -> stop -> start succeeds with empty config', () => {
    const app = createFakeApp(dataDir)
    const plugin = require('../index')(app)

    assert.doesNotThrow(() => plugin.start({}))
    assert.doesNotThrow(() => plugin.stop())
    assert.doesNotThrow(() => plugin.start({}))
    plugin.stop()
  })

  it('registers a resource provider for type polars', () => {
    const app = createFakeApp(dataDir)
    const plugin = require('../index')(app)
    plugin.start({})
    assert.equal(app._registeredProviders.length, 1)
    assert.equal(app._registeredProviders[0].type, 'polars')
    plugin.stop()
  })

  it('publishes metadata for active polar and performance factor paths', () => {
    const app = createFakeApp(dataDir)
    const plugin = require('../index')(app)

    plugin.start({})
    const meta = app._messages.flatMap(message => message.delta.updates[0].meta || [])

    assert.ok(meta.some(item => item.path === 'polars.activePolar'))
    assert.ok(meta.some(item => item.path === 'polars.performanceFactor'))
    plugin.stop()
  })

  it('publishes, persists and clears the performance factor', () => {
    const app = createFakeApp(dataDir)
    const plugin = require('../index')(app)
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
    const plugin = require('../index')(app)
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
