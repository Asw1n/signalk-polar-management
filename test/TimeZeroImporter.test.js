'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const TimeZeroImporter = require('../lib/import/TimeZeroImporter')
const { ImportService, ImportError } = require('../lib/import/ImportService')
const PolarStore = require('../lib/PolarStore')
const SI = require('../lib/SI')

const WIND_POLAR = `<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>
<Polar xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">

	<PolarCurve>
		<PolarCurveIndex value ="10"/>
		<PolarItem>
			<Angle value ="40"/>
			<Value value ="5.5"/>
		</PolarItem>
		<PolarItem>
			<Angle value ="90"/>
			<Value value ="7.4"/>
		</PolarItem>
		<PolarItem>
			<Angle value ="150"/>
			<Value value ="5.7"/>
		</PolarItem>
	</PolarCurve>
	<PolarCurve>
		<PolarCurveIndex value ="3"/>
		<PolarItem>
			<Angle value ="40"/>
			<Value value ="2.2"/>
		</PolarItem>
		<PolarItem>
			<Angle value ="90"/>
			<Value value ="3.3"/>
		</PolarItem>
	</PolarCurve>
</Polar>
`

const WAVE_POLAR = `<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>
<!--Wave Polar collection :                             PolarMultiple-->
<PolarMultiple xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<IndexedPolar>
	<Value value ="0"/>
	<Polar>
		<PolarCurve>
			<PolarCurveIndex value ="1"/>
			<PolarItem>
				<Angle value ="0"/>
				<Value value ="1"/>
			</PolarItem>
		</PolarCurve>
	</Polar>
</IndexedPolar>
</PolarMultiple>
`

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
}

describe('TimeZeroImporter', () => {
  it('converts a Wind_Polar.xml to a canonical table sorted by TWS', () => {
    const { resource } = new TimeZeroImporter().parse(WIND_POLAR)

    assert.equal(resource.kind, 'polarTable')
    assert.equal(resource.schemaVersion, '1.0.0')
    assert.deepEqual(resource.axes.tws.map(tws => Math.round(SI.toKnots(tws) * 1000) / 1000), [3, 10])
    assert.deepEqual(resource.axes.twa.map(twa => Math.round(SI.toDegrees(twa))), [40, 90, 150])
    close(resource.values.boatSpeedMatrix[1][1], SI.fromKnots(7.4))
  })

  it('marks an angle missing from a curve as no data', () => {
    const { resource } = new TimeZeroImporter().parse(WIND_POLAR)

    assert.equal(resource.values.boatSpeedMatrix[0][2], 0)
  })

  it('rejects a Wave_Polar.xml with a hint to use the wind polar', () => {
    assert.throws(() => new TimeZeroImporter().parse(WAVE_POLAR), /Wave_Polar\.xml/)
  })
})

describe('ImportService with TimeZero files', () => {
  it('keeps the generic error for unrecognised content', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-tz-'))
    try {
      const service = new ImportService(new PolarStore(dataDir))
      assert.throws(() => service.importText('auto', { content: 'not a polar' }), {
        status: 400,
        message: /Could not recognise the polar format/
      })
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('continues trying other importers after a detected format rejects the content', () => {
    const acceptedImporter = { parse: () => ({}) }
    const registry = { all: () => [
      { detect: () => true, parse: () => { throw new Error('Rejected by first importer') } },
      acceptedImporter
    ] }

    assert.equal(ImportService.prototype.detectFormat.call({ registry }, 'shared input'), acceptedImporter)
  })

  for (const [label, content] of [
    ['wave polar', WAVE_POLAR],
    ['empty wave polar', '<?xml version="1.0"?><!-- TimeZero --><PolarMultiple/>']
  ]) {
    it(`rejects an automatically detected ${label} with the wind-polar hint`, () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-tz-'))
      try {
        const service = new ImportService(new PolarStore(dataDir))
        const filesBefore = fs.readdirSync(dataDir)
        for (const format of ['auto', undefined]) {
          assert.throws(() => service.importText(format, { content }), (error) => {
            assert.ok(error instanceof ImportError)
            assert.equal(error.status, 400)
            assert.equal(error.message, 'This is a TimeZero Wave_Polar.xml; import the Wind_Polar.xml instead')
            return true
          })
        }
        assert.deepEqual(fs.readdirSync(dataDir), filesBefore)
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true })
      }
    })
  }

  it('detects and stores a TimeZero wind polar', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-tz-'))
    try {
      const service = new ImportService(new PolarStore(dataDir), { now: () => Date.UTC(2026, 9, 29) })
      const { id, resource } = service.importText('auto', { content: WIND_POLAR, name: 'My boat' })

      assert.equal(resource.source, 'timezero')
      assert.equal(resource.name, 'My boat')
      assert.equal(resource.values.boatSpeedMatrix.length, 2)
      assert.ok(fs.existsSync(path.join(dataDir, `${id}.json`)))
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
