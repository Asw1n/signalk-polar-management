'use strict'

const fs = require('fs')
const path = require('path')
const { validateCanonicalPolarResourceBody } = require('./import/canonical')

/**
 * PolarStore — file-backed storage for canonical polar resources, keyed by resource id.
 * Backs the 'polars' Resource Provider (listResources/getResource/setResource/deleteResource).
 */
class PolarStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
  }

  _jsonPath(id) {
    const safe = path.basename(id)
    return path.join(this.dataDir, `${safe}.json`)
  }

  exists(id) {
    return fs.existsSync(this._jsonPath(id))
  }

  /** Bare ids of all stored polars, sorted alphabetically. */
  list() {
    return fs.readdirSync(this.dataDir)
      .filter(fileName => fileName.endsWith('.json'))
      .map(fileName => fileName.slice(0, -5))
      .sort()
  }

  /** Reads and parses a stored canonical polar resource (no 'id' field). */
  get(id) {
    const jp = this._jsonPath(id)
    if (!fs.existsSync(jp)) throw new Error(`Polar not found: ${id}`)
    return JSON.parse(fs.readFileSync(jp, 'utf8'))
  }

  /** Validates and writes a canonical polar resource. Throws on validation failure. */
  save(id, resource) {
    const validationError = validateCanonicalPolarResourceBody(resource)
    if (validationError) {
      throw new Error(validationError)
    }
    fs.writeFileSync(this._jsonPath(id), JSON.stringify(resource, null, 2), 'utf8')
    return id
  }

  /** Alias used by import services, which already validate before calling. */
  saveCanonical(id, resource) {
    return this.save(id, resource)
  }

  delete(id) {
    const jp = this._jsonPath(id)
    if (!fs.existsSync(jp)) throw new Error(`Polar not found: ${id}`)
    fs.unlinkSync(jp)
  }

  rename(id, newId) {
    const src = this._jsonPath(id)
    const dst = this._jsonPath(newId)
    if (!fs.existsSync(src)) throw new Error(`Polar not found: ${id}`)
    if (fs.existsSync(dst)) throw new Error(`A polar named '${newId}' already exists`)
    fs.renameSync(src, dst)
  }

  /** Duplicates a stored polar under a new id, keeping the original. */
  copy(id, newId) {
    const src = this._jsonPath(id)
    const dst = this._jsonPath(newId)
    if (!fs.existsSync(src)) throw new Error(`Polar not found: ${id}`)
    if (fs.existsSync(dst)) throw new Error(`A polar named '${newId}' already exists`)
    fs.copyFileSync(src, dst)
  }

  /** List all polars with a light metadata summary (no axes/matrix), for UI listing. */
  listWithMeta() {
    return this.list().map(id => {
      try {
        const stored = this.get(id)
        return {
          id,
          ...(stored.name ? { name: stored.name } : {}),
          ...(stored.boatType ? { boatType: stored.boatType } : {}),
          ...(stored.sailnumber ? { sailnumber: stored.sailnumber } : {}),
          ...(Number.isInteger(stored.year) ? { year: stored.year } : {}),
          ...(stored.source ? { source: stored.source } : {}),
          ...(stored.notes ? { notes: stored.notes } : {}),
          hasDerived: !!(stored.derived && Array.isArray(stored.derived.rows) && stored.derived.rows.length)
        }
      } catch (_) {
        return { id }
      }
    })
  }
}

module.exports = PolarStore
