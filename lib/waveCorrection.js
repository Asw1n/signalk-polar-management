'use strict'

const SI = require('./SI')

function attributeValue(element, name) {
  const match = element.match(new RegExp(`<${name}\\s+value\\s*=\\s*"([^"]*)"`))
  const text = match ? match[1].trim() : ''
  return text ? Number(text) : Number.NaN
}

function rootElementName(content) {
  const withoutProlog = content
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const match = withoutProlog.match(/<([A-Za-z_][\w.-]*)/)
  return match ? match[1] : null
}

/**
 * TimeZero Wave_Polar.xml: one IndexedPolar per significant wave height, each
 * holding PolarCurves per wave period with Angle (degrees, waves from the bow)
 * and Value (dimensionless speed factor) items. Curves within one height layer
 * must share an identical angle grid: factors cannot be null, and this parser
 * never fills missing cells. Zero-height neutrality, exact ordering and range
 * rules are enforced by validatePolar on the updated document.
 */
function parseTimeZeroWaveXml(content) {
  const root = rootElementName(content)
  if (root === 'Polar') {
    throw new Error('This is a TimeZero Wind_Polar.xml; import it as a new polar on the Import page instead')
  }
  if (root !== 'PolarMultiple') {
    throw new Error('Expected a TimeZero Wave_Polar.xml with a <PolarMultiple> root element')
  }

  const blocks = content.match(/<IndexedPolar>[\s\S]*?<\/IndexedPolar>/g) || []
  if (blocks.length === 0) {
    throw new Error('No wave height layers were found')
  }

  const heights = blocks.map((block) => {
    const polarStart = block.indexOf('<Polar>')
    const height = attributeValue(polarStart === -1 ? block : block.slice(0, polarStart), 'Value')
    if (!Number.isFinite(height) || height < 0) {
      throw new Error('Invalid wave height value in a TimeZero height layer')
    }

    const curves = block.match(/<PolarCurve>[\s\S]*?<\/PolarCurve>/g) || []
    if (curves.length === 0) {
      throw new Error(`No wave period curves were found in the ${height} m layer`)
    }

    const rows = curves.map((curve) => {
      const period = attributeValue(curve, 'PolarCurveIndex')
      if (!Number.isFinite(period) || period <= 0) {
        throw new Error(`Invalid wave period in the ${height} m layer`)
      }
      const items = curve.match(/<PolarItem>[\s\S]*?<\/PolarItem>/g) || []
      if (items.length === 0) {
        throw new Error(`The ${period} s curve in the ${height} m layer has no points`)
      }
      const points = items.map((item) => {
        const angleDeg = attributeValue(item, 'Angle')
        const factor = attributeValue(item, 'Value')
        if (!Number.isFinite(angleDeg) || angleDeg < 0 || angleDeg > 180) {
          throw new Error(`Invalid wave angle in the ${period} s curve of the ${height} m layer`)
        }
        if (!Number.isFinite(factor) || factor < 0) {
          throw new Error(`Invalid speed factor in the ${period} s curve of the ${height} m layer`)
        }
        return { angleDeg, factor }
      })
      for (let i = 1; i < points.length; i++) {
        if (points[i - 1].angleDeg >= points[i].angleDeg) {
          throw new Error(`Wave angles must be strictly increasing in the ${period} s curve of the ${height} m layer`)
        }
      }
      return { period, points }
    })

    rows.sort((left, right) => left.period - right.period)
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].period >= rows[i].period) {
        throw new Error(`Duplicate wave period ${rows[i].period} s in the ${height} m layer`)
      }
    }

    const angleGrid = rows[0].points.map(point => point.angleDeg).join(',')
    for (const row of rows) {
      if (row.points.map(point => point.angleDeg).join(',') !== angleGrid) {
        throw new Error(`All curves in the ${height} m layer must share the same angle grid; missing factors are not filled`)
      }
    }

    return {
      significantWaveHeight: height,
      axes: {
        wavePeriod: rows.map(row => row.period),
        waveAngle: rows[0].points.map(point => SI.fromDegrees(point.angleDeg))
      },
      values: {
        speedFactorMatrix: rows.map(row => row.points.map(point => point.factor))
      }
    }
  })

  heights.sort((left, right) => left.significantWaveHeight - right.significantWaveHeight)
  for (let i = 1; i < heights.length; i++) {
    if (heights[i - 1].significantWaveHeight >= heights[i].significantWaveHeight) {
      throw new Error(`Duplicate wave height ${heights[i].significantWaveHeight} m`)
    }
  }

  return { heights }
}

/**
 * Parses pasted/uploaded wave-correction content, auto-detecting a canonical
 * JSON fragment ({ "waveCorrection": { "heights": [...] } } or the bare
 * { "heights": [...] } object) or a TimeZero Wave_Polar.xml.
 */
function parseWaveCorrection(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error("'content' is required")
  }
  // Tolerate mis-decoded UTF-16 input (TimeZero writes UTF-16 despite its XML
  // declaration): NUL padding and leading BOM/replacement characters are
  // stripped before detection.
  const text = content
    .replace(/\u0000/g, '')
    .replace(/^[\uFEFF\uFFFD]+/, '')
    .trim()
  if (!text) {
    throw new Error("'content' is required")
  }
  if (text.startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`Invalid wave-correction JSON: ${error.message}`)
    }
    const fragment = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed.waveCorrection !== undefined ? parsed.waveCorrection : (Array.isArray(parsed.heights) ? parsed : undefined))
      : undefined
    if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment) || !Array.isArray(fragment.heights)) {
      throw new Error('Expected a canonical wave-correction fragment: { "waveCorrection": { "heights": [...] } }')
    }
    return fragment
  }
  if (/^</.test(text)) {
    return parseTimeZeroWaveXml(text)
  }
  throw new Error('Could not recognise the wave-correction format — supported are canonical JSON fragments and TimeZero Wave_Polar.xml')
}

module.exports = { parseWaveCorrection, parseTimeZeroWaveXml }
