'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

function createFakeApp(dataDir) {
  const registeredProviders = []
  return {
    getDataDirPath: () => dataDir,
    handleMessage: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    savePluginOptions: (opts, cb) => cb && cb(null),
    registerResourceProvider: (provider) => registeredProviders.push(provider),
    _registeredProviders: registeredProviders
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
})
