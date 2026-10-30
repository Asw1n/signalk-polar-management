'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validatePolar, migratePolarToV2 } = require('polar-format')
const PolarStore = require('../lib/PolarStore')
const { ImportService } = require('../lib/import/ImportService')
const { createCanonicalResource } = require('../lib/import/canonical')
const { selectTable } = require('../lib/polarDocument')
const { ExportService } = require('../lib/export/ExportService')
const { buildCurves } = require('../lib/CurveService')
const { Polar } = require('polar-math')
const { polarSet } = require('./fixtures/polarSet')

describe('canonical v1/v2 document boundary', () => {
  let directory
  let store
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-v2-'))
    store = new PolarStore(directory)
  })
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

  it('stores, reopens, copies, renames and edits v2 without dropping nested data or retaining a caller id', () => {
    const original = polarSet()
    assert.equal(validatePolar(original).valid, true)
    store.save('original', { ...original, id: 'untrusted' })
    assert.deepEqual(new PolarStore(directory).get('original'), original)
    store.copy('original', 'copy')
    store.rename('copy', 'renamed')
    store.modify('renamed', { id: 'edited', name: 'New name', year: null })
    const { year, ...rest } = original
    assert.deepEqual(store.get('edited'), { ...rest, name: 'New name' })
    assert.deepEqual(store.get('original'), original)
    assert.deepEqual(store.listWithMeta().find(item => item.id === 'original').tables, [
      { name: 'Best performance' }, { id: 'jib', name: 'Headsail' }
    ])
    store.delete('edited')
    assert.equal(store.exists('edited'), false)
  })

  it('rejects invalid v2 atomically and never auto-upgrades v1', () => {
    const v1 = createCanonicalResource({
      axes: { tws: [4], twa: [1, 2] }, values: { boatSpeedMatrix: [[2, 3]] }
    })
    store.save('one', v1)
    const bytes = fs.readFileSync(path.join(directory, 'one.json'), 'utf8')
    const bad = polarSet()
    bad.best.values.heelMatrix[0][1] = 0.2
    assert.throws(() => store.save('one', bad), /null|unavailable/i)
    assert.equal(fs.readFileSync(path.join(directory, 'one.json'), 'utf8'), bytes)
    assert.deepEqual(store.get('one'), v1)
    bad.best.values.heelMatrix[0][1] = null
    bad.best.derived.rows[0].run.vmg = -1
    assert.throws(() => store.save('one', bad), /vmg|>= 0/i)
    bad.best.derived.rows[0].run.vmg = 1
    bad.best.sailplanIdMatrix[0][0] = 'missing'
    assert.throws(() => store.save('one', bad), /sailplan/i)
  })

  it('canonical import/export round trips preserve v2, optional fields, nulls and references', () => {
    const original = polarSet()
    const service = new ImportService(store)
    const imported = service.importText('auto', { content: JSON.stringify(original) })
    assert.deepEqual(store.get(imported.id), original)
    const text = new ExportService().exportText('json', store.get(imported.id))
    assert.deepEqual(JSON.parse(text), original)
    const again = service.importText('canonical', { content: text, name: 'Override root' })
    assert.deepEqual(store.get(again.id), { ...original, name: 'Override root' })
    const bad = { ...original, schemaVersion: '2.1.0' }
    assert.throws(() => service.importText('auto', { content: JSON.stringify(bad) }), /schemaVersion/)
  })

  it('surfaces corrupt stored JSON in summaries without deleting or rewriting it', () => {
    const file = path.join(directory, 'broken.json')
    fs.writeFileSync(file, '{')
    const [summary] = store.listWithMeta()
    assert.equal(summary.id, 'broken')
    assert.match(summary.error, /JSON|property|position/i)
    assert.equal(fs.readFileSync(file, 'utf8'), '{')
  })

  it('selects only the requested table and rejects unknown IDs, including reserved-looking IDs', () => {
    const document = polarSet()
    document.sailplans[0].id = 'best'
    delete document.best.sailplanIdMatrix
    delete document.best.derived.rows[0].beat.sailplanId
    assert.equal(selectTable(document), document.best)
    assert.equal(selectTable(document, 'best'), document.sailplans[0].table)
    assert.throws(() => selectTable(document, ''), /nonempty/)
    assert.throws(() => selectTable(document, 'unknown'), /Unknown sailplan/)
    const v1 = createCanonicalResource({ axes: { tws: [4], twa: [1, 2] }, values: { boatSpeedMatrix: [[2, 3]] } })
    assert.equal(selectTable(v1), v1)
    assert.throws(() => selectTable(v1, 'best'), /Version 1/)
  })

  it('retains existing Jieter and Expedition imports as v1 and supports canonical v1 round trips', () => {
    const service = new ImportService(store)
    for (const content of ['twa;6;8\n60;4;5\n120;5;6\n', '6\t60\t4\t120\t5\n8\t60\t5\t120\t6\n']) {
      const { id } = service.importText('auto', { content })
      const document = store.get(id)
      assert.equal(document.kind, 'polarTable')
      assert.equal(document.schemaVersion, '1.0.0')
      const text = new ExportService().exportText('json', document)
      assert.equal(service.importText('auto', { content: text }).resource.schemaVersion, '1.0.0')
    }
  })
})

describe('selected-table export semantics', () => {
  const service = new ExportService()
  const options = { scope: 'table', acknowledgeLoss: 'true' }

  it('never silently flattens a set or claims a selected canonical v1 projection is lossless', () => {
    const document = polarSet()
    for (const format of ['jieter', 'expedition', 'json-v1']) {
      assert.throws(() => service.exportText(format, document), /acknowledgeLoss/)
      assert.throws(() => service.exportText(format, document, { scope: 'table' }), /acknowledgeLoss/)
      assert.throws(() => service.exportText(format, document, options), /missing speeds/)
    }
    assert.throws(() => service.exportText('json', document, { sailplanId: 'jib' }), /complete document/)
    assert.throws(() => service.exportText('json', document, { scope: 'table' }), /complete document/)
    assert.throws(() => service.exportText('expedition', document, { ...options, sailplanId: 'bad' }), /Unknown sailplan/)
    assert.deepEqual(document, polarSet())
  })

  it('explicitly projects only a selected table with root metadata, not sailplan context', () => {
    const document = polarSet()
    document.sailplans[0].table.values.boatSpeedMatrix[0][1] = 2.4
    const projected = JSON.parse(service.exportText('json-v1', document, { ...options, sailplanId: 'jib' }))
    assert.equal(validatePolar(projected).valid, true)
    assert.equal(projected.kind, 'polarTable')
    assert.equal(projected.name, 'Root boat')
    assert.equal(projected.notes, 'Root notes')
    assert.deepEqual(projected.axes, document.sailplans[0].table.axes)
    assert.deepEqual(projected.values, { boatSpeedMatrix: document.sailplans[0].table.values.boatSpeedMatrix })
    assert.deepEqual(projected.derived.rows[0].beat, { twa: 0.7, tbs: 2.2, vmg: 1.7 })
    for (const field of ['waveCorrection', 'sails', 'sailplans', 'sailplanIdMatrix']) assert.equal(Object.hasOwn(projected, field), false)
    for (const format of ['jieter', 'expedition']) {
      assert.equal(typeof service.exportText(format, document, { ...options, sailplanId: 'jib' }), 'string')
    }
    assert.equal(document.best.values.boatSpeedMatrix[0][1], null)
  })

  it('retains legacy v1 exports without new acknowledgment requirements', () => {
    const v1 = createCanonicalResource({ axes: { tws: [4], twa: [1, 2] }, values: { boatSpeedMatrix: [[0, 3]] } })
    for (const format of ['json', 'jieter', 'expedition', 'json-v1']) assert.ok(service.exportText(format, v1))
    assert.throws(() => service.exportText('unknown', v1), /Unsupported export/)
    assert.deepEqual(JSON.parse(service.exportText('json-v1', v1)), v1)
  })
})

describe('v2 curve dependency integration', () => {
  it('fails explicitly without supported math, or uses best/selected tables through the agreed API', () => {
    const document = polarSet()
    if (typeof Polar.fromPolarSet !== 'function') {
      assert.throws(() => buildCurves(document), error => error.status === 503 && /released polar-math/.test(error.message))
      assert.throws(() => buildCurves(document, 5, 1, 'missing'), /Unknown sailplan/)
      return
    }
    document.sailplans[0].table.values.boatSpeedMatrix = [[1, null, 1.5], [1.5, 2, 1.75]]
    document.sailplans[0].table.derived.rows.forEach(row => {
      for (const role of ['beat', 'run']) {
        row[role].tbs /= 2
        row[role].vmg /= 2
      }
    })
    const original = structuredClone(document)
    const best = buildCurves(document)
    const selected = buildCurves(document, 5, 1, 'jib')
    assert.equal(best.curves.length, 2)
    assert.equal(selected.curves.length, 2)
    assert.equal(best.curves[0].beat.tbs, 2.2)
    assert.equal(selected.curves[0].beat.tbs, 1.1)
    assert.equal(buildCurves(document, 5, 0.5).curves[0].beat.tbs, 1.1)
    assert.deepEqual(document, original)
    assert.throws(() => buildCurves(document, 5, 1, 'unknown'), /Unknown sailplan/)
  })

  it('does not alter migration or canonical stored versions to prepare curves', () => {
    const v1 = createCanonicalResource({ axes: { tws: [4], twa: [1, 2] }, values: { boatSpeedMatrix: [[2, 3]] } })
    assert.equal(migratePolarToV2(v1).valid, true)
    buildCurves(v1)
    assert.equal(v1.schemaVersion, '1.0.0')
  })
})
