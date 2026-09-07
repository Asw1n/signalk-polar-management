'use strict'

const { validatePolarTable } = require('polar-format')

const DEFAULT_SCHEMA_VERSION = '1.0.0'

function createCanonicalResource({ axes, values, derived }) {
  return {
    kind: 'polarTable',
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    units: {
      tws: 'm/s',
      twa: 'rad',
      boatSpeed: 'm/s'
    },
    symmetry: {
      portStarboardSymmetric: true
    },
    axes,
    values,
    ...(derived ? { derived } : {})
  }
}

function applyMetadata(resource, metadata = {}, fallbackName = '') {
  const merged = { ...resource }
  const name = typeof metadata.name === 'string' && metadata.name.trim()
    ? metadata.name.trim()
    : (resource.name || fallbackName)

  if (name) merged.name = name
  if (typeof metadata.sailnumber === 'string' && metadata.sailnumber.trim()) merged.sailnumber = metadata.sailnumber.trim()
  if (typeof metadata.boatType === 'string' && metadata.boatType.trim()) merged.boatType = metadata.boatType.trim()
  if (Number.isInteger(metadata.year)) merged.year = metadata.year
  if (typeof metadata.source === 'string' && metadata.source.trim()) merged.source = metadata.source.trim()
  if (typeof metadata.notes === 'string' && metadata.notes.trim()) merged.notes = metadata.notes.trim()

  return merged
}

/** Validates a canonical polar resource body using polar-format; returns an error string or null. */
function validateCanonicalPolarResourceBody(resource) {
  if (!resource || typeof resource !== 'object') return 'Expected a JSON object'
  const result = validatePolarTable(resource)
  if (result.valid) return null
  return result.errors.map(e => `${e.path}: ${e.message}`).join('; ')
}

module.exports = {
  DEFAULT_SCHEMA_VERSION,
  createCanonicalResource,
  applyMetadata,
  validateCanonicalPolarResourceBody
}
