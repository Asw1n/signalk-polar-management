'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const SI = require('../lib/SI')
const { validatePolar } = require('polar-format')
const OrcSpeedGuideImporter = require('../lib/import/OrcSpeedGuideImporter')
const { ImportService, ImportError } = require('../lib/import/ImportService')
const PolarStore = require('../lib/PolarStore')

const TWS_KNOTS = [6, 8, 10, 12, 14, 16, 20, 24]
const REACH_ANGLES = [52, 60, 70, 75, 80, 90, 110, 120, 135, 150, 165, 180]
const DEFAULT_DATASET_SPECS = [
  { tws: TWS_KNOTS, angles: REACH_ANGLES },
  { tws: TWS_KNOTS, angles: REACH_ANGLES },
  { tws: TWS_KNOTS, angles: REACH_ANGLES }
]
const DATASETS = [
  { key: 'BestPerf', title: 'Best Performance' },
  { key: 'Jib', title: 'Headsail' },
  { key: 'Sym', title: 'Symmetric spinnaker' }
]

function pointFor(datasetIndex, twsKnots, windIndex, condition, twaDeg, reachIndex = 0) {
  let btvKnots
  if (condition === 'beat') {
    btvKnots = datasetIndex === 2 ? 0.01 : 4 + datasetIndex + windIndex * 0.1
  } else if (condition === 'run') {
    btvKnots = 3 + datasetIndex + windIndex * 0.1
  } else {
    btvKnots = 2 + datasetIndex + windIndex * 0.2 + reachIndex * 0.05
  }

  if (datasetIndex === 0 && twsKnots === 6 && condition === 'reach' && twaDeg === 52) btvKnots = 0.009
  if (datasetIndex === 0 && twsKnots === 6 && condition === 'reach' && twaDeg === 70) btvKnots = 0
  if (datasetIndex === 2 && condition === 'reach' &&
    (twaDeg === 52 || (windIndex >= 6 && twaDeg === 60) ||
      (twsKnots === 24 && [70, 75, 80].includes(twaDeg)))) {
    btvKnots = 0.01
  }

  let vmgKnots = condition === 'beat' && datasetIndex === 2
    ? 0.01
    : btvKnots * Math.abs(Math.cos(twaDeg * Math.PI / 180))
  if (condition === 'run' && datasetIndex === 1) vmgKnots *= -1

  return {
    sail: DATASETS[datasetIndex].key,
    id: datasetIndex === 0 ? '' : datasetIndex === 1 ? '2024 J1' : '2024',
    twsKnots,
    condition,
    role: condition === 'beat' ? 'optup' : condition === 'run' ? 'optdn' : 'no',
    twaDeg,
    btvKnots,
    vmgKnots,
    awsKnots: 9 + windIndex,
    awaDeg: 35 + windIndex,
    heelDeg: 8 + windIndex * 0.3 + reachIndex * 0.1,
    reef: 1.1 + datasetIndex * 0.05,
    flat: 1.02 + windIndex * 0.01
  }
}

function makeRows(datasetSpecs = DEFAULT_DATASET_SPECS) {
  return DATASETS.map((dataset, datasetIndex) => ({
    ...dataset,
    tables: datasetSpecs[datasetIndex].tws.map((tws, windIndex) => {
      const angles = datasetSpecs[datasetIndex].angles
      const points = [
        pointFor(datasetIndex, tws, windIndex, 'beat', datasetIndex === 2 ? 48 + windIndex * 0.1 : 42 + windIndex * 0.1),
        ...angles.map((angle, reachIndex) => (
          pointFor(datasetIndex, tws, windIndex, 'reach', angle, reachIndex)
        )),
        pointFor(datasetIndex, tws, windIndex, 'run', 160 + windIndex * 0.2)
      ]
      return { twsKnots: tws, points }
    })
  }))
}

function formatVisible(number, digits) {
  return Number(number).toFixed(digits)
}

function sylkCell(row, column, value) {
  const serialized = typeof value === 'string'
    ? `"${value.replace(/"/g, '""')}"`
    : String(value)
  return `C;Y${row};X${column};K${serialized}`
}

function makeSylk(rows) {
  const lines = ['ID;PWXL;N;E']
  SYLK_HEADERS.forEach((header, index) => lines.push(sylkCell(1, index + 1, header)))
  let rowNumber = 2
  for (const dataset of rows) {
    for (const table of dataset.tables) {
      for (const point of table.points) {
        const values = [
          point.sail,
          point.id,
          point.twsKnots,
          point.condition,
          point.twaDeg,
          point.btvKnots.toFixed(4),
          point.vmgKnots.toFixed(4),
          point.awsKnots,
          point.awaDeg,
          point.heelDeg.toFixed(4),
          point.reef.toFixed(4),
          point.flat.toFixed(4)
        ]
        values.forEach((value, index) => lines.push(sylkCell(rowNumber, index + 1, value)))
        rowNumber++
      }
    }
  }
  lines.push('E')
  return lines.join('\r\n')
}

const SYLK_HEADERS = ['Sail', 'Id', 'TWS', 'Condition', 'TWA', 'BTV', 'VMG', 'AWS', 'AWA', 'Heel', 'Reef', 'Flat']

function makeGuide({ embedded = true, conflict = false, datasetSpecs = DEFAULT_DATASET_SPECS } = {}) {
  const rows = makeRows(datasetSpecs)
  const sections = rows.map((dataset, datasetIndex) => {
    const tables = dataset.tables.map((table, windIndex) => {
      const tableRows = table.points
        .map(point => ({ ...point }))
        .sort((left, right) => left.twaDeg - right.twaDeg)
        .map((point, pointIndex) => {
          let btv = formatVisible(point.btvKnots, 2)
          if (conflict && datasetIndex === 0 && windIndex === 0 && pointIndex === 0) btv = '9.99'
          return `<tr vmg="${point.role}"><td>${formatVisible(point.twaDeg, 1)}°</td><td>${btv}</td>` +
            `<td>${formatVisible(Math.abs(point.vmgKnots), 2)}</td><td>${formatVisible(point.awsKnots, 2)}</td>` +
            `<td>${formatVisible(point.awaDeg, 1)}°</td><td>${formatVisible(point.heelDeg, 1)}°</td>` +
            `<td>${formatVisible(point.reef, 2)}</td><td>${formatVisible(point.flat, 2)}</td></tr>`
        }).join('')
      return `<table class="polartable"><caption>TWS = ${table.twsKnots}kts</caption>` +
        `<tr>${SYLK_HEADERS.slice(4).map(header => `<th>${header}</th>`).join('')}</tr>${tableRows}</table>`
    }).join('')
    if (datasetIndex === 0) {
      return `<div class="polarcontainer-title"><div>Komeet<br>NED 5436<br>stadt 34<br>` +
        `<span>Best Performance</span></div></div>${tables}`
    }
    const sail = datasetIndex === 1
      ? 'Headsail, 33.01 m² (id = 2024 J1)'
      : 'Symmetric, 63.25 m² (id = 2024)'
    return `<div class="polarcontainer-title"><div>Komeet<br>NED 5436<br>stadt 34<br>${sail}</div></div>${tables}`
  }).join('')

  const fileLink = embedded
    ? `<a download="guide.slk" href="data:application/octet-stream;base64,${Buffer.from(makeSylk(rows)).toString('base64')}">SYLK</a>`
    : ''
  return `<html><body>
    <div>Headsail, 33.01 m² (id = 2024 J1)</div>
    <div>Symmetric, 63.25 m² (id = 2024)</div>
    <footer>© Offshore Racing Congress 2024</footer>
    ${sections}${fileLink}</body></html>`
}

function mutateEmbeddedSylk(guide, mutate) {
  const uri = guide.match(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/)
  assert.ok(uri, 'synthetic guide has an embedded SYLK URI')
  const text = Buffer.from(uri[1], 'base64').toString('utf8')
  const edited = mutate(text)
  return guide.replace(uri[0], `data:application/octet-stream;base64,${Buffer.from(edited).toString('base64')}`)
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} != ${expected}`)
}

describe('OrcSpeedGuideImporter', () => {
  it('detects ORC speed-guide HTML but not a standalone SYLK file', () => {
    const importer = new OrcSpeedGuideImporter()
    assert.equal(importer.id, 'orc-speed-guide')
    assert.equal(importer.defaultSource, 'orc-speed-guide')
    assert.equal(importer.detect(makeGuide()), true)
    assert.equal(importer.detect('ID;PWXL;N;E\nC;Y1;X1;K"Sail"\nE'), false)
  })

  it('imports all three datasets from precise embedded SYLK into canonical SI v2 tables', () => {
    const importer = new OrcSpeedGuideImporter()
    const { resource } = importer.parse(makeGuide())

    assert.equal(resource.kind, 'polarSet')
    assert.equal(resource.schemaVersion, '2.0.0')
    const validation = validatePolar(resource)
    assert.equal(validation.valid, true, JSON.stringify(validation.errors))
    assert.equal(resource.source, 'orc-speed-guide')
    assert.equal(resource.name, 'Komeet')
    assert.equal(resource.sailnumber, 'NED 5436')
    assert.equal(resource.boatType, 'stadt 34')
    assert.equal(resource.year, 2024)
    assert.deepEqual(resource.units, {
      tws: 'm/s', twa: 'rad', boatSpeed: 'm/s', heel: 'rad', reef: '1', flat: '1'
    })

    const firstWind = SI.fromKnots(6)
    close(resource.best.axes.tws[0], firstWind)
    assert.deepEqual(resource.best.axes.twa, REACH_ANGLES.map(SI.fromDegrees))
    close(resource.best.values.boatSpeedMatrix[0][0], SI.fromKnots(0.009))
    assert.equal(resource.best.values.boatSpeedMatrix[0][2], 0)
    close(resource.best.values.heelMatrix[0][2], SI.fromDegrees(8.2))
    assert.equal(resource.best.values.reefMatrix[0][2], 1.1)
    assert.ok(resource.best.values.flatMatrix[0][2] > 1)
    close(resource.best.values.boatSpeedMatrix[0][1], SI.fromKnots(2.05))
    assert.ok(resource.sailplans[1].table.values.boatSpeedMatrix[0][1] > resource.best.values.boatSpeedMatrix[0][1])

    const jib = resource.sailplans[0]
    assert.equal(jib.id, 'headsail-2024-j1')
    assert.equal(jib.name, 'Headsail')
    assert.deepEqual(jib.sails, [{ name: 'Headsail', sourceId: '2024 J1', area: 33.01 }])
    assert.ok(jib.table.values.boatSpeedMatrix[0][1] > 0)
    assert.ok(jib.table.values.heelMatrix[0][1] > 0)

    const symmetric = resource.sailplans[1]
    assert.equal(symmetric.id, 'symmetric-spinnaker-2024')
    assert.equal(symmetric.name, 'Symmetric spinnaker')
    assert.deepEqual(symmetric.sails, [{ name: 'Symmetric spinnaker', sourceId: '2024', area: 63.25 }])
    assert.equal(symmetric.table.derived.rows.length, 8)
    assert.equal(symmetric.table.values.boatSpeedMatrix.flat().filter(value => value === null).length, 13)
    assert.equal(symmetric.table.values.heelMatrix.flat().filter(value => value === null).length, 13)
    assert.equal(symmetric.table.values.reefMatrix.flat().filter(value => value === null).length, 13)
    assert.equal(symmetric.table.values.flatMatrix.flat().filter(value => value === null).length, 13)
    for (const row of symmetric.table.derived.rows) {
      assert.equal(Object.hasOwn(row, 'beat'), false)
      assert.ok(row.run)
    }

    const bestTargets = resource.best.derived.rows[0]
    close(bestTargets.beat.twa, SI.fromDegrees(42))
    close(bestTargets.beat.tbs, SI.fromKnots(4))
    close(bestTargets.beat.vmg, SI.fromKnots(4 * Math.abs(Math.cos(42 * Math.PI / 180))))
    close(bestTargets.beat.heel, SI.fromDegrees(8))
    assert.equal(bestTargets.beat.reef, 1.1)
    assert.equal(bestTargets.beat.flat, 1.02)
    close(bestTargets.run.twa, SI.fromDegrees(160))
    assert.ok(bestTargets.run.vmg >= 0)
    close(bestTargets.run.heel, SI.fromDegrees(8))
    assert.equal(bestTargets.run.reef, 1.1)
    assert.equal(bestTargets.run.flat, 1.02)
    assert.ok(jib.table.derived.rows[0].run.vmg > 0)
    assert.equal(Object.hasOwn(resource.best.values, 'awsMatrix'), false)
    assert.equal(Object.hasOwn(resource.best.values, 'awaMatrix'), false)
    assert.match(resource.notes, /exact.*0\.01 knots.*unavailable/i)
  })

  it('uses the visible tables when the HTML contains no embedded SYLK download', () => {
    const { resource } = new OrcSpeedGuideImporter().parse(makeGuide({ embedded: false }))
    assert.equal(resource.best.axes.tws.length, 8)
    assert.equal(resource.best.axes.twa.length, 12)
    assert.equal(resource.best.values.boatSpeedMatrix[0][0], null)
    assert.equal(resource.best.values.boatSpeedMatrix[0][2], 0)
    assert.equal(resource.sailplans[1].table.derived.rows.length, 8)
    assert.equal(resource.sailplans[1].table.derived.rows[0].beat, undefined)
  })

  it('rejects malformed HTML and corrupt embedded SYLK without falling back', () => {
    const malformedHtml = makeGuide().replace('</table>', '')
    assert.equal(new OrcSpeedGuideImporter().detect(malformedHtml), true)
    assert.throws(() => new OrcSpeedGuideImporter().parse(malformedHtml), /table/i)

    const corruptSylk = makeGuide().replace(
      /data:application\/octet-stream;base64,[A-Za-z0-9+/=]+/,
      `data:application/octet-stream;base64,${Buffer.from('not a scalar SYLK file').toString('base64')}`
    )
    assert.throws(() => new OrcSpeedGuideImporter().parse(corruptSylk), /SYLK|\.slk/i)
  })

  it('rejects disagreement between the embedded scalar table and visible HTML values', () => {
    assert.throws(
      () => new OrcSpeedGuideImporter().parse(makeGuide({ conflict: true })),
      /conflicts with visible/i
    )
  })

  it('ignores script and SVG contents for detection and import', () => {
    const importer = new OrcSpeedGuideImporter()
    const fakeGuide = `<html><script>const guide = '${makeGuide().replace(/'/g, "\\'")}'</script>` +
      `<svg><text>Best Performance TWS = 6kts TWA BTV VMG</text></svg></html>`
    assert.equal(importer.detect(fakeGuide), false)
    assert.throws(() => importer.parse(fakeGuide), /Expected an ORC speed-guide HTML document/)

    delete globalThis.orcGuideScriptRan
    const guide = makeGuide().replace(
      '<body>',
      '<body><script>globalThis.orcGuideScriptRan = true</script>' +
        '<svg><text>Best Performance TWS = 99kts</text></svg>'
    )
    const { resource } = importer.parse(guide)
    assert.equal(globalThis.orcGuideScriptRan, undefined)
    assert.equal(resource.best.axes.tws.length, 8)
  })

  it('rejects duplicate scalar cells, unsupported SYLK records and unknown datasets', () => {
    const guide = makeGuide()
    for (const [label, mutate, message] of [
      ['duplicate scalar cell', text => text.replace('C;Y1;X1;K"Sail"\r\n', 'C;Y1;X1;K"Sail"\r\nC;Y1;X1;K"Sail"\r\n'), /duplicate scalar cells/i],
      ['unsupported record', text => text.replace('\r\nE', '\r\nF;Y1;X1;K1\r\nE'), /unsupported non-scalar records/i],
      ['unknown dataset', text => text.replace('C;Y2;X1;K"BestPerf"', 'C;Y2;X1;K"Unknown"'), /unrecognized sail table/i],
      ['conflicting sail identifier', text => text.replace('C;Y114;X2;K"2024 J1"', 'C;Y114;X2;K"Other"'), /conflicting sail identifiers/i],
      ['conflicting TWS grid', text => text.replace('C;Y2;X3;K6', 'C;Y2;X3;K8'), /reaches and one beat\/run target/i]
    ]) {
      assert.throws(() => new OrcSpeedGuideImporter().parse(mutateEmbeddedSylk(guide, mutate)), message, label)
    }
  })

  it('rejects conflicting sail metadata and duplicate visible datasets', () => {
    const conflictingMetadata = `${makeGuide()}<div>Headsail, 40.00 m² (id = 2024 J1)</div>`
    assert.throws(() => new OrcSpeedGuideImporter().parse(conflictingMetadata), /conflicting or missing Headsail/i)

    const conflictingRoot = `${makeGuide()}<div class="polarcontainer-title">Other Boat<br>NED 9999<br>Other type<br>Best Performance</div>`
    assert.throws(() => new OrcSpeedGuideImporter().parse(conflictingRoot), /conflicting root boat metadata/i)

    const conflictingYear = `${makeGuide()}<footer>© Offshore Racing Congress 2025</footer>`
    assert.throws(() => new OrcSpeedGuideImporter().parse(conflictingYear), /conflicting year metadata/i)

    const visibleOnly = makeGuide({ embedded: false })
    const firstTable = visibleOnly.match(/<table\b[\s\S]*?<\/table>/i)[0]
    assert.throws(
      () => new OrcSpeedGuideImporter().parse(visibleOnly.replace('</body>', `${firstTable}</body>`)),
      /duplicate visible TWS tables/i
    )
  })

  it('derives independent dataset TWS and TWA grids from variable-size source and visible records', () => {
    const datasetSpecs = [
      { tws: [5, 9, 15], angles: [52, 70, 100, 150] },
      { tws: [6, 12], angles: [55, 90, 125] },
      { tws: [7, 11, 17, 23], angles: [58, 75, 95, 130, 165] }
    ]

    for (const embedded of [true, false]) {
      const { resource } = new OrcSpeedGuideImporter().parse(makeGuide({ embedded, datasetSpecs }))
      assert.equal(validatePolar(resource).valid, true)
      const [best, headsail, symmetric] = [resource.best, ...resource.sailplans.map(plan => plan.table)]
      const degrees = table => table.axes.twa.map(value => Number(SI.toDegrees(value).toFixed(8)))
      const knots = table => table.axes.tws.map(value => Number(SI.toKnots(value).toFixed(8)))
      assert.deepEqual(knots(best), datasetSpecs[0].tws)
      assert.deepEqual(degrees(best), datasetSpecs[0].angles)
      assert.deepEqual(knots(headsail), datasetSpecs[1].tws)
      assert.deepEqual(degrees(headsail), datasetSpecs[1].angles)
      assert.deepEqual(knots(symmetric), datasetSpecs[2].tws)
      assert.deepEqual(degrees(symmetric), datasetSpecs[2].angles)
      assert.deepEqual(
        [best, headsail, symmetric].map(table => [
          table.values.boatSpeedMatrix.length,
          table.values.boatSpeedMatrix[0].length
        ]),
        [[3, 4], [2, 3], [4, 5]]
      )
      assert.deepEqual(
        [best, headsail, symmetric].map(table => [
          table.derived.rows.length,
          table.derived.rows.filter(row => row.beat).length,
          table.derived.rows.filter(row => row.run).length
        ]),
        [[3, 3, 3], [2, 2, 2], [4, 0, 4]]
      )
    }
  })

  it('enforces HTML and embedded-SYLK size bounds', () => {
    const importer = new OrcSpeedGuideImporter()
    const guide = makeGuide()
    const oversizedSylk = guide.replace(
      /data:application\/octet-stream;base64,[A-Za-z0-9+/=]+/,
      `data:application/octet-stream;base64,${'A'.repeat(1024 * 1024 + 4)}`
    )
    assert.equal(importer.detect(oversizedSylk), true)
    assert.throws(() => importer.parse(oversizedSylk), /exceeds the size limit/i)

    const oversizedHtml = `${guide}${' '.repeat(8 * 1024 * 1024)}`
    assert.equal(importer.detect(oversizedHtml), false)
    assert.throws(() => importer.parse(oversizedHtml), /exceeds the size limit/i)

    const oversizedUtf8 = `${guide}${'€'.repeat(3 * 1024 * 1024)}`
    assert.ok(oversizedUtf8.length < 8 * 1024 * 1024)
    assert.equal(importer.detect(oversizedUtf8), false)
    assert.throws(() => importer.parse(oversizedUtf8), /exceeds the size limit/i)
  })

  it('auto-imports guide HTML, preserves detected conflicts, and rejects standalone SYLK', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-orc-guide-'))
    try {
      const store = new PolarStore(dataDir)
      const service = new ImportService(store, { now: () => Date.UTC(2026, 9, 30) })
      const formatIds = service.listFormats().map(format => format.id)
      assert.ok(formatIds.indexOf('canonical') < formatIds.indexOf('orc-speed-guide'))
      assert.ok(formatIds.indexOf('orc-speed-guide') < formatIds.indexOf('jieter'))

      const { id, resource } = service.importText('auto', { content: makeGuide() })
      assert.equal(resource.kind, 'polarSet')
      assert.equal(resource.schemaVersion, '2.0.0')
      assert.equal(resource.source, 'orc-speed-guide')
      assert.equal(store.get(id).name, 'Komeet')
      assert.deepEqual(store.list(), [id])

      const corruptGuide = mutateEmbeddedSylk(makeGuide(), () => 'not a scalar SYLK file')
      assert.throws(() => service.importText('auto', { content: corruptGuide }), (error) => {
        assert.ok(error instanceof ImportError)
        assert.equal(error.status, 400)
        assert.match(error.message, /invalid scalar SYLK structure/i)
        return true
      })
      assert.deepEqual(store.list(), [id])

      assert.throws(() => service.importText('auto', {
        content: 'ID;PWXL;N;E\nC;Y1;X1;K"Sail"\nE'
      }), (error) => {
        assert.ok(error instanceof ImportError)
        assert.equal(error.status, 400)
        assert.match(error.message, /Could not recognise the polar format/i)
        return true
      })
      assert.deepEqual(store.list(), [id])
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
