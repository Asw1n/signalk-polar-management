'use strict'

const FormatRegistry = require('./FormatRegistry')
const SourceRegistry = require('./SourceRegistry')
const OrcSource = require('./OrcSource')
const CanonicalImporter = require('./CanonicalImporter')
const JieterImporter = require('./JieterImporter')
const ExpeditionImporter = require('./ExpeditionImporter')
const { applyMetadata, validateCanonicalPolarResourceBody } = require('./canonical')

class ImportError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function autoId(value, fallback = 'imported-polar') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || fallback
}

function timestampIdPart(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(now)
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    't',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    'z'
  ].join('')
}

function createTimestampedId(baseValue, fallback, exists, now) {
  const baseId = autoId(baseValue, fallback)
  const timestampedBaseId = `${baseId}-${timestampIdPart(now())}`
  let id = timestampedBaseId
  let suffix = 2
  while (exists(id)) {
    id = `${timestampedBaseId}-${suffix}`
    suffix += 1
  }
  return id
}

class ImportService {
  constructor(store, options = {}) {
    this.store = store
    this.now = options.now || (() => Date.now())
    // Order matters: auto-detection trial-parses in registration order.
    this.registry = new FormatRegistry([
      new CanonicalImporter(),
      new JieterImporter(),
      new ExpeditionImporter()
    ])
    this.sourceRegistry = new SourceRegistry([
      new OrcSource({
        dataDir: store.dataDir,
        fetcher: options.fetcher,
        now: this.now
      })
    ])
  }

  listFormats() {
    return this.registry.list()
  }

  listSources() {
    return this.sourceRegistry.list().map(descriptor => ({ ...descriptor }))
  }

  /** Returns the first importer whose parser accepts the content, or null. */
  detectFormat(content) {
    for (const importer of this.registry.all()) {
      if (typeof importer.detect === 'function' && !importer.detect(content)) continue
      try {
        importer.parse(content)
        return importer
      } catch {
        // Not this format — keep looking.
      }
    }
    return null
  }

  importText(formatId, body) {
    if (!body || typeof body !== 'object') {
      throw new ImportError(400, 'Expected a JSON object')
    }

    if (typeof body.content !== 'string' || !body.content.trim()) {
      throw new ImportError(400, "'content' is required")
    }

    const auto = !formatId || formatId === 'auto'
    const importer = auto ? this.detectFormat(body.content) : this.registry.get(formatId)
    if (!importer) {
      throw new ImportError(400, auto
        ? 'Could not recognise the polar format — supported formats are canonical JSON, Jieter and Expedition'
        : `Unsupported import format: ${formatId}`)
    }

    let parsed
    try {
      parsed = importer.parse(body.content)
    } catch (error) {
      throw new ImportError(400, error.message)
    }

    const resource = applyMetadata(
      parsed.resource,
      { ...body, source: body.source || parsed.resource.source || importer.defaultSource },
      body.name || importer.name
    )

    const validationError = validateCanonicalPolarResourceBody(resource)
    if (validationError) {
      throw new ImportError(400, validationError)
    }

    const id = createTimestampedId(
      resource.sailnumber || resource.name || importer.id,
      `${importer.id}-polar`,
      (candidate) => this.store.exists(candidate),
      this.now
    )

    this.store.saveCanonical(id, resource)
    return { id, resource: { ...resource, id } }
  }

  async searchSource(sourceId, query) {
    const source = this.sourceRegistry.get(sourceId)
    if (!source) {
      throw new ImportError(404, `Unsupported import source: ${sourceId}`)
    }

    try {
      return await source.search(query)
    } catch (error) {
      if (Number.isInteger(error.status)) {
        throw new ImportError(error.status, error.message)
      }
      throw error
    }
  }

  async importSource(sourceId, externalId, body) {
    const source = this.sourceRegistry.get(sourceId)
    if (!source) {
      throw new ImportError(404, `Unsupported import source: ${sourceId}`)
    }

    if (body != null && typeof body !== 'object') {
      throw new ImportError(400, 'Expected a JSON object')
    }

    if (body && Object.keys(body).length > 0) {
      throw new ImportError(400, 'External source imports do not accept metadata overrides')
    }

    let parsed
    try {
      parsed = await source.importByExternalId(externalId)
    } catch (error) {
      if (Number.isInteger(error.status)) {
        throw new ImportError(error.status, error.message)
      }
      throw error
    }

    const resource = applyMetadata(
      parsed.resource,
      { source: parsed.resource.source || source.defaultSource },
      parsed.fallbackName || source.name
    )

    const validationError = validateCanonicalPolarResourceBody(resource)
    if (validationError) {
      throw new ImportError(400, validationError)
    }

    const id = (() => {
      const baseId = autoId(externalId || resource.name || resource.sailnumber, `${sourceId}-polar`)
      let candidate = baseId
      let suffix = 2
      while (this.store.exists(candidate)) {
        candidate = `${baseId}-${suffix}`
        suffix += 1
      }
      return candidate
    })()

    this.store.saveCanonical(id, resource)
    return { id, resource: { ...resource, id } }
  }
}

module.exports = { ImportService, ImportError, autoId, timestampIdPart, createTimestampedId }
