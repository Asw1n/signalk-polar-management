'use strict'

const { describe, it, mock } = require('node:test')
const assert = require('node:assert/strict')
const { buildCurves } = require('../lib/CurveService')
const { Polar } = require('polar-math')

const KNOTS = 1 / 1.94384
const radians = degrees => degrees * Math.PI / 180

// Dufour/Jieter-style table: a normal row plus a high-wind row that only has
// drawable positive speeds on the downwind (run) side.
const SPARSE_TABLE = {
  kind: 'polarTable', schemaVersion: '1.0.0', name: 'Sparse High-Wind Polar',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: {
    tws: [10 * KNOTS, 30 * KNOTS],
    twa: [40, 60, 80, 100, 120, 150, 180].map(radians)
  },
  values: {
    boatSpeedMatrix: [
      [4, 5, 5.5, 5, 4.5, 4, 3].map(knots => knots * KNOTS),
      [0, 0, 0, 6, 7, 6.5, 5].map(knots => knots * KNOTS)
    ]
  }
}

describe('CurveService.buildCurves', () => {
  it('returns drawable curves for a normal row alongside a downwind-only high-wind row', () => {
    const { curves } = buildCurves(SPARSE_TABLE)
    assert.equal(curves.length, 2)

    const [normal, sparse] = curves
    assert.ok(normal.points.length > 1)
    assert.ok(normal.beat)
    assert.ok(normal.run)

    assert.ok(sparse.points.length > 1)
    const target = Polar.fromTable(SPARSE_TABLE).targetsAt({ tws: SPARSE_TABLE.axes.tws[1] }).value?.beat
    // Released math treats these legacy zeros as missing; v2 math keeps numeric zero.
    assert.deepEqual(sparse.beat, target ? { twa: target.twa, tbs: target.speed } : null)
    assert.ok(sparse.run)
  })

  it('does not throw when math returns no target markers', () => {
    const table = {
      ...SPARSE_TABLE,
      values: { boatSpeedMatrix: [SPARSE_TABLE.values.boatSpeedMatrix[1], SPARSE_TABLE.values.boatSpeedMatrix[1]] }
    }
    const prepare = Polar.fromTable.bind(Polar)
    const stub = mock.method(Polar, 'fromTable', input => {
      const polar = prepare(input)
      return {
        rangeAt: query => polar.rangeAt(query),
        speedAt: query => polar.speedAt(query),
        targetsAt: () => ({ value: { beat: null, run: null } })
      }
    })
    try {
      const { curves } = buildCurves(table)
      assert.equal(curves.length, 2)
      for (const curve of curves) {
        assert.equal(curve.beat, null)
        assert.equal(curve.run, null)
      }
    } finally {
      stub.mock.restore()
    }
  })
})
