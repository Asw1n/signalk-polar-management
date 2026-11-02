'use strict'

const JieterExporter = require('./JieterExporter')
const ExpeditionExporter = require('./ExpeditionExporter')
const { selectTable } = require('../polarDocument')

class ExportError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

class ExportService {
  constructor() {
    this.exporters = new Map(
      [new JieterExporter(), new ExpeditionExporter()].map(exporter => [exporter.id, exporter])
    )
  }

  listFormats() {
    return [
      { id: 'json-v1', name: 'Selected table as canonical v1 (projection)', description: 'Lossy v2 projection: boat-speed grid and basic targets only; no wave, auxiliary or sailplan data.' },
      ...Array.from(this.exporters.values()).map(({ id, name, description }) => ({ id, name, description }))
    ]
  }

  /** Serializes a canonical resource to the given external format's text. Also supports 'json' (canonical passthrough). */
  exportText(formatId, resource, options = {}) {
    let table
    try {
      table = selectTable(resource, options.sailplanId)
    } catch (error) {
      throw new ExportError(400, error.message)
    }
    if (formatId === 'json') {
      if (options.scope !== undefined || options.sailplanId !== undefined) {
        throw new ExportError(400, 'Canonical JSON exports the complete document. Use a single-table format for a selected table.')
      }
      return JSON.stringify(resource, null, 2)
    }
    if (options.scope !== undefined && options.scope !== 'table') {
      throw new ExportError(400, "Single-table exports require scope 'table'")
    }
    if (resource.kind === 'polarSet') {
      if (options.scope !== 'table' || ![true, 'true'].includes(options.acknowledgeLoss)) {
        throw new ExportError(400, 'Exporting v2 as a single table requires scope=table and acknowledgeLoss=true. It omits other tables, sail descriptions, wave correction, auxiliary values and winning references; text formats also round numbers and may lose targets. Canonical JSON preserves the complete document.')
      }
      const derived = table.derived && {
        rows: (table.derived.rows || []).map(row => {
          const result = { tws: row.tws }
          for (const role of ['beat', 'run']) {
            if (Object.hasOwn(row, role)) {
              const target = row[role]
              result[role] = target === null ? null : { twa: target.twa, tbs: target.tbs, vmg: target.vmg }
            }
          }
          for (const field of ['maxSpeed', 'maxSpeedAngle']) {
            if (Object.hasOwn(row, field)) result[field] = row[field]
          }
          return result
        })
      }
      const metadata = {}
      for (const field of ['name', 'boatType', 'sailnumber', 'year', 'source', 'notes']) {
        if (Object.hasOwn(resource, field)) metadata[field] = resource[field]
      }
      resource = {
        ...metadata,
        kind: 'polarTable',
        schemaVersion: '1.0.0',
        units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
        symmetry: resource.symmetry,
        axes: table.axes,
        values: { boatSpeedMatrix: table.values.boatSpeedMatrix },
        ...(derived ? { derived } : {})
      }
    }
    if (resource.values.boatSpeedMatrix.some(row => row.some(speed => !Number.isFinite(speed)))) {
      throw new ExportError(400, 'This single-table format cannot represent missing speeds (null). Export complete canonical JSON instead; no values will be invented.')
    }
    if (formatId === 'json-v1') return JSON.stringify(resource, null, 2)
    const exporter = this.exporters.get(formatId)
    if (!exporter) {
      throw new ExportError(400, `Unsupported export format: ${formatId}`)
    }
    try {
      return exporter.serialize(resource)
    } catch (error) {
      throw new ExportError(400, error.message)
    }
  }
}

module.exports = { ExportService, ExportError }
