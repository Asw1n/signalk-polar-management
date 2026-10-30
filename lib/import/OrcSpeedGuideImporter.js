'use strict'

const SI = require('../SI')

const MAX_HTML_LENGTH = 8 * 1024 * 1024
const MAX_HTML_TOKENS = 200000
const MAX_SYLK_BASE64_LENGTH = 1024 * 1024
const MAX_SYLK_RECORDS = 10000
const DATASETS = [
  { key: 'BestPerf', kind: 'best' },
  { key: 'Jib', kind: 'headsail' },
  { key: 'Sym', kind: 'symmetric' }
]
const HEADERS = ['TWA', 'BTV', 'VMG', 'AWS', 'AWA', 'Heel', 'Reef', 'Flat']
const SYLK_HEADERS = ['Sail', 'Id', 'TWS', 'Condition', ...HEADERS]
const HTML_TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>|[^<]+|</gi
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr'
])

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    copy: '©',
    deg: '°',
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    sup2: '²'
  }
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match

    const hexadecimal = entity[1].toLowerCase() === 'x'
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return '\uFFFD'
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return '\uFFFD'
    }
  })
}

function parseAttributes(source) {
  const attributes = {}
  let index = 0

  while (index < source.length) {
    while (/\s|\//.test(source[index] || '')) index++
    if (index >= source.length) break

    const nameStart = index
    while (index < source.length && !/[\s=/>]/.test(source[index])) index++
    if (nameStart === index) {
      index++
      continue
    }

    const name = source.slice(nameStart, index).toLowerCase()
    while (/\s/.test(source[index] || '')) index++
    let value = ''
    if (source[index] === '=') {
      index++
      while (/\s/.test(source[index] || '')) index++
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : null
      const valueStart = index
      if (quote) {
        while (index < source.length && source[index] !== quote) index++
        value = source.slice(valueStart, index)
        if (source[index] === quote) index++
      } else {
        while (index < source.length && !/[\s>]/.test(source[index])) index++
        value = source.slice(valueStart, index)
      }
    }
    if (!(name in attributes)) attributes[name] = decodeHtmlEntities(value)
  }

  return attributes
}

function parseTag(token) {
  const match = token.match(/^<\s*(\/?)\s*([a-z][\w:-]*)([\s\S]*?)>$/i)
  if (!match) return null
  return {
    closing: Boolean(match[1]),
    name: match[2].toLowerCase(),
    attributes: match[1] ? {} : parseAttributes(match[3].replace(/\/\s*$/, '')),
    selfClosing: !match[1] && /\/\s*>$/.test(token)
  }
}

function scanHtml(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_HTML_LENGTH) {
    throw new Error('ORC speed-guide HTML is missing or exceeds the size limit')
  }

  const tables = []
  const titleTexts = []
  const anchors = []
  const allText = []
  const tagStack = []
  const activeTitles = []
  let table = null
  let skippedTag = null
  let tokenCount = 0
  let match
  HTML_TOKEN.lastIndex = 0

  while ((match = HTML_TOKEN.exec(content)) !== null) {
    if (++tokenCount > MAX_HTML_TOKENS) {
      throw new Error('ORC speed-guide HTML contains too many elements')
    }
    const token = match[0]
    if (token.startsWith('<!--') || /^<!/i.test(token)) continue

    const tag = parseTag(token)
    if (!tag) {
      if (token === '<') {
        if (!skippedTag) allText.push('<')
        continue
      }
      if (!skippedTag) {
        const text = decodeHtmlEntities(token)
        allText.push(text)
        for (const title of activeTitles) title.parts.push(text)
        if (table?.cell) table.cell.parts.push(text)
        if (table?.captionOpen) table.captionParts.push(text)
      }
      continue
    }

    if (skippedTag) {
      if (tag.closing && tag.name === skippedTag) skippedTag = null
      continue
    }
    if (tag.closing) {
      if (tag.name === 'td' || tag.name === 'th') {
        if (!table?.cell) throw new Error('Malformed ORC speed-guide HTML table cell')
        table.row.push(table.cell.parts.join('').replace(/\s+/g, ' ').trim())
        table.cell = null
      } else if (tag.name === 'tr') {
        if (!table?.row || table.cell) throw new Error('Malformed ORC speed-guide HTML table row')
        table.rows.push(table.row)
        table.row = null
      } else if (tag.name === 'caption') {
        if (!table?.captionOpen) throw new Error('Malformed ORC speed-guide HTML caption')
        table.caption = table.captionParts.join('').replace(/\s+/g, ' ').trim()
        table.captionOpen = false
      } else if (tag.name === 'table') {
        if (!table || table.row || table.cell || table.captionOpen) {
          throw new Error('Malformed ORC speed-guide HTML table')
        }
        tables.push(table)
        table = null
      }

      for (let index = tagStack.length - 1; index >= 0; index--) {
        const entry = tagStack[index]
        tagStack.length = index
        if (entry.title) {
          const titleIndex = activeTitles.indexOf(entry.title)
          if (titleIndex >= 0) activeTitles.splice(titleIndex, 1)
          titleTexts.push(entry.title.parts.join('').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim())
        }
        if (entry.name === tag.name) {
          break
        }
      }
      continue
    }

    if (tag.name === 'script' || tag.name === 'style' || tag.name === 'noscript' || tag.name === 'svg') {
      if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name)) skippedTag = tag.name
      continue
    }
    if (tag.name === 'br') {
      for (const title of activeTitles) title.parts.push('\n')
      if (table?.cell) table.cell.parts.push(' ')
      if (table?.captionOpen) table.captionParts.push(' ')
      continue
    }
    if (tag.name === 'table') {
      if (table) throw new Error('Nested ORC speed-guide tables are not supported')
      table = { caption: '', captionParts: [], captionOpen: false, rows: [], row: null, cell: null }
    } else if (tag.name === 'caption' && table) {
      if (table.captionOpen || table.row) throw new Error('Malformed ORC speed-guide HTML caption')
      table.captionOpen = true
      table.captionParts = []
    } else if (tag.name === 'tr' && table) {
      if (table.row || table.cell) throw new Error('Malformed ORC speed-guide HTML table row')
      table.row = []
    } else if ((tag.name === 'td' || tag.name === 'th') && table) {
      if (!table.row || table.cell) throw new Error('Malformed ORC speed-guide HTML table cell')
      table.cell = { parts: [] }
    }

    if (tag.name === 'a') anchors.push(tag.attributes)
    const title = tag.name === 'div' &&
      (tag.attributes.class || '').split(/\s+/).includes('polarcontainer-title')
      ? { tagName: 'div', parts: [] }
      : null
    if (title) activeTitles.push(title)

    if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name)) {
      tagStack.push({ name: tag.name, title })
    } else if (title) {
      activeTitles.splice(activeTitles.indexOf(title), 1)
      titleTexts.push('')
    }
  }

  if (skippedTag) throw new Error(`Unclosed ${skippedTag} element in ORC speed-guide HTML`)
  if (table) throw new Error('Unclosed ORC speed-guide HTML table')
  if (activeTitles.length) {
    throw new Error('Unclosed ORC speed-guide title element')
  }
  return { tables, titleTexts, anchors, allText: allText.join(' ') }
}

function parseDecimal(value, label) {
  const normalized = String(value).trim().replace(/°$/, '')
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    throw new Error(`Invalid ${label} value '${value}' in ORC speed guide`)
  }
  const number = Number(normalized)
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label} value '${value}' in ORC speed guide`)
  return number
}

function visiblePrecision(value) {
  const normalized = String(value).trim().replace(/°$/, '')
  const fraction = normalized.match(/\.(\d+)/)
  const exponent = normalized.match(/e([+-]?\d+)$/i)
  return Math.max(0, (fraction ? fraction[1].length : 0) - (exponent ? Number(exponent[1]) : 0))
}

function extractVisibleTables(document) {
  if (document.tables.length !== 24) {
    throw new Error(`Expected 24 ORC speed-guide tables; found ${document.tables.length}`)
  }

  const datasetTables = new Map(DATASETS.map(dataset => [dataset.key, []]))
  const windsByDataset = new Map()
  for (const dataset of DATASETS) windsByDataset.set(dataset.key, [])

  document.tables.forEach((table, tableIndex) => {
    const dataset = DATASETS[Math.floor(tableIndex / 8)]
    if (!dataset) throw new Error('Unexpected ORC speed-guide table group')

    const caption = table.caption.match(/^\s*TWS\s*=\s*(\d+(?:\.\d+)?)\s*kts?\s*$/i)
    if (!caption) throw new Error('ORC speed-guide table is missing a recognized TWS caption')
    const twsKnots = parseDecimal(caption[1], 'TWS')
    if (twsKnots <= 0) throw new Error('ORC speed-guide TWS must be positive')
    if (table.rows.length !== 15 || table.rows[0].length !== HEADERS.length) {
      throw new Error('ORC speed-guide tables must have one header and 14 data rows')
    }
    if (table.rows[0].some((header, index) => header.toLowerCase() !== HEADERS[index].toLowerCase())) {
      throw new Error('ORC speed-guide table has unrecognized columns')
    }

    const rows = table.rows.slice(1).map((cells) => {
      if (cells.length !== HEADERS.length) throw new Error('ORC speed-guide table row has an unexpected number of columns')
      const values = {
        twaDeg: parseDecimal(cells[0], 'TWA'),
        btvKnots: parseDecimal(cells[1], 'BTV'),
        vmgKnots: Math.abs(parseDecimal(cells[2], 'VMG')),
        heelDeg: parseDecimal(cells[5], 'heel'),
        reef: parseDecimal(cells[6], 'reef'),
        flat: parseDecimal(cells[7], 'flat'),
        displayed: cells
      }
      validatePoint(values)
      return values
    })

    datasetTables.get(dataset.key).push({ twsKnots, rows })
    windsByDataset.get(dataset.key).push(twsKnots)
  })

  for (const dataset of DATASETS) {
    const winds = windsByDataset.get(dataset.key)
    if (winds.length !== 8 || winds.some((value, index) => index > 0 && value <= winds[index - 1])) {
      throw new Error(`ORC ${dataset.key} tables must contain eight increasing TWS values`)
    }
  }
  return datasetTables
}

function validatePoint(point) {
  if (point.twaDeg < 0 || point.twaDeg > 180) throw new Error('ORC speed-guide TWA must be between 0 and 180 degrees')
  if (point.btvKnots < 0 || point.vmgKnots < 0) throw new Error('ORC speed-guide boat speed and VMG must be nonnegative')
  if (point.heelDeg < 0 || point.heelDeg > 90) throw new Error('ORC speed-guide heel must be between 0 and 90 degrees')
  if (point.reef < 0 || point.flat < 0) throw new Error('ORC speed-guide reef and flat factors must be nonnegative')
}

function parseSylkFields(line) {
  const fields = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '""'
        index++
      } else {
        quoted = !quoted
        field += character
      }
    } else if (character === ';' && !quoted) {
      fields.push(field)
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) throw new Error('Malformed quoted value in embedded ORC SYLK data')
  fields.push(field)
  return fields
}

function decodeSylkValue(value) {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new Error('Malformed string cell in embedded ORC SYLK data')
    return value.slice(1, -1).replace(/""/g, '"')
  }
  if (value.includes('"')) throw new Error('Malformed scalar cell in embedded ORC SYLK data')
  return value
}

function parseSylk(anchor) {
  const dataUri = anchor.href || ''
  const match = dataUri.match(/^data:application\/octet-stream;base64,([A-Za-z0-9+/]*={0,2})$/i)
  if (!match) throw new Error('Embedded ORC .slk download is not a valid octet-stream base64 data URI')
  const encoded = match[1]
  if (encoded.length > MAX_SYLK_BASE64_LENGTH || encoded.length % 4 === 1) {
    throw new Error('Embedded ORC SYLK data exceeds the size limit or has invalid base64')
  }
  const unpadded = encoded.replace(/=+$/, '')
  if (encoded.includes('=') && encoded.length % 4 !== 0) {
    throw new Error('Malformed base64 padding in embedded ORC SYLK data')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64').replace(/=+$/, '') !== unpadded) {
    throw new Error('Malformed base64 in embedded ORC SYLK data')
  }
  if (bytes.length > 512 * 1024) throw new Error('Embedded ORC SYLK data exceeds the decoded size limit')

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    throw new Error('Embedded ORC SYLK data is not valid UTF-8')
  }
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.length < 3 || lines.length > MAX_SYLK_RECORDS || lines[0] !== 'ID;PWXL;N;E' || lines[lines.length - 1] !== 'E') {
    throw new Error('Embedded ORC .slk file has an invalid scalar SYLK structure')
  }

  const cells = new Map()
  for (const line of lines.slice(1, -1)) {
    const fields = parseSylkFields(line)
    if (fields[0] !== 'C' || fields.length !== 4) {
      throw new Error('Embedded ORC .slk file contains unsupported non-scalar records')
    }
    const rowMatch = fields[1].match(/^Y([1-9]\d*)$/)
    const columnMatch = fields[2].match(/^X([1-9]\d*)$/)
    if (!rowMatch || !columnMatch || !fields[3].startsWith('K')) {
      throw new Error('Embedded ORC .slk file contains a malformed scalar cell')
    }
    const row = Number(rowMatch[1])
    const column = Number(columnMatch[1])
    if (row > 337 || column > SYLK_HEADERS.length) {
      throw new Error('Embedded ORC .slk file exceeds the expected table dimensions')
    }
    const key = `${row}:${column}`
    if (cells.has(key)) throw new Error('Embedded ORC .slk file contains duplicate scalar cells')
    cells.set(key, decodeSylkValue(fields[3].slice(1)))
  }

  if (cells.size !== 337 * SYLK_HEADERS.length) {
    throw new Error('Embedded ORC .slk file must contain 336 complete scalar data rows')
  }
  const cell = (row, column) => cells.get(`${row}:${column}`)
  for (let column = 1; column <= SYLK_HEADERS.length; column++) {
    if (cell(1, column) !== SYLK_HEADERS[column - 1]) {
      throw new Error('Embedded ORC .slk file has unrecognized scalar columns')
    }
  }

  const rowsByDataset = new Map(DATASETS.map(dataset => [dataset.key, []]))
  for (let row = 2; row <= 337; row++) {
    const sail = cell(row, 1)
    const dataset = DATASETS.find(candidate => candidate.key === sail)
    if (!dataset) throw new Error(`Embedded ORC .slk has an unrecognized sail table '${sail}'`)
    const condition = String(cell(row, 4)).toLowerCase()
    if (!['beat', 'run', 'reach'].includes(condition)) {
      throw new Error(`Embedded ORC .slk has an unrecognized condition '${cell(row, 4)}'`)
    }

    const point = {
      id: cell(row, 2),
      twsKnots: parseDecimal(cell(row, 3), 'SYLK TWS'),
      condition,
      twaDeg: parseDecimal(cell(row, 5), 'SYLK TWA'),
      btvKnots: parseDecimal(cell(row, 6), 'SYLK BTV'),
      vmgKnots: parseDecimal(cell(row, 7), 'SYLK VMG'),
      heelDeg: parseDecimal(cell(row, 10), 'SYLK heel'),
      reef: parseDecimal(cell(row, 11), 'SYLK reef'),
      flat: parseDecimal(cell(row, 12), 'SYLK flat')
    }
    const awsKnots = parseDecimal(cell(row, 8), 'SYLK AWS')
    const awaDeg = parseDecimal(cell(row, 9), 'SYLK AWA')
    if (awsKnots < 0 || !Number.isFinite(awaDeg)) {
      throw new Error('Embedded ORC .slk contains an invalid scalar apparent-wind value')
    }
    point.vmgKnots = Math.abs(point.vmgKnots)
    validatePoint(point)
    if (point.twsKnots <= 0) throw new Error('Embedded ORC SYLK TWS must be positive')
    rowsByDataset.get(sail).push(point)
  }

  return rowsByDataset
}

function embeddedSylkLink(anchors) {
  const candidates = anchors.filter(anchor => /\.slk$/i.test(anchor.download || ''))
  if (candidates.length > 1) throw new Error('ORC speed guide contains multiple .slk downloads')
  const candidate = candidates[0]
  return /^data:/i.test(candidate?.href || '') ? candidate : null
}

function tablePointMap(rowsByDataset) {
  const tables = new Map()

  for (const dataset of DATASETS) {
    const rows = rowsByDataset.get(dataset.key)
    if (!rows || rows.length !== 112) {
      throw new Error(`ORC ${dataset.key} data must contain 112 scalar points`)
    }
    const sourceIds = new Set(rows.map(point => point.id))
    if (sourceIds.size !== 1) {
      throw new Error(`Embedded ORC ${dataset.key} rows have conflicting sail identifiers`)
    }
    const byTws = new Map()
    for (const point of rows) {
      if (!byTws.has(point.twsKnots)) byTws.set(point.twsKnots, [])
      byTws.get(point.twsKnots).push(point)
    }
    const winds = Array.from(byTws.keys()).sort((left, right) => left - right)
    if (winds.length !== 8) throw new Error(`ORC ${dataset.key} data must contain eight TWS values`)
    for (const twsKnots of winds) {
      const points = byTws.get(twsKnots)
      const conditions = points.reduce((counts, point) => {
        counts[point.condition]++
        return counts
      }, { beat: 0, run: 0, reach: 0 })
      if (points.length !== 14 || conditions.beat !== 1 || conditions.run !== 1 || conditions.reach !== 12) {
        throw new Error(`ORC ${dataset.key} at ${twsKnots} knots must contain 12 reaches and one beat/run target`)
      }
      const reaches = points.filter(point => point.condition === 'reach')
      if (new Set(reaches.map(point => point.twaDeg)).size !== 12) {
        throw new Error(`ORC ${dataset.key} at ${twsKnots} knots has duplicate reach angles`)
      }
    }
    tables.set(dataset.key, { byTws, winds, sourceId: rows[0].id })
  }

  const first = tables.get(DATASETS[0].key)
  for (const dataset of DATASETS.slice(1)) {
    const rows = rowsByDataset.get(dataset.key)
    const byTws = new Map()
    for (const point of rows) {
      if (!byTws.has(point.twsKnots)) byTws.set(point.twsKnots, [])
      byTws.get(point.twsKnots).push(point)
    }
    const winds = Array.from(byTws.keys()).sort((left, right) => left - right)
    if (winds.some((value, index) => value !== first.winds[index])) {
      throw new Error('ORC speed-guide datasets have conflicting TWS axes')
    }
    tables.set(dataset.key, { byTws, winds, sourceId: rows[0].id })
  }
  return tables
}

function compareVisibleAndSylk(visibleTables, sylkTables) {
  for (const [datasetIndex, dataset] of DATASETS.entries()) {
    const tables = visibleTables.get(dataset.key)
    const sylk = sylkTables.get(dataset.key)
    if (tables.length !== 8) throw new Error(`ORC ${dataset.key} must have eight visible tables`)

    for (let windIndex = 0; windIndex < 8; windIndex++) {
      const visible = tables[windIndex]
      const twsKnots = sylk.winds[windIndex]
      if (visible.twsKnots !== twsKnots) {
        throw new Error(`Embedded ORC SYLK data conflicts with visible ${dataset.key} TWS captions`)
      }
      const sourcePoints = sylk.byTws.get(twsKnots)
      const unmatched = [...sourcePoints]
      for (const visiblePoint of visible.rows) {
        const candidateIndex = unmatched.findIndex((sourcePoint) => {
          const values = [
            [sourcePoint.twaDeg, visiblePoint.twaDeg, 'TWA'],
            [sourcePoint.btvKnots, visiblePoint.btvKnots, 'BTV'],
            [sourcePoint.vmgKnots, visiblePoint.vmgKnots, 'VMG'],
            [sourcePoint.heelDeg, visiblePoint.heelDeg, 'heel'],
            [sourcePoint.reef, visiblePoint.reef, 'reef'],
            [sourcePoint.flat, visiblePoint.flat, 'flat']
          ]
          return values.every(([source, shown, label]) => {
            const sourceValue = label === 'VMG' ? Math.abs(source) : source
            const precision = visiblePrecision(visiblePoint.displayed[
              label === 'TWA' ? 0 :
                label === 'BTV' ? 1 :
                  label === 'VMG' ? 2 :
                    label === 'heel' ? 5 :
                      label === 'reef' ? 6 : 7
            ])
            return Math.abs(sourceValue - shown) <= 0.5 * (10 ** -precision) + 1e-8
          })
        })
        if (candidateIndex < 0) {
          throw new Error(`Embedded ORC SYLK data conflicts with visible ${dataset.key} data at ${twsKnots} knots`)
        }
        unmatched.splice(candidateIndex, 1)
      }
      if (unmatched.length) throw new Error(`Visible ${dataset.key} table has missing embedded SYLK points`)
    }
  }
}

function visibleFallbackTables(visibleTables) {
  const parsed = new Map()
  for (const dataset of DATASETS) {
    const tables = visibleTables.get(dataset.key)
    const angleCounts = new Map()
    for (const table of tables) {
      const counts = new Map()
      for (const point of table.rows) counts.set(point.twaDeg, (counts.get(point.twaDeg) || 0) + 1)
      for (const [angle, count] of counts) {
        if (count === 1) angleCounts.set(angle, (angleCounts.get(angle) || 0) + 1)
      }
    }
    const commonAngles = Array.from(angleCounts)
      .filter(([, count]) => count === 8)
      .map(([angle]) => angle)
      .sort((left, right) => left - right)
    if (commonAngles.length < 12 || commonAngles.length > 14) {
      throw new Error(`Cannot unambiguously identify 12 regular reach angles in the visible ${dataset.key} tables`)
    }

    const candidates = []
    const chooseAngles = (start, remaining, chosen) => {
      if (remaining === 0) {
        const angles = chosen
        let valid = true
        const candidateByTws = new Map()
        for (const table of tables) {
          const reaches = []
          const targets = { beat: null, run: null }
          for (const point of table.rows) {
            if (angles.includes(point.twaDeg)) {
              reaches.push(point)
            } else {
              const target = point.twaDeg < 90 ? 'beat' : point.twaDeg > 90 ? 'run' : null
              if (!target || targets[target]) {
                valid = false
                break
              }
              targets[target] = point
            }
          }
          if (!valid || reaches.length !== 12 || !targets.beat || !targets.run) {
            valid = false
            break
          }
          candidateByTws.set(table.twsKnots, { reaches, ...targets })
        }
        if (valid) candidates.push({ angles: [...angles], byTws: candidateByTws })
        return
      }
      for (let index = start; index <= commonAngles.length - remaining; index++) {
        chosen.push(commonAngles[index])
        chooseAngles(index + 1, remaining - 1, chosen)
        chosen.pop()
      }
    }
    chooseAngles(0, 12, [])
    if (candidates.length !== 1) {
      throw new Error(`Cannot unambiguously identify 12 regular reach angles in the visible ${dataset.key} tables`)
    }
    const { angles: regularAngles, byTws } = candidates[0]

    parsed.set(dataset.key, { tables, angles: regularAngles, byTws })
  }
  return parsed
}

function sourceRowsToTables(sylkTables) {
  const parsed = new Map()
  for (const dataset of DATASETS) {
    const source = sylkTables.get(dataset.key)
    const angles = Array.from(new Set(source.winds.flatMap(tws => (
      source.byTws.get(tws).filter(point => point.condition === 'reach').map(point => point.twaDeg)
    )))).sort((left, right) => left - right)
    if (angles.length !== 12) throw new Error(`ORC ${dataset.key} data must have exactly 12 regular TWA values`)

    const byTws = new Map()
    for (const twsKnots of source.winds) {
      const points = source.byTws.get(twsKnots)
      const reaches = points.filter(point => point.condition === 'reach')
      if (reaches.some(point => !angles.includes(point.twaDeg)) || angles.some(angle => !reaches.some(point => point.twaDeg === angle))) {
        throw new Error(`ORC ${dataset.key} has inconsistent regular TWA axes`)
      }
      byTws.set(twsKnots, {
        reaches,
        beat: points.find(point => point.condition === 'beat'),
        run: points.find(point => point.condition === 'run')
      })
    }
    parsed.set(dataset.key, { tables: [], angles, byTws })
  }
  return parsed
}

function sourceMetadata(document) {
  const headings = document.titleTexts.filter(text => /Best\s+Performance/i.test(text))
  if (headings.length === 0 || !/Best\s+Performance/i.test(document.allText)) {
    throw new Error('ORC speed guide has no recognized Best Performance heading')
  }
  if (!/Headsail,/i.test(document.allText) || !/Symmetric,/i.test(document.allText)) {
    throw new Error('ORC speed guide is missing a recognized sail-table heading')
  }

  const rootMetadata = headings.map((heading) => {
    const rootLines = heading
      .split(/Best\s+Performance/i)[0]
      .split(/\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const sailnumberIndex = rootLines.findIndex(line => /^[A-Z]{2,}\s+\d+[A-Z]?$/i.test(line))
    if (sailnumberIndex < 1 || sailnumberIndex === rootLines.length - 1) {
      throw new Error('ORC speed guide is missing recognized root boat metadata')
    }

    const metadata = {
      name: rootLines.slice(0, sailnumberIndex).join(' ').trim(),
      sailnumber: rootLines[sailnumberIndex],
      boatType: rootLines.slice(sailnumberIndex + 1).join(' ').trim()
    }
    if (!metadata.name || !metadata.boatType) {
      throw new Error('ORC speed guide is missing recognized root boat metadata')
    }
    return metadata
  })
  const distinctRootMetadata = new Set(rootMetadata.map(metadata => JSON.stringify(metadata)))
  if (distinctRootMetadata.size !== 1) {
    throw new Error('ORC speed guide contains conflicting root boat metadata')
  }

  const { name, sailnumber, boatType } = rootMetadata[0]

  const extractSail = (pattern, name) => {
    const descriptions = []
    for (const match of document.allText.matchAll(pattern)) {
      descriptions.push({
        name,
        sourceId: match[2].trim(),
        area: parseDecimal(match[1], `${name} area`)
      })
    }
    const distinct = new Map(descriptions.map(sail => [`${sail.sourceId}|${sail.area}`, sail]))
    if (distinct.size !== 1) throw new Error(`ORC speed guide has conflicting or missing ${name} descriptions`)
    const sail = Array.from(distinct.values())[0]
    if (!sail.sourceId || sail.area <= 0) throw new Error(`Invalid ORC ${name} description`)
    return sail
  }
  const headsail = extractSail(/Headsail\s*,\s*(\d+(?:\.\d+)?)\s*m(?:²|2|\^2)\s*\(\s*id\s*=\s*([^)]+)\)/gi, 'Headsail')
  const symmetric = extractSail(/Symmetric\s*,\s*(\d+(?:\.\d+)?)\s*m(?:²|2|\^2)\s*\(\s*id\s*=\s*([^)]+)\)/gi, 'Symmetric spinnaker')
  const years = Array.from(document.allText.matchAll(/Offshore\s+Racing\s+Congress\s+(\d{4})/gi), match => Number(match[1]))
  const distinctYears = new Set(years)
  if (distinctYears.size > 1) throw new Error('ORC speed guide contains conflicting year metadata')

  return {
    name,
    sailnumber,
    boatType,
    ...(years.length ? { year: years[0] } : {}),
    sails: [headsail, symmetric]
  }
}

function targetPoint(point) {
  if (point.btvKnots === 0.01) return null
  return {
    twa: SI.fromDegrees(point.twaDeg),
    tbs: SI.fromKnots(point.btvKnots),
    vmg: SI.fromKnots(Math.abs(point.vmgKnots)),
    heel: SI.fromDegrees(point.heelDeg),
    reef: point.reef,
    flat: point.flat
  }
}

function buildTable(dataset, source, tableSet) {
  const twsKnots = source.winds
  const angles = tableSet.angles
  const boatSpeedMatrix = []
  const heelMatrix = []
  const reefMatrix = []
  const flatMatrix = []
  const derivedRows = []

  for (const wind of twsKnots) {
    const data = tableSet.byTws.get(wind)
    const reachByAngle = new Map(data.reaches.map(point => [point.twaDeg, point]))
    const speedRow = []
    const heelRow = []
    const reefRow = []
    const flatRow = []
    for (const angle of angles) {
      const point = reachByAngle.get(angle)
      if (!point) throw new Error(`ORC ${dataset.key} table is missing a TWA value`)
      const unavailable = point.btvKnots === 0.01
      speedRow.push(unavailable ? null : SI.fromKnots(point.btvKnots))
      heelRow.push(unavailable ? null : SI.fromDegrees(point.heelDeg))
      reefRow.push(unavailable ? null : point.reef)
      flatRow.push(unavailable ? null : point.flat)
    }
    boatSpeedMatrix.push(speedRow)
    heelMatrix.push(heelRow)
    reefMatrix.push(reefRow)
    flatMatrix.push(flatRow)

    const beat = targetPoint(data.beat)
    const run = targetPoint(data.run)
    if (beat || run) {
      derivedRows.push({
        tws: SI.fromKnots(wind),
        ...(beat ? { beat } : {}),
        ...(run ? { run } : {})
      })
    }
  }

  return {
    axes: {
      tws: twsKnots.map(SI.fromKnots),
      twa: angles.map(SI.fromDegrees)
    },
    values: { boatSpeedMatrix, heelMatrix, reefMatrix, flatMatrix },
    ...(derivedRows.length ? { derived: { rows: derivedRows } } : {})
  }
}

function safeSailplanId(prefix, sourceId, usedIds) {
  let suffix = sourceId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!suffix) suffix = 'source'
  let id = `${prefix}-${suffix}`
  let index = 2
  while (usedIds.has(id)) id = `${prefix}-${suffix}-${index++}`
  usedIds.add(id)
  return id
}

class OrcSpeedGuideImporter {
  constructor() {
    this.id = 'orc-speed-guide'
    this.name = 'ORC speed guide'
    this.description = 'ORC speed-guide HTML (8 MiB maximum) with validated embedded scalar SYLK data or visible-table fallback. Exact 0.01-knot BTV points are unavailable; AWS/AWA are omitted.'
    this.defaultSource = 'orc-speed-guide'
  }

  detect(content) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_HTML_LENGTH) return false
    try {
      return looksLikeGuide(scanHtml(content))
    } catch {
      return hasMalformedGuideMarkers(content)
    }
  }

  parse(content) {
    const document = scanHtml(content)
    if (!looksLikeGuide(document)) throw new Error('Expected an ORC speed-guide HTML document')
    const metadata = sourceMetadata(document)
    const visibleTables = extractVisibleTables(document)
    const link = embeddedSylkLink(document.anchors)
    let tableSet

    if (link) {
      const sylkRows = parseSylk(link)
      const sylkTables = tablePointMap(sylkRows)
      if (sylkTables.get('BestPerf').sourceId !== '') {
        throw new Error('Embedded ORC BestPerf rows have an unexpected sail identifier')
      }
      if (sylkTables.get('Jib').sourceId !== metadata.sails[0].sourceId ||
        sylkTables.get('Sym').sourceId !== metadata.sails[1].sourceId) {
        throw new Error(
          `Embedded ORC sail identifiers ${JSON.stringify([sylkTables.get('Jib').sourceId, sylkTables.get('Sym').sourceId])} ` +
          `conflict with visible sail descriptions ${JSON.stringify(metadata.sails.map(sail => sail.sourceId))}`
        )
      }
      compareVisibleAndSylk(visibleTables, sylkTables)
      tableSet = sourceRowsToTables(sylkTables)
    } else {
      tableSet = visibleFallbackTables(visibleTables)
    }

    const bestSource = tablePointMapFromSet(tableSet.get('BestPerf'))
    const best = buildTable(DATASETS[0], bestSource, tableSet.get('BestPerf'))
    const usedIds = new Set()
    const sailplans = [
      {
        id: safeSailplanId('headsail', metadata.sails[0].sourceId, usedIds),
        name: 'Headsail',
        sails: [metadata.sails[0]],
        table: buildTable(DATASETS[1], tablePointMapFromSet(tableSet.get('Jib')), tableSet.get('Jib'))
      },
      {
        id: safeSailplanId('symmetric-spinnaker', metadata.sails[1].sourceId, usedIds),
        name: 'Symmetric spinnaker',
        sails: [metadata.sails[1]],
        table: buildTable(DATASETS[2], tablePointMapFromSet(tableSet.get('Sym')), tableSet.get('Sym'))
      }
    ]

    return {
      resource: {
        kind: 'polarSet',
        schemaVersion: '2.0.0',
        source: this.defaultSource,
        name: metadata.name,
        sailnumber: metadata.sailnumber,
        boatType: metadata.boatType,
        ...(metadata.year ? { year: metadata.year } : {}),
        units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s', heel: 'rad', reef: '1', flat: '1' },
        symmetry: { portStarboardSymmetric: true },
        best,
        sailplans,
        notes: 'Exact ORC BTV values of 0.01 knots are imported as unavailable; all other source values, including zero, remain numeric. AWS and AWA are omitted.'
      }
    }
  }
}

function looksLikeGuide(document) {
  const hasTitle = document.titleTexts.some(text => /Best\s+Performance/i.test(text))
  const hasTable = document.tables.some((table) => {
    const header = table.rows[0]
    return /^\s*TWS\s*=\s*\d+(?:\.\d+)?\s*kts?\s*$/i.test(table.caption) &&
      Array.isArray(header) &&
      header.length === HEADERS.length &&
      header.every((cell, index) => cell.toLowerCase() === HEADERS[index].toLowerCase())
  })
  return hasTitle && hasTable
}

function hasMalformedGuideMarkers(content) {
  const inertFree = content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const titleOpen = inertFree.match(/<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\bpolarcontainer-title\b[^"']*\1[^>]*>/i)
  if (!titleOpen) return false
  const titleStart = inertFree.indexOf(titleOpen[0]) + titleOpen[0].length
  const titleRemainder = inertFree.slice(titleStart, titleStart + 12000)
  const titleText = decodeHtmlEntities(titleRemainder.replace(/<[^>]*>/g, ' '))
  if (!/Best\s+Performance/i.test(titleText)) return false

  const tableMatch = inertFree.match(/<table\b[\s\S]{0,20000}/i)
  if (!tableMatch) return false
  const tableText = decodeHtmlEntities(tableMatch[0].replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  return /\bTWS\s*=\s*\d+(?:\.\d+)?\s*kts?\b/i.test(tableText) &&
    /\bTWA\b[\s\S]{0,80}\bBTV\b[\s\S]{0,80}\bVMG\b/i.test(tableText)
}

function tablePointMapFromSet(tableSet) {
  const byTws = new Map()
  for (const [wind, data] of tableSet.byTws) {
    byTws.set(wind, [...data.reaches, data.beat, data.run])
  }
  return { winds: Array.from(byTws.keys()).sort((left, right) => left - right), byTws }
}

module.exports = OrcSpeedGuideImporter
