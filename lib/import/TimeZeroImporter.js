'use strict'

const SI = require('../SI')
const { createCanonicalResource } = require('./canonical')

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
 * TimeZero (TZ Professional / TZ Navigator) Wind_Polar.xml: one PolarCurve per
 * TWS in knots, each a list of PolarItems with TWA in degrees and boat speed in
 * knots. Curves may list different angles; an angle a curve lacks becomes 0,
 * which the canonical format treats as no data.
 */
class TimeZeroImporter {
  constructor() {
    this.id = 'timezero'
    this.name = 'TimeZero'
    this.description = 'TimeZero Wind_Polar.xml with one PolarCurve per TWS and TWA/boat-speed PolarItems.'
    this.defaultSource = 'timezero'
  }

  detect(content) {
    return /<PolarCurve\b/.test(content)
  }

  parse(content) {
    const root = rootElementName(content.replace(/^﻿/, ''))
    if (root === 'PolarMultiple') {
      throw new Error('This is a TimeZero Wave_Polar.xml; import the Wind_Polar.xml instead')
    }
    if (root !== 'Polar') {
      throw new Error('Expected a TimeZero Wind_Polar.xml with a <Polar> root element')
    }

    const curves = (content.match(/<PolarCurve>[\s\S]*?<\/PolarCurve>/g) || []).map((curve) => {
      const twsKnots = attributeValue(curve, 'PolarCurveIndex')
      if (!Number.isFinite(twsKnots) || twsKnots <= 0) {
        throw new Error('Invalid TimeZero PolarCurveIndex (TWS) value')
      }

      const speedByAngle = new Map()
      for (const item of curve.match(/<PolarItem>[\s\S]*?<\/PolarItem>/g) || []) {
        const angleDeg = attributeValue(item, 'Angle')
        const speedKnots = attributeValue(item, 'Value')
        if (!Number.isFinite(angleDeg) || angleDeg < 0 || angleDeg > 180) {
          throw new Error(`Invalid TimeZero angle in the TWS ${twsKnots} curve`)
        }
        if (!Number.isFinite(speedKnots) || speedKnots < 0) {
          throw new Error(`Invalid TimeZero boat speed in the TWS ${twsKnots} curve`)
        }
        speedByAngle.set(angleDeg, SI.fromKnots(speedKnots))
      }

      return { twsKnots, speedByAngle }
    })

    if (curves.length === 0) {
      throw new Error('No TimeZero polar curves were found')
    }

    curves.sort((left, right) => left.twsKnots - right.twsKnots)
    const anglesDeg = Array.from(new Set(curves.flatMap(curve => Array.from(curve.speedByAngle.keys()))))
      .sort((left, right) => left - right)
    if (anglesDeg.length === 0) {
      throw new Error('The TimeZero polar curves have no points')
    }

    return {
      resource: createCanonicalResource({
        axes: {
          tws: curves.map(curve => SI.fromKnots(curve.twsKnots)),
          twa: anglesDeg.map(angleDeg => SI.fromDegrees(angleDeg))
        },
        values: {
          boatSpeedMatrix: curves.map(curve => anglesDeg.map(angleDeg => curve.speedByAngle.get(angleDeg) || 0))
        }
      })
    }
  }
}

module.exports = TimeZeroImporter
