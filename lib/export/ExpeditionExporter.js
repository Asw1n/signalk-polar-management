'use strict'

const SI = require('../SI')

/**
 * Serializes a canonical polarTable resource to Expedition polar text:
 * one tab-delimited row per TWS with repeated TWA/BSP pairs (degrees/knots),
 * optionally prefixed with beat/run target pairs before the common-grid pairs.
 */
class ExpeditionExporter {
  constructor() {
    this.id = 'expedition'
    this.name = 'Expedition'
    this.description = 'Expedition polar text with one TWS row per line, repeated TWA/BSP pairs.'
  }

  serialize(resource) {
    const twsAxis = resource.axes.tws
    const twaAxis = resource.axes.twa
    const matrix = resource.values.boatSpeedMatrix
    const derivedByTws = new Map((resource.derived?.rows || []).map(row => [row.tws, row]))

    const lines = []
    if (resource.sailnumber) lines.push(`!${resource.sailnumber}`)

    twsAxis.forEach((tws, twsIndex) => {
      const cells = [SI.toKnots(tws).toFixed(2)]
      const derived = derivedByTws.get(tws)

      if (derived?.beat) {
        cells.push(SI.toDegrees(derived.beat.twa).toFixed(1), SI.toKnots(derived.beat.tbs).toFixed(2))
      }

      twaAxis.forEach((twa, twaIndex) => {
        cells.push(SI.toDegrees(twa).toFixed(1), SI.toKnots(matrix[twsIndex][twaIndex]).toFixed(2))
      })

      if (derived?.run) {
        cells.push(SI.toDegrees(derived.run.twa).toFixed(1), SI.toKnots(derived.run.tbs).toFixed(2))
      }

      lines.push(cells.join('\t'))
    })

    return lines.join('\n') + '\n'
  }
}

module.exports = ExpeditionExporter
