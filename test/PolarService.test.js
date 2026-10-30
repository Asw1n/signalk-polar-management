'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Polar } = require('polar-math')
const PolarStore = require('../lib/PolarStore')
const PolarService = require('../lib/PolarService')
const { polarSet } = require('./fixtures/polarSet')

function table(speed = 4) {
  return {
    kind: 'polarTable', schemaVersion: '1.0.0',
    units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
    symmetry: { portStarboardSymmetric: true },
    axes: { tws: [5, 10], twa: [Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4] },
    values: { boatSpeedMatrix: [[speed, speed + 1, speed], [speed + 1, speed + 2, speed + 1]] }
  }
}

describe('live polar service', () => {
  let directory, store, settings, errors, service

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-service-'))
    store = new PolarStore(directory)
    store.save('first', table())
    store.save('second', table(8))
    settings = { activePolar: 'first', performanceFactor: 0.9 }
    errors = []
    service = new PolarService(store, () => settings, message => errors.push(message))
  })

  afterEach(() => {
    service.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('prepares v2 best for existing live handles or explicitly reports unsupported math', (t) => {
    const document = polarSet()
    store.save('set', document)
    const prepare = typeof Polar.fromPolarSet === 'function' ? t.mock.method(Polar, 'fromPolarSet') : null
    const handle = service.api.polar('set', { performanceFactor: 0.8 })
    if (!prepare) {
      for (const method of ['speedAt', 'vmgAt', 'targetsAt', 'rangeAt']) {
        assert.equal(handle[method]({ tws: 4, twa: Math.PI / 3 }).state.reason, 'unsupported_math')
      }
      assert.match(errors.at(-1), /Polar.fromPolarSet/)
      store.modify('set', { id: 'set', name: 'Updated' })
      assert.equal(handle.speedAt({ tws: 4, twa: Math.PI / 3 }).state.reason, 'unsupported_math')
    } else {
      assert.equal(prepare.mock.callCount(), 1)
      assert.equal(handle.speedAt({ tws: 4, twa: Math.PI / 3 }).value, 1.6)
      const target = handle.targetsAt({ tws: 4 }).value.beat
      assert.equal(target.heel, 0.12)
      assert.equal(target.reef, 1.0006)
      assert.equal(target.flat, 1)
      const waveSpeed = handle.speedAt({
        tws: 4, twa: Math.PI / 3,
        seaState: { significantWaveHeight: 1, wavePeriod: 5, waveAngle: 0 }
      }).value
      assert.ok(Math.abs(waveSpeed - 1.28) < 1e-12)
      const active = service.api.activePolar()
      settings.activePolar = 'set'
      service.notify({ type: 'selection' })
      settings.performanceFactor = 0.5
      assert.equal(active.speedAt({ tws: 4, twa: Math.PI / 3 }).value, 1)
      assert.equal(handle.speedAt({ tws: 4, twa: Math.PI / 3 }).value, 1.6)
      store.modify('set', { id: 'set', name: 'Updated' })
      assert.equal(prepare.mock.callCount(), 2)
      assert.equal(handle.speedAt({ tws: 4, twa: Math.PI / 3 }).value, 1.6)
      document.best.values.boatSpeedMatrix[0][0] = 4
      store.save('set', document)
      assert.equal(handle.speedAt({ tws: 4, twa: Math.PI / 3 }).value, 3.2)
      assert.equal(prepare.mock.callCount(), 3)
      assert.ok(prepare.mock.calls.every(call => call.arguments[1] === undefined))
      assert.deepEqual(errors, [])
    }
    service.stop()
    assert.equal(handle.speedAt({ tws: 4, twa: 1 }).state.reason, 'provider_stopped')
  })

  it('does not present malformed v2 documents as unsupported math or keep stale prepared data', () => {
    const handle = service.api.polar('first')
    const document = polarSet()
    document.best.values.boatSpeedMatrix[0].pop()
    fs.writeFileSync(path.join(directory, 'first.json'), JSON.stringify(document))
    service.refresh('first')
    assert.equal(handle.speedAt({ tws: 4, twa: 1 }).state.reason, 'invalid_polar')
    assert.match(errors.at(-1), /Cannot prepare polar/)
  })

  it('prepares only the active table at startup even with 200 stored polars', (t) => {
    service.stop()
    for (let i = 0; i < 198; i++) store.save(`unused-${i}`, table())
    const read = t.mock.method(store, 'get')
    const prepare = t.mock.method(Polar, 'fromTable')
    service = new PolarService(store, () => settings, message => errors.push(message))
    assert.equal(store.list().length, 200)
    assert.equal(read.mock.callCount(), 1)
    assert.equal(prepare.mock.callCount(), 1)
    assert.deepEqual([...service.cache.keys()], ['first'])
    service.api.activePolar()
    service.api.polar('first')
    assert.equal(prepare.mock.callCount(), 1)
    service.api.polar('second')
    service.api.polar('second', { performanceFactor: 0.8 })
    assert.equal(read.mock.callCount(), 2)
    assert.equal(prepare.mock.callCount(), 2)
    assert.equal(service.cache.size, 2)
  })

  it('does not prepare unused imports, edits, copies or renames until requested', (t) => {
    const prepare = t.mock.method(Polar, 'fromTable')
    store.saveCanonical('imported', table())
    store.save('second', table(6))
    store.modify('second', { id: 'second', name: 'Unused' })
    store.copy('second', 'copy')
    store.rename('copy', 'renamed')
    assert.equal(prepare.mock.callCount(), 0)
    assert.deepEqual([...service.cache.keys()], ['first'])
    assert.equal(service.api.polar('renamed').speedAt({ tws: 5, twa: Math.PI / 2 }).value, 7)
    assert.equal(prepare.mock.callCount(), 1)
  })

  it('prepares a new selection before notifying consumers and reuses it on later selections', (t) => {
    const prepare = t.mock.method(Polar, 'fromTable')
    const active = service.api.activePolar()
    const results = []
    active.onChange(() => results.push(active.speedAt({ tws: 5, twa: Math.PI / 2 }).value))
    settings.activePolar = 'second'
    service.notify({ type: 'selection' })
    assert.deepEqual(results, [8.1])
    assert.equal(prepare.mock.callCount(), 1)
    settings.activePolar = 'first'
    service.notify({ type: 'selection' })
    settings.activePolar = 'second'
    service.notify({ type: 'selection' })
    assert.deepEqual(results, [8.1, 4.5, 8.1])
    assert.equal(prepare.mock.callCount(), 1)
  })

  it('starts with no prepared tables when there is no active selection', (t) => {
    service.stop()
    settings.activePolar = ''
    const prepare = t.mock.method(Polar, 'fromTable')
    service = new PolarService(store, () => settings, message => errors.push(message))
    const active = service.api.activePolar()
    assert.equal(service.cache.size, 0)
    assert.equal(prepare.mock.callCount(), 0)
    settings.activePolar = 'later'
    service.notify({ type: 'selection' })
    assert.equal(active.speedAt({}).state.reason, 'polar_not_found')
    store.save('later', table())
    assert.equal(active.speedAt({ tws: 5, twa: Math.PI / 2 }).value, 4.5)
    assert.equal(prepare.mock.callCount(), 1)
  })

  it('does not prepare tables when handles are acquired from a stopped service', (t) => {
    service.stop()
    const prepare = t.mock.method(Polar, 'fromTable')
    const handle = service.api.polar('second')
    assert.equal(handle.speedAt({}).state.reason, 'provider_stopped')
    assert.equal(service.cache.size, 0)
    assert.equal(service.requested.size, 0)
    assert.equal(prepare.mock.callCount(), 0)
  })

  it('uses the latest selection and factor on every call without reacquisition or subscriptions', () => {
    const active = service.api.activePolar()
    const input = { tws: 5, twa: Math.PI / 2 }
    assert.equal(active.speedAt(input).value, 4.5)
    settings.activePolar = 'second'
    service.notify({ type: 'selection' })
    assert.equal(active.speedAt(input).value, 8.1)
    settings.performanceFactor = 0.5
    assert.equal(active.speedAt(input).value, 4.5)
    store.save('second', table(18))
    assert.equal(active.speedAt(input).value, 9.5)
    assert.ok(Object.isFrozen(active))
    assert.equal(active.entries, undefined)
    assert.deepEqual(errors, [])
  })

  it('defaults specific handles to 1 and fixes explicit factors independently of shared settings', () => {
    const raw = service.api.polar('first')
    const options = { performanceFactor: 0.8 }
    const adjusted = service.api.polar('first', options)
    options.performanceFactor = 0.1
    settings.activePolar = 'second'
    settings.performanceFactor = 0.2
    const input = { tws: 5, twa: Math.PI / 2, performanceFactor: 0.01 }
    assert.equal(raw.speedAt(input).value, 5)
    assert.equal(adjusted.speedAt(input).value, 4)
    store.saveCanonical('first', table(9))
    assert.equal(raw.speedAt(input).value, 10)
    assert.equal(adjusted.speedAt(input).value, 8)
    assert.equal(service.api.polar('first', { performanceFactor: 0 }).speedAt(input).value, 0)
    assert.equal(service.api.polar('first', { performanceFactor: 1.2 }).speedAt(input).value, 12)
  })

  it('preserves all math methods, extrapolation options, states and SI output shapes', () => {
    const handle = service.api.polar('first', { performanceFactor: 0.8 })
    const reference = Polar.fromTable(table())
    for (const method of ['speedAt', 'vmgAt', 'targetsAt', 'rangeAt']) {
      for (const input of [
        { tws: 7, twa: 1.2 },
        { tws: 1, twa: 0.1, extrapolate: false },
        { tws: 20, twa: -2.5 },
        { tws: NaN, twa: 0 },
        { tws: 5, twa: 4 }
      ]) {
        assert.deepEqual(handle[method](input), reference[method]({ ...input, performanceFactor: 0.8 }))
      }
    }
  })

  it('does no I/O or preparation in repeated acquisition and query calls', (t) => {
    const read = t.mock.method(store, 'get', () => { throw new Error('Unexpected read') })
    const exists = t.mock.method(store, 'exists', () => { throw new Error('Unexpected stat') })
    const prepare = t.mock.method(Polar, 'fromTable', () => { throw new Error('Unexpected preparation') })
    for (let i = 0; i < 10000; i++) {
      assert.equal(service.api.activePolar().speedAt({ tws: 5, twa: Math.PI / 2 }).value, 4.5)
      assert.equal(service.api.polar('first').targetsAt({ tws: 5 }).state.available, true)
    }
    assert.equal(read.mock.callCount(), 0)
    assert.equal(exists.mock.callCount(), 0)
    assert.equal(prepare.mock.callCount(), 0)
  })

  it('shares one preparation per updated table rather than preparing per handle', (t) => {
    const prepare = t.mock.method(Polar, 'fromTable')
    const handles = Array.from({ length: 10 }, () => service.api.polar('first'))
    store.save('first', table(6))
    for (const handle of handles) assert.equal(handle.speedAt({ tws: 5, twa: Math.PI / 2 }).value, 7)
    assert.equal(prepare.mock.callCount(), 1)
    settings.performanceFactor = 0.2
    service.notify({ type: 'performanceFactor' })
    assert.equal(prepare.mock.callCount(), 1)
  })

  it('returns explicit unavailable results for no selection, missing and deleted polars', () => {
    const active = service.api.activePolar()
    settings.activePolar = ''
    assert.deepEqual(active.speedAt({}), {
      value: null,
      state: { available: false, reason: 'no_active_polar', tws: null, twa: null }
    })
    settings.activePolar = 'missing'
    assert.equal(active.targetsAt({ tws: 5 }).state.reason, 'polar_not_found')
    const specific = service.api.polar('first')
    store.delete('first')
    assert.equal(specific.speedAt({}).state.reason, 'polar_not_found')
    store.save('first', table(7))
    assert.equal(specific.speedAt({ tws: 5, twa: Math.PI / 2 }).value, 8)
  })

  it('reports corrupt and invalid stored tables once during preparation, never using stale data', () => {
    service.stop()
    fs.writeFileSync(path.join(directory, 'first.json'), '{')
    fs.writeFileSync(path.join(directory, 'second.json'), '{}')
    service = new PolarService(store, () => settings, message => errors.push(message))
    const active = service.api.activePolar()
    assert.equal(errors.length, 1)
    service.api.polar('second')
    assert.equal(errors.length, 2)
    assert.match(errors[0], /Cannot prepare polar/)
    for (let i = 0; i < 10; i++) assert.equal(active.speedAt({}).state.reason, 'invalid_polar')
    assert.equal(errors.length, 2)
    store.save('first', table())
    assert.equal(active.speedAt({ tws: 5, twa: Math.PI / 2 }).value, 4.5)
  })

  it('refreshes and notifies for every store mutation, including imports and metadata moves', () => {
    const events = []
    const first = service.api.polar('first')
    const copied = service.api.polar('copy')
    first.onChange(event => events.push(event))
    copied.onChange(event => events.push(event))
    store.saveCanonical('first', table(6))
    store.modify('first', { id: 'first', name: 'Updated' })
    store.copy('first', 'copy')
    assert.equal(copied.speedAt({ tws: 5, twa: Math.PI / 2 }).value, 7)
    store.rename('copy', 'renamed')
    assert.equal(copied.speedAt({}).state.reason, 'polar_not_found')
    store.modify('renamed', { id: 'copy' })
    assert.equal(copied.speedAt({ tws: 5, twa: Math.PI / 2 }).value, 7)
    store.delete('copy')
    assert.deepEqual(events.map(event => event.type), [
      'saved', 'modified', 'copied', 'renamed', 'modified', 'deleted'
    ])
    assert.ok(events.every(event => Object.isFrozen(event) && Object.isFrozen(event.ids)))
    assert.throws(() => store.save('first', {}))
    assert.equal(events.length, 6)
  })

  it('filters notifications by handle and supports unsubscribe and listener error isolation', () => {
    const activeEvents = []
    const specificEvents = []
    const active = service.api.activePolar()
    const specific = service.api.polar('second')
    active.onChange(() => { throw new Error('Consumer failed') })
    active.onChange(event => activeEvents.push(event.type))
    const unsubscribe = specific.onChange(event => specificEvents.push(event.type))
    service.notify({ type: 'selection' })
    service.notify({ type: 'performanceFactor' })
    store.save('second', table(9))
    store.save('first', table(3))
    assert.deepEqual(activeEvents, ['selection', 'performanceFactor', 'saved'])
    assert.deepEqual(specificEvents, ['saved'])
    assert.equal(errors.length, 3)
    assert.match(errors[0], /Polar change listener failed: Consumer failed/)
    unsubscribe()
    unsubscribe()
    store.delete('second')
    assert.deepEqual(specificEvents, ['saved'])
  })

  it('permanently retires old handles and releases cache and subscriptions on stop', () => {
    const active = service.api.activePolar()
    const specific = service.api.polar('first')
    const events = []
    active.onChange(event => {
      events.push(event.type)
      assert.equal(active.speedAt({}).state.reason, 'provider_stopped')
    })
    specific.onChange(event => events.push(event.type))
    service.stop()
    service.stop()
    assert.deepEqual(events, ['stopped', 'stopped'])
    assert.equal(service.api.available, false)
    assert.equal(service.cache.size, 0)
    assert.equal(service.requested.size, 0)
    assert.equal(service.listeners.size, 0)
    assert.equal(store.onChange, null)
    assert.equal(specific.targetsAt({}).state.reason, 'provider_stopped')
    assert.throws(() => active.onChange(() => {}), /stopped/)
    const next = new PolarService(store, () => settings, message => errors.push(message))
    assert.equal(next.api.activePolar().speedAt({ tws: 5, twa: Math.PI / 2 }).value, 4.5)
    assert.equal(active.speedAt({}).state.reason, 'provider_stopped')
    next.stop()
  })

  it('rejects invalid acquisition and subscription arguments explicitly', () => {
    for (const id of ['', ' ', null, undefined, 1]) {
      assert.throws(() => service.api.polar(id), /non-empty string/)
    }
    for (const performanceFactor of [-1, NaN, Infinity, '0.8', null]) {
      assert.throws(() => service.api.polar('first', { performanceFactor }), /finite non-negative/)
    }
    assert.throws(() => service.api.activePolar().onChange(null), /requires a function/)
  })
})
