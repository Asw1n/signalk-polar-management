'use strict'

const { validateCanonicalPolarResourceBody } = require('./import/canonical')

function selectTable(document, sailplanId) {
  const error = validateCanonicalPolarResourceBody(document)
  if (error) throw new TypeError(error)
  if (sailplanId !== undefined && (typeof sailplanId !== 'string' || !sailplanId)) {
    throw new TypeError("'sailplanId' must be a nonempty string, or omitted for best")
  }
  if (document.kind === 'polarTable') {
    if (sailplanId !== undefined) throw new TypeError('Version 1 has no sailplans')
    return document
  }
  if (sailplanId === undefined) return document.best
  const sailplan = document.sailplans?.find(plan => plan.id === sailplanId)
  if (!sailplan) throw new TypeError(`Unknown sailplan: ${sailplanId}`)
  return sailplan.table
}

function tableChoices(document) {
  if (document.kind !== 'polarSet') return undefined
  return [
    { name: 'Best performance' },
    ...(document.sailplans || []).map(({ id, name }) => ({ id, name }))
  ]
}

module.exports = { selectTable, tableChoices }
