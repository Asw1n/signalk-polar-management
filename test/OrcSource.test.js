'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const OrcSource = require('../lib/import/OrcSource')

const KNOT_TO_MPS = 0.514444
const PARITY_TOLERANCE_MPS = 0.01 * KNOT_TO_MPS

const entry = {
  refNo: '03510004IFP',
  yachtName: 'BUENAVENTURA',
  sailNo: 'ESP-45601',
  boatClass: 'X-99',
  vppYear: 2026
}

function rmsPayload() {
  return {
    rms: [{
      Allowances: {
        WindSpeeds: [6, 10],
        WindAngles: [52, 110],
        R52: [657.9, 538.1],
        R110: [631.9, 498.1],
        Beat: [994.9, 762.6],
        Run: [1018.2, 675.4],
        BeatAngle: [43, 38.5],
        GybeAngle: [142.1, 151.2]
      }
    }]
  }
}

function createSource(fetcher = async () => ({ ok: true, status: 200, text: async () => '' })) {
  return new OrcSource({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orc-source-test-')),
    fetcher
  })
}

describe('OrcSource RMS import', () => {
  it('maps RMS allowances to the canonical matrix and derived targets within certificate display precision', () => {
    const resource = createSource().parseRmsJson(JSON.stringify(rmsPayload()), entry)

    assert.deepEqual(resource.axes.tws, [6 * KNOT_TO_MPS, 10 * KNOT_TO_MPS])
    assert.deepEqual(resource.axes.twa, [52, 110].map(value => value * Math.PI / 180))
    assert.ok(Math.abs(resource.values.boatSpeedMatrix[0][0] - (3600 / 657.9) * KNOT_TO_MPS) <= PARITY_TOLERANCE_MPS)
    assert.ok(Math.abs(resource.derived.rows[0].beat.vmg - (3600 / 994.9) * KNOT_TO_MPS) <= PARITY_TOLERANCE_MPS)
    assert.ok(Math.abs(resource.derived.rows[1].run.vmg - (3600 / 675.4) * KNOT_TO_MPS) <= PARITY_TOLERANCE_MPS)
    assert.equal(resource.year, 2026)
    assert.equal(resource.source, 'orc')
  })

  it('uses the RMS endpoint addressed by RefNo instead of the certificate page', async () => {
    const urls = []
    const source = createSource(async (url) => {
      urls.push(url)
      if (url.includes('activecerts')) {
        return { ok: true, status: 200, text: async () => '<ROOT><ROW><RefNo>03510004IFP</RefNo><dxtID>248030</dxtID><VPPYear>2026</VPPYear><YachtName>BUENAVENTURA</YachtName></ROW></ROOT>' }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(rmsPayload()) }
    })

    await source.importByExternalId(entry.refNo)

    assert.ok(urls.some(url => url === 'https://data.orc.org/public/WPub.dll?action=DownBoatRMS&RefNo=03510004IFP&ext=json'))
    assert.ok(urls.every(url => !url.includes('/CC/')))
  })

  it('rejects malformed or incomplete RMS JSON', () => {
    assert.throws(() => createSource().parseRmsJson('{', entry), {
      message: /not valid JSON/
    })
    assert.throws(() => createSource().parseRmsJson(JSON.stringify({ rms: [{}] }), entry), {
      message: /did not contain allowances/
    })
  })

  for (const [label, value] of [['missing', undefined], ['zero', 0], ['negative', -1], ['non-finite', Infinity]]) {
    it(`rejects ${label} RMS allowances`, () => {
      for (const field of ['R52', 'Beat', 'Run']) {
        const payload = rmsPayload()
        payload.rms[0].Allowances[field][0] = value
        assert.throws(() => createSource().parseRmsJson(JSON.stringify(payload), entry), {
          message: /invalid numeric data/
        })
      }
    })
  }
})