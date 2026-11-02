'use strict'

const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validatePolar } = require('polar-format')
const PolarStore = require('../lib/PolarStore')
const { ImportService } = require('../lib/import/ImportService')
const { ExportService } = require('../lib/export/ExportService')
const { buildCurves } = require('../lib/CurveService')
const { Polar } = require('polar-math')
const SI = require('../lib/SI')

it('round trips the local ORC reference guide and checks all 336 supplied points without distributing it', {
  skip: !process.env.ORC_SPEED_GUIDE_HTML
}, () => {
  const content = fs.readFileSync(process.env.ORC_SPEED_GUIDE_HTML, 'utf8')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-guide-integration-'))
  try {
    const store = new PolarStore(directory)
    const service = new ImportService(store)
    assert.equal(service.detectFormat(content).id, 'orc-speed-guide')
    const { id } = service.importText('auto', { content })
    const document = store.get(id)
    assert.equal(validatePolar(document).valid, true)
    assert.equal(document.kind, 'polarSet')
    assert.equal(document.name, 'Komeet')
    assert.equal(document.sailnumber, 'NED 5436')
    assert.equal(document.boatType, 'stadt 34')
    assert.equal(document.year, 2024)
    const jib = document.sailplans.find(plan => plan.sails?.[0].sourceId === '2024 J1')
    const sym = document.sailplans.find(plan => plan.sails?.[0].sourceId === '2024')
    assert.equal(document.sailplans.length, 2)
    assert.equal(jib.sails[0].area, 33.01)
    assert.equal(sym.sails[0].area, 63.25)
    const tables = { BestPerf: document.best, Jib: jib.table, Sym: sym.table }
    for (const table of Object.values(tables)) {
      assert.deepEqual(table.axes.tws, [6, 8, 10, 12, 14, 16, 20, 24].map(SI.fromKnots))
      assert.deepEqual(table.axes.twa, [52, 60, 70, 75, 80, 90, 110, 120, 135, 150, 165, 180].map(SI.fromDegrees))
      assert.equal(table.derived.rows.length, 8)
      assert.equal(Object.hasOwn(table, 'sailplanIdMatrix'), false)
    }

    // Independent scalar oracle for this local reference export, not an import API.
    const encoded = content.match(/href="data:application\/octet-stream;base64,([^"]+)" download="NED5436\.slk"/)
    assert.ok(encoded)
    const rows = new Map()
    for (const line of Buffer.from(encoded[1], 'base64').toString('utf8').split(/\r?\n/)) {
      const cell = line.match(/^C;Y(\d+);X(\d+);K(.*)$/)
      if (!cell) continue
      const [, y, x, raw] = cell
      if (!rows.has(Number(y))) rows.set(Number(y), {})
      rows.get(Number(y))[Number(x)] = raw.startsWith('"') ? JSON.parse(raw) : Number(raw)
    }
    rows.delete(1)
    assert.equal(rows.size, 336)
    let unavailable = 0
    for (const row of rows.values()) {
      const table = tables[row[1]]
      assert.ok(table)
      const twsIndex = table.axes.tws.indexOf(SI.fromKnots(row[3]))
      assert.ok(twsIndex >= 0)
      const missing = row[6] === 0.01
      if (missing) unavailable++
      const targets = table.derived.rows.find(target => target.tws === SI.fromKnots(row[3]))
      if (row[4] !== 'reach') {
        const target = targets[row[4]]
        if (missing) {
          assert.ok(target === null || target === undefined)
        } else {
          assert.equal(target.twa, SI.fromDegrees(row[5]))
          assert.equal(target.tbs, SI.fromKnots(row[6]))
          assert.equal(target.vmg, SI.fromKnots(Math.abs(row[7])))
          assert.equal(target.heel, SI.fromDegrees(row[10]))
          assert.equal(target.reef, row[11])
          assert.equal(target.flat, row[12])
          assert.equal(Object.hasOwn(target, 'sailplanId'), false)
        }
        continue
      }
      const twaIndex = table.axes.twa.indexOf(SI.fromDegrees(row[5]))
      assert.ok(twaIndex >= 0)
      assert.equal(table.values.boatSpeedMatrix[twsIndex][twaIndex], missing ? null : SI.fromKnots(row[6]))
      assert.equal(table.values.heelMatrix[twsIndex][twaIndex], missing ? null : SI.fromDegrees(row[10]))
      assert.equal(table.values.reefMatrix[twsIndex][twaIndex], missing ? null : row[11])
      assert.equal(table.values.flatMatrix[twsIndex][twaIndex], missing ? null : row[12])
    }
    assert.equal(unavailable, 21)
    assert.equal(sym.table.values.boatSpeedMatrix.flat().filter(value => value === null).length, 13)
    assert.ok(sym.table.derived.rows.every(row => !row.beat && row.run))
    assert.ok(!JSON.stringify(document).match(/"AW[AS]"|"inventoryId"/))

    const exporter = new ExportService()
    const canonical = exporter.exportText('json', document)
    assert.deepEqual(JSON.parse(canonical), document)
    const again = service.importText('auto', { content: canonical })
    assert.deepEqual(store.get(again.id), document)
    store.modify(id, { id, name: 'Edited root' })
    assert.deepEqual(store.get(id), { ...document, name: 'Edited root' })
    assert.throws(() => exporter.exportText('expedition', document, {
      scope: 'table', sailplanId: sym.id, acknowledgeLoss: 'true'
    }), /missing speeds/)
    for (const format of ['expedition', 'jieter', 'json-v1']) {
      assert.ok(exporter.exportText(format, document, { scope: 'table', acknowledgeLoss: 'true' }))
      assert.ok(exporter.exportText(format, document, { scope: 'table', sailplanId: jib.id, acknowledgeLoss: 'true' }))
    }
    if (typeof Polar.fromPolarSet === 'function') {
      for (const sailplanId of [undefined, jib.id, sym.id]) {
        const curves = buildCurves(document, 5, 1, sailplanId)
        assert.equal(curves.curves.length, 8)
        const polar = Polar.fromPolarSet(document, sailplanId)
        const table = sailplanId === undefined ? document.best : document.sailplans.find(plan => plan.id === sailplanId).table
        for (const row of table.derived.rows) {
          const targets = polar.targetsAt({ tws: row.tws }).value
          for (const role of ['beat', 'run']) {
            if (!row[role]) continue
            assert.equal(targets[role].twa, row[role].twa)
            assert.equal(targets[role].speed, row[role].tbs)
            assert.ok(Math.abs(targets[role].vmg - row[role].vmg) < 0.0051, 'runtime VMG retains the math API rounding; stored VMG above is exact')
            for (const key of ['heel', 'reef', 'flat']) assert.equal(targets[role][key], row[role][key])
          }
        }
      }
    } else {
      assert.throws(() => buildCurves(document), error => error.status === 503)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
