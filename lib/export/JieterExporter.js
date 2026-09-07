'use strict'

const SI = require('../SI')

/**
 * Serializes a canonical polarTable resource to Jieter/ORC semicolon-delimited matrix text:
 * header row 'twa;<tws1>;<tws2>;...' (knots) followed by one row per TWA (degrees),
 * plus optional beat/run target rows (single non-zero cell at that TWS column).
 */
class JieterExporter {
  constructor() {
    this.id = 'jieter'
    this.name = 'Jieter'
    this.description = 'Semicolon-delimited Jieter/ORC table with TWS header and TWA rows.'
  }

  serialize(resource) {
    const twsAxis = resource.axes.tws
    const twaAxis = resource.axes.twa
    const matrix = resource.values.boatSpeedMatrix
    const derivedByTws = new Map((resource.derived?.rows || []).map(row => [row.tws, row]))

    const lines = []
    lines.push(['twa', ...twsAxis.map(tws => SI.toKnots(tws).toFixed(2))].join(';'))

    twaAxis.forEach((twa, twaIndex) => {
      const cells = twsAxis.map((_, twsIndex) => SI.toKnots(matrix[twsIndex][twaIndex]).toFixed(2))
      lines.push([SI.toDegrees(twa).toFixed(1), ...cells].join(';'))
    })

    const beatRow = twsAxis.map((tws) => {
      const row = derivedByTws.get(tws)
      return row?.beat ? SI.toKnots(row.beat.tbs).toFixed(2) : '0'
    })
    if (beatRow.some(value => value !== '0')) {
      lines.push(['beat', ...beatRow].join(';'))
    }

    const runRow = twsAxis.map((tws) => {
      const row = derivedByTws.get(tws)
      return row?.run ? SI.toKnots(row.run.tbs).toFixed(2) : '0'
    })
    if (runRow.some(value => value !== '0')) {
      lines.push(['run', ...runRow].join(';'))
    }

    return lines.join('\n') + '\n'
  }
}

module.exports = JieterExporter
