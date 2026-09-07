'use strict'

const JieterExporter = require('./JieterExporter')
const ExpeditionExporter = require('./ExpeditionExporter')

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
    return Array.from(this.exporters.values()).map(({ id, name, description }) => ({ id, name, description }))
  }

  /** Serializes a canonical resource to the given external format's text. Also supports 'json' (canonical passthrough). */
  exportText(formatId, resource) {
    if (formatId === 'json') {
      return JSON.stringify(resource, null, 2)
    }
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
