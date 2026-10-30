'use strict'

const fs = require('fs')
const path = require('path')
const { validateCanonicalPolarResourceBody } = require('./import/canonical')
const { tableChoices } = require('./polarDocument')

// Excludes path separators, Windows-reserved filename characters and control
// characters — these are what caused id/file aliasing (via path.basename) and
// unvalidated OS errors, not the free-form names users already picked via rename/copy.
const RESOURCE_ID_PATTERN = /^[^\\/:*?"<>|\x00-\x1f]{1,100}$/

/**
 * PolarStore — file-backed storage for canonical polar resources, keyed by resource id.
 * Backs the 'polars' Resource Provider (listResources/getResource/setResource/deleteResource).
 */
class PolarStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.onChange = null
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
  }

  /** Throws if id is not a valid polar resource id. Single choke point for all storage operations. */
  _jsonPath(id) {
    if (typeof id !== 'string' || !RESOURCE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid polar id: '${id}'`)
    }
    return path.join(this.dataDir, `${id}.json`)
  }

  exists(id) {
    try {
      return fs.existsSync(this._jsonPath(id))
    } catch (_) {
      // A malformed id (e.g. a legacy/hand-edited config value) simply doesn't exist.
      return false
    }
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

  _serialize(resource) {
    const validationError = validateCanonicalPolarResourceBody(resource)
    if (validationError) {
      throw new Error(validationError)
    }
    // The storage key is the only authoritative id; never persist a caller-supplied copy.
    const { id: _ignored, ...body } = resource
    return JSON.stringify(body, null, 2)
  }

  /** Validates and writes a canonical polar resource. Throws on validation failure. */
  save(id, resource) {
    fs.writeFileSync(this._jsonPath(id), this._serialize(resource), 'utf8')
    this.onChange?.({ type: 'saved', ids: [id] })
    return id
  }

  /** Changes only editable boat metadata, optionally moving to a new storage id. */
  modify(id, metadata) {
    const fields = ['name', 'boatType', 'sailnumber', 'year']
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('Expected a metadata object')
    }
    if (Object.keys(metadata).some(key => key !== 'id' && !fields.includes(key))) {
      throw new Error('Only id, name, boatType, sailnumber and year can be modified')
    }
    if (typeof metadata.id !== 'string' || !metadata.id.trim()) {
      throw new Error("'id' is required")
    }
    const newId = metadata.id.trim()
    const src = this._jsonPath(id)
    const dst = this._jsonPath(newId)
    const resource = this.get(id)
    for (const field of fields) {
      if (!Object.hasOwn(metadata, field)) continue
      const value = metadata[field]
      if (field === 'year') {
        if (value !== null && !Number.isSafeInteger(value)) {
          throw new Error('Year must be an integer or null')
        }
        if (value === null) delete resource.year
        else resource.year = value
      } else {
        if (typeof value !== 'string') throw new Error(`${field} must be a string`)
        if (value.trim()) resource[field] = value.trim()
        else delete resource[field]
      }
    }
    const serialized = this._serialize(resource)
    if (newId === id) {
      fs.writeFileSync(src, serialized, 'utf8')
    } else {
      if (fs.existsSync(dst)) throw new Error(`A polar named '${newId}' already exists`)
      fs.writeFileSync(dst, serialized, { encoding: 'utf8', flag: 'wx' })
      try {
        fs.unlinkSync(src)
      } catch (error) {
        fs.unlinkSync(dst)
        throw error
      }
    }
    this.onChange?.({ type: 'modified', ids: [...new Set([id, newId])] })
    return newId
  }

  /** Alias used by import services, which already validate before calling. */
  saveCanonical(id, resource) {
    return this.save(id, resource)
  }

  delete(id) {
    const jp = this._jsonPath(id)
    if (!fs.existsSync(jp)) throw new Error(`Polar not found: ${id}`)
    fs.unlinkSync(jp)
    this.onChange?.({ type: 'deleted', ids: [id] })
  }

  rename(id, newId) {
    const src = this._jsonPath(id)
    const dst = this._jsonPath(newId)
    if (!fs.existsSync(src)) throw new Error(`Polar not found: ${id}`)
    if (fs.existsSync(dst)) throw new Error(`A polar named '${newId}' already exists`)
    fs.renameSync(src, dst)
    this.onChange?.({ type: 'renamed', ids: [id, newId] })
  }

  /** Duplicates a stored polar under a new id, keeping the original. */
  copy(id, newId) {
    const src = this._jsonPath(id)
    const dst = this._jsonPath(newId)
    if (!fs.existsSync(src)) throw new Error(`Polar not found: ${id}`)
    if (fs.existsSync(dst)) throw new Error(`A polar named '${newId}' already exists`)
    fs.copyFileSync(src, dst)
    this.onChange?.({ type: 'copied', ids: [newId] })
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
          ...(stored.kind === 'polarSet' ? {
            kind: stored.kind,
            schemaVersion: stored.schemaVersion,
            tables: tableChoices(stored)
          } : {}),
          hasDerived: !!((stored.kind === 'polarSet' ? stored.best : stored).derived?.rows?.length)
        }
      } catch (error) {
        return { id, error: error.message }
      }
    })
  }
}

module.exports = PolarStore
