'use strict'

const fs = require('fs')
const path = require('path')

const ACTIVE_CERTIFICATES_URL = 'https://data.orc.org/public/WPub.dll?action=activecerts'
const RMS_URL_PREFIX = 'https://data.orc.org/public/WPub.dll?action=DownBoatRMS&RefNo='
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const CACHE_REFRESH_TIMEOUT_MS = 90000
const RMS_FETCH_TIMEOUT_MS = 10000
const MAX_SEARCH_RESULTS = 100
const KNOT_TO_MPS = 0.514444
const DEG_TO_RAD = Math.PI / 180

function sourceError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
}

function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

function parseXmlRows(xmlText) {
  const rows = []
  const rowMatches = xmlText.matchAll(/<ROW\b[^>]*>([\s\S]*?)<\/ROW>/g)
  for (const rowMatch of rowMatches) {
    const body = rowMatch[1]
    const row = {}
    for (const fieldMatch of body.matchAll(/<([A-Za-z0-9_:-]+)>([\s\S]*?)<\/\1>/g)) {
      row[fieldMatch[1]] = decodeEntities(fieldMatch[2]).trim()
    }
    rows.push(row)
  }
  return rows
}

function createDerivedRows(twsValues, twaValues, speedMatrix, beatAngles, beatVmgs, runAngles, runVmgs) {
  return {
    rows: twsValues.map((tws, index) => {
      const speedRow = speedMatrix[index]
      const maxSpeed = Math.max(...speedRow)
      const maxSpeedAngle = twaValues[speedRow.indexOf(maxSpeed)]
      const beatAngle = beatAngles[index]
      const beatVmg = beatVmgs[index]
      const runAngle = runAngles[index]
      const runVmg = runVmgs[index]

      const beat = Number.isFinite(beatAngle) && Number.isFinite(beatVmg)
        ? {
            twa: beatAngle,
            tbs: beatVmg / Math.abs(Math.cos(beatAngle)),
            vmg: beatVmg
          }
        : null

      const run = Number.isFinite(runAngle) && Number.isFinite(runVmg)
        ? {
            twa: runAngle,
            tbs: runVmg / Math.abs(Math.cos(runAngle)),
            vmg: runVmg
          }
        : null

      return {
        tws,
        ...(beat ? { beat } : {}),
        ...(run ? { run } : {}),
        maxSpeed,
        maxSpeedAngle
      }
    })
  }
}

function allowanceToMps(value) {
  if (!Number.isFinite(value) || value <= 0) return null
  const speed = (3600 / value) * KNOT_TO_MPS
  return Number.isFinite(speed) && speed > 0 ? speed : null
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(sourceError(503, message)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

class OrcSource {
  constructor({
    dataDir,
    fetcher,
    now = () => Date.now(),
    cacheTtlMs = DEFAULT_CACHE_TTL_MS
  } = {}) {
    this.fetcher = typeof fetcher === 'function'
      ? fetcher
      : (...args) => {
          if (typeof globalThis.fetch !== 'function') {
            throw new Error('A fetch implementation is required for ORC source imports')
          }
          return globalThis.fetch(...args)
        }

    if (typeof this.fetcher !== 'function') {
      throw new Error('A fetch implementation is required for ORC source imports')
    }

    this.id = 'orc'
    this.name = 'ORC Active Certificates'
    this.defaultSource = 'orc'
    this.now = now
    this.cacheTtlMs = cacheTtlMs
    this.cacheDir = path.join(dataDir, 'import-cache')
    this.activeCachePath = path.join(this.cacheDir, 'orc-activecerts.json')
    ensureDir(this.cacheDir)
  }

  descriptor() {
    return {
      id: this.id,
      name: this.name,
      description: 'Official ORC active certificates and RMS performance data',
      url: ACTIVE_CERTIFICATES_URL,
      cached: this.isCacheFresh()
    }
  }

  /** True when a not-yet-expired active-certificates cache exists on disk. */
  isCacheFresh() {
    const cached = this.readCache()
    return !!cached && (this.now() - cached.fetchedAtMs) < this.cacheTtlMs
  }

  async search(query = '') {
    const entries = await this.getActiveCertificates()
    const needle = normalize(query)
    const matches = needle
      ? entries.filter(entry => this.matchesQuery(entry, needle))
      : entries

    return matches.slice(0, MAX_SEARCH_RESULTS).map(entry => ({
      externalId: entry.refNo,
      name: entry.yachtName || entry.refNo,
      sailnumber: entry.sailNo || undefined,
      boatType: entry.boatClass || undefined,
      year: entry.vppYear,
      source: this.id,
      dxtId: entry.dxtId,
      countryId: entry.countryId,
      certificateName: entry.certName || undefined,
      familyName: entry.familyName || undefined
    }))
  }

  async importByExternalId(externalId) {
    const refNo = String(externalId || '').trim()
    if (!refNo) {
      throw sourceError(400, 'External ORC id is required')
    }

    const entries = await this.getActiveCertificates()
    const entry = entries.find(candidate => candidate.refNo === refNo)
    if (!entry) {
      throw sourceError(404, `ORC certificate not found: ${refNo}`)
    }

    const rmsJson = await this.fetchText(`${RMS_URL_PREFIX}${encodeURIComponent(refNo)}&ext=json`, `ORC RMS data ${refNo}`, RMS_FETCH_TIMEOUT_MS)
    return {
      resource: this.parseRmsJson(rmsJson, entry),
      fallbackName: entry.yachtName || refNo
    }
  }

  matchesQuery(entry, needle) {
    return [
      entry.refNo,
      entry.yachtName,
      entry.sailNo,
      entry.boatClass,
      entry.countryId,
      entry.certName,
      entry.familyName,
      entry.vppYear
    ].some(value => normalize(value).includes(needle))
  }

  async getActiveCertificates() {
    const cached = this.readCache()
    const isFresh = cached && (this.now() - cached.fetchedAtMs) < this.cacheTtlMs
    if (isFresh) {
      return cached.entries
    }

    try {
      return await this.refreshActiveCertificates()
    } catch (error) {
      if (cached?.entries?.length) {
        return cached.entries
      }
      throw error
    }
  }

  readCache() {
    try {
      if (!fs.existsSync(this.activeCachePath)) return null
      const payload = JSON.parse(fs.readFileSync(this.activeCachePath, 'utf8'))
      if (!Array.isArray(payload.entries) || !Number.isFinite(payload.fetchedAtMs)) return null
      return payload
    } catch (_error) {
      return null
    }
  }

  writeCache(entries) {
    fs.writeFileSync(this.activeCachePath, JSON.stringify({
      fetchedAtMs: this.now(),
      entries
    }, null, 2), 'utf8')
  }

  async refreshActiveCertificates() {
    const xmlText = await this.fetchText(ACTIVE_CERTIFICATES_URL, 'ORC active certificates index', CACHE_REFRESH_TIMEOUT_MS)
    const entries = this.parseActiveCertificates(xmlText)
    this.writeCache(entries)
    return entries
  }

  async fetchText(url, label, timeoutMs) {
    let response
    try {
      response = await withTimeout(this.fetcher(url), timeoutMs, `Timed out fetching ${label}`)
    } catch (error) {
      // withTimeout already produces a well-formed sourceError; only re-wrap fetcher-thrown errors.
      if (Number.isInteger(error.status)) throw error
      throw sourceError(503, `External source unavailable while fetching ${label}: ${error.message}`)
    }

    if (!response || typeof response.text !== 'function') {
      throw sourceError(502, `Invalid response from ${label}`)
    }

    if (!response.ok) {
      const status = response.status === 404 ? 404 : 502
      throw sourceError(status, `Failed to fetch ${label}: HTTP ${response.status}`)
    }

    return response.text()
  }

  parseActiveCertificates(xmlText) {
    const rows = parseXmlRows(xmlText)
    if (!rows.length) {
      throw sourceError(502, 'ORC active certificates response did not contain any rows')
    }

    return rows
      .filter(row => row.RefNo && row.dxtID)
      .map(row => ({
        refNo: row.RefNo.trim(),
        dxtId: row.dxtID.trim(),
        countryId: row.CountryId?.trim() || '',
        yachtName: row.YachtName?.trim() || '',
        sailNo: row.SailNo?.trim() || '',
        vppYear: Number.parseInt(row.VPPYear, 10) || undefined,
        boatClass: row.Class?.trim() || '',
        certName: row.CertName?.trim() || '',
        familyName: row.FamilyName?.trim() || '',
        issuedAt: row.dxtDate?.trim() || '',
        expiry: row.Expiry?.trim() || ''
      }))
  }

  parseRmsJson(jsonText, entry) {
    let payload
    try {
      payload = JSON.parse(jsonText)
    } catch (_error) {
      throw sourceError(502, `ORC RMS response was not valid JSON for ${entry.refNo}`)
    }

    const allowances = payload?.rms?.[0]?.Allowances
    if (!allowances || typeof allowances !== 'object' || Array.isArray(allowances)) {
      throw sourceError(502, `ORC RMS response did not contain allowances for ${entry.refNo}`)
    }

    const windSpeeds = allowances.WindSpeeds
    const windAngles = allowances.WindAngles
    const allowanceRows = windAngles?.map(angle => allowances[`R${angle}`])
    const targetRows = [allowances.Beat, allowances.Run, allowances.BeatAngle, allowances.GybeAngle]
    if (!Array.isArray(windSpeeds) || !Array.isArray(windAngles) ||
      !allowanceRows?.every(Array.isArray) || !targetRows.every(Array.isArray)) {
      throw sourceError(502, `ORC RMS allowances were incomplete for ${entry.refNo}`)
    }

    const twsValues = windSpeeds.map(value => value * KNOT_TO_MPS)
    const twaValues = windAngles.map(value => value * DEG_TO_RAD)
    const boatSpeedMatrix = windSpeeds.map((_windSpeed, windIndex) =>
      allowanceRows.map(row => allowanceToMps(row[windIndex])))
    const beatVmgs = allowances.Beat.map(allowanceToMps)
    const runVmgs = allowances.Run.map(allowanceToMps)
    const beatAngles = allowances.BeatAngle.map(value => value * DEG_TO_RAD)
    const runAngles = allowances.GybeAngle.map(value => value * DEG_TO_RAD)

    if (
      twsValues.some(value => !Number.isFinite(value) || value <= 0) ||
      twaValues.some(value => !Number.isFinite(value) || value < 0 || value > Math.PI) ||
      allowanceRows.some(row => row.length !== windSpeeds.length) ||
      targetRows.some(row => row.length !== windSpeeds.length) ||
      boatSpeedMatrix.some(row => row.some(value => !Number.isFinite(value) || value <= 0)) ||
      beatVmgs.some(value => !Number.isFinite(value) || value <= 0) ||
      runVmgs.some(value => !Number.isFinite(value) || value <= 0) ||
      beatAngles.some(value => !Number.isFinite(value) || value < 0 || value > Math.PI) ||
      runAngles.some(value => !Number.isFinite(value) || value < 0 || value > Math.PI)
    ) {
      throw sourceError(502, `ORC RMS allowances contained invalid numeric data for ${entry.refNo}`)
    }

    return {
      kind: 'polarTable',
      schemaVersion: '1.0.0',
      name: entry.yachtName || entry.refNo,
      ...(entry.sailNo ? { sailnumber: entry.sailNo.replace(/\s+/g, '') } : {}),
      ...(entry.boatClass ? { boatType: entry.boatClass } : {}),
      ...(Number.isInteger(entry.vppYear) ? { year: entry.vppYear } : {}),
      source: this.defaultSource,
      units: {
        tws: 'm/s',
        twa: 'rad',
        boatSpeed: 'm/s'
      },
      symmetry: {
        portStarboardSymmetric: true
      },
      axes: {
        tws: twsValues,
        twa: twaValues
      },
      values: {
        boatSpeedMatrix
      },
      derived: createDerivedRows(twsValues, twaValues, boatSpeedMatrix, beatAngles, beatVmgs, runAngles, runVmgs)
    }
  }
}

module.exports = OrcSource
