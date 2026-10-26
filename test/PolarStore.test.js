'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const PolarStore = require('../lib/PolarStore')
const { createCanonicalResource } = require('../lib/import/canonical')

describe('PolarStore metadata editing', () => {
  let dataDir
  let store
  let original

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-metadata-test-'))
    store = new PolarStore(dataDir)
    original = {
      ...createCanonicalResource({
        axes: { tws: [5], twa: [0, Math.PI] },
        values: { boatSpeedMatrix: [[1, 2]] }
      }),
      name: 'Original boat',
      boatType: 'Cruiser',
      sailnumber: 'NL 123',
      year: 2020,
      source: 'ORC',
      notes: 'Keep these notes'
    }
    store.save('original', original)
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('edits all five fields while preserving all other polar data', () => {
    const result = store.modify('original', {
      id: 'new-id', name: 'New boat', boatType: 'Racer', sailnumber: 'GB 456', year: 2026
    })
    assert.equal(result, 'new-id')
    assert.deepEqual(store.list(), ['new-id'])
    assert.deepEqual(store.get('new-id'), {
      ...original, name: 'New boat', boatType: 'Racer', sailnumber: 'GB 456', year: 2026
    })
    assert.deepEqual(store.listWithMeta()[0], {
      id: 'new-id', name: 'New boat', boatType: 'Racer', sailnumber: 'GB 456', year: 2026,
      source: original.source, notes: original.notes, hasDerived: false
    })
  })

  it('updates metadata without requiring an id change and survives reopening the store', () => {
    store.modify('original', { id: 'original', name: 'Updated' })
    const reopened = new PolarStore(dataDir)
    assert.deepEqual(reopened.get('original'), { ...original, name: 'Updated' })
  })

  it('clears optional fields and trims text and id', () => {
    store.modify('original', {
      id: ' trimmed-id ', name: '', boatType: '  ', sailnumber: ' GB 789 ', year: null
    })
    const { name, boatType, year, ...expected } = original
    assert.deepEqual(store.get('trimmed-id'), { ...expected, sailnumber: 'GB 789' })
  })

  it('does not overwrite an existing polar when the new id conflicts', () => {
    store.save('existing', { ...original, name: 'Other boat' })
    assert.throws(() => store.modify('original', { id: 'existing', name: 'Changed' }), /already exists/)
    assert.deepEqual(store.get('original'), original)
    assert.deepEqual(store.get('existing'), { ...original, name: 'Other boat' })
  })

  for (const metadata of [
    null, [], {}, { id: '' }, { id: '  ' }, { id: '../outside' },
    { id: 'a'.repeat(101) }, { id: 'original', year: '2026' },
    { id: 'original', year: 2026.5 }, { id: 'original', year: false },
    { id: 'original', name: null }, { id: 'original', boatType: 123 },
    { id: 'original', sailnumber: [] }, { id: 'original', source: 'Changed' },
    { id: 'original', values: { boatSpeedMatrix: [[99, 99]] } }
  ]) {
    it(`rejects invalid metadata without changing storage: ${JSON.stringify(metadata)}`, () => {
      assert.throws(() => store.modify('original', metadata))
      assert.deepEqual(store.list(), ['original'])
      assert.deepEqual(store.get('original'), original)
    })
  }

  it('does not create a resource for a missing original id', () => {
    assert.throws(() => store.modify('missing', { id: 'new-id' }), /not found/)
    assert.deepEqual(store.list(), ['original'])
  })
})
