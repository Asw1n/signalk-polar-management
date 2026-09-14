'use strict'

class CanonicalImporter {
  constructor() {
    this.id = 'canonical'
    this.name = 'Canonical polar JSON'
    this.description = 'Canonical polarTable JSON document, as produced by this plugin\'s JSON export.'
    this.defaultSource = 'canonical'
  }

  /** Cheap pre-check used by format auto-detection. */
  detect(content) {
    return typeof content === 'string' && content.trim().startsWith('{')
  }

  parse(content) {
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`)
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a canonical polar JSON object')
    }
    if (parsed.kind !== 'polarTable') {
      throw new Error("Expected a canonical polar document with kind 'polarTable'")
    }

    // The stored id is assigned on save; never trust the one in the document.
    const { id, ...resource } = parsed
    return { resource }
  }
}

module.exports = CanonicalImporter
