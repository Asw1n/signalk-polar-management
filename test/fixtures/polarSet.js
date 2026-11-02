'use strict'

function polarSet() {
  const table = {
    axes: { tws: [4, 6], twa: [Math.PI / 3, Math.PI / 2, Math.PI] },
    values: {
      boatSpeedMatrix: [[2, null, 3], [3, 4, 3.5]],
      heelMatrix: [[0.1, null, 0.02], [0.2, 0.1, 0.03]],
      reefMatrix: [[1.0006, null, 1], [1, 0.9, 0.8]],
      flatMatrix: [[1, null, 0.9], [1, 0.8, 0.7]]
    },
    derived: {
      rows: [
        { tws: 4, beat: { twa: 0.7, tbs: 2.2, vmg: 1.7, heel: 0.12, reef: 1.0006, flat: 1 }, run: { twa: 2.6, tbs: 3.2, vmg: 2.7, heel: 0.03 } },
        { tws: 6, beat: { twa: 0.72, tbs: 3.2, vmg: 2.4 }, run: { twa: 2.7, tbs: 3.8, vmg: 3.4 }, maxSpeed: 4.1, maxSpeedAngle: 1.8 }
      ]
    }
  }
  const best = structuredClone(table)
  best.sailplanIdMatrix = [['jib', null, null], ['jib', 'jib', null]]
  best.derived.rows[0].beat.sailplanId = 'jib'
  return {
    kind: 'polarSet',
    schemaVersion: '2.0.0',
    name: 'Root boat',
    boatType: 'Test',
    sailnumber: 'NL 1',
    year: 2024,
    source: 'Test source',
    notes: 'Root notes',
    units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s', heel: 'rad', reef: '1', flat: '1' },
    symmetry: { portStarboardSymmetric: true },
    best,
    sailplans: [{
      id: 'jib',
      name: 'Headsail',
      notes: 'Table description',
      sails: [{ name: 'Headsail', sourceId: '2024 J1', area: 33.01 }],
      table
    }],
    waveCorrection: {
      heights: [{
        significantWaveHeight: 1,
        axes: { wavePeriod: [5], waveAngle: [0, Math.PI] },
        values: { speedFactorMatrix: [[0.8, 1.02]] }
      }]
    }
  }
}

module.exports = { polarSet }
