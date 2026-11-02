'use strict'

const { Polar } = require('polar-math')
const { selectTable } = require('./polarDocument')

function preparePolar(document, sailplanId) {
  const table = selectTable(document, sailplanId)
  if (document.kind === 'polarSet' && typeof Polar.fromPolarSet !== 'function') {
    const error = new Error('Version 2 calculations require a released polar-math with Polar.fromPolarSet support; storage, table display and export remain available')
    error.status = 503
    error.code = 'unsupported_math'
    throw error
  }
  const polar = document.kind === 'polarSet'
    ? Polar.fromPolarSet(document, sailplanId)
    : Polar.fromTable(document)
  return { table, polar }
}

module.exports = { preparePolar }
