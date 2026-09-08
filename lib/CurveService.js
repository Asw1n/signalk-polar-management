'use strict'

const { Polar } = require('polar-math')

const DEFAULT_STEP_DEG = 5
const EPSILON = 1e-9

// Sample one TWS curve over the polar's valid TWA range at a fixed angular step.
// The exact range endpoints are always included so the line reaches the pinch
// and run-extrapolation limits. performanceFactor is passed straight through to
// polar-math, which applies it consistently to speed, beat, run and max-speed.
function sampleCurve(polar, tws, stepRad, performanceFactor) {
  const range = polar.rangeAt({ tws }).value
  if (!range) return null

  const { minTwa, maxTwa } = range
  const angles = [minTwa]
  const firstStep = Math.ceil(minTwa / stepRad) * stepRad
  for (let twa = firstStep; twa < maxTwa - EPSILON; twa += stepRad) {
    if (twa > minTwa + EPSILON) angles.push(twa)
  }
  if (maxTwa > minTwa + EPSILON) angles.push(maxTwa)

  const points = []
  for (const twa of angles) {
    const speed = polar.speedAt({ tws, twa, performanceFactor }).value
    if (Number.isFinite(speed) && speed > 0) points.push({ twa, tbs: speed })
  }
  if (points.length === 0) return null

  const targets = polar.targetsAt({ tws, performanceFactor }).value
  return {
    tws,
    points,
    beat: targets ? { twa: targets.beat.twa, tbs: targets.beat.speed } : null,
    run: targets ? { twa: targets.run.twa, tbs: targets.run.speed } : null
  }
}

/**
 * Build render-ready curves for every TWS in the table, sampled at a fixed
 * angular step using polar-math (including pinch and run extrapolation).
 * @param {Object} table canonical polar table resource
 * @param {number} [stepDeg] angular sampling step in degrees
 * @param {number} [performanceFactor] multiplier applied to all speeds (beat/run/max included)
 * @returns {{stepDeg: number, curves: Array}} curves in SI units (m/s, rad)
 */
function buildCurves(table, stepDeg = DEFAULT_STEP_DEG, performanceFactor = 1) {
  if (!Number.isFinite(stepDeg) || stepDeg <= 0) {
    throw new RangeError("'step' must be a positive number of degrees")
  }
  const polar = Polar.fromTable(table)
  const stepRad = stepDeg * Math.PI / 180
  const curves = table.axes.tws
    .map(tws => sampleCurve(polar, tws, stepRad, performanceFactor))
    .filter(Boolean)
  return { stepDeg, curves }
}

module.exports = { buildCurves, DEFAULT_STEP_DEG }
