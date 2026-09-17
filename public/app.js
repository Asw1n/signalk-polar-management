// app.js — Polar Management webapp
// All data comes from this plugin's own HTTP endpoints (never the SK bus directly).
// Pages: Active polar | Management | Import — no build step, no framework.
'use strict'

const BASE = '/plugins/signalk-polar-management'

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function setMessage(text, isError) {
  const el = document.getElementById('message')
  el.textContent = text || ''
  el.className = (isError ? 'text-danger' : 'text-success') + ' small ms-auto me-3'
  if (text) setTimeout(() => { el.textContent = '' }, 4000)
}

async function api(path, options) {
  const res = await fetch(`${BASE}/${path}`, options)
  const contentType = res.headers.get('content-type') || ''
  const body = contentType.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`)
  return body
}

// ── App state ─────────────────────────────────────────────────────────────────
let polars = []
let activeStatus = { id: null, exists: false, valid: false, errors: [] }
let performanceFactor = 1
let internetStatus = { online: false }
let orcCached = false
let lastFileImportError = ''
let lastTextImportError = ''
let lastOrcImportError = ''
let orcQuery = ''
let orcResults = null // null = no search run yet
let activePage = 'active'
let polarSort = { key: 'name', direction: 'asc' }
let canvasObserver = null

const POLAR_COLUMNS = [
  { key: 'name', label: 'Boat name', value: polar => polar.name || polar.id },
  { key: 'id', label: 'ID', value: polar => polar.id },
  { key: 'boatType', label: 'Boat type', value: polar => polar.boatType || '' },
  { key: 'sailnumber', label: 'Sail no.', value: polar => polar.sailnumber || '' },
  { key: 'year', label: 'Year', value: polar => polar.year || '' },
  { key: 'source', label: 'Source', value: polar => polar.source || '' }
]

function polarById(id) {
  return polars.find(p => p.id === id)
}

function sortedPolars() {
  const column = POLAR_COLUMNS.find(candidate => candidate.key === polarSort.key) || POLAR_COLUMNS[0]
  const multiplier = polarSort.direction === 'asc' ? 1 : -1
  return [...polars].sort((left, right) => {
    const leftValue = String(column.value(left))
    const rightValue = String(column.value(right))
    return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: 'base' }) * multiplier
  })
}

function buildPolarTable({ selectable = false, actions = false } = {}) {
  const table = document.createElement('table')
  table.className = 'table table-sm table-borderless align-middle mb-0 polar-list'
  const sortIndicator = (key) => {
    if (polarSort.key !== key) return ''
    return polarSort.direction === 'asc' ? ' &#9650;' : ' &#9660;'
  }
  table.innerHTML = `
    <thead>
      <tr>
        ${selectable ? '<th scope="col" style="width:2rem"></th>' : ''}
        ${POLAR_COLUMNS.map(column => `
          <th scope="col" aria-sort="${polarSort.key === column.key ? (polarSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}">
            <button type="button" class="btn btn-link btn-sm p-0 text-reset text-decoration-none polar-sort" data-sort-key="${column.key}">
              ${column.label}${sortIndicator(column.key)}
            </button>
          </th>
        `).join('')}
        ${actions ? '<th scope="col"></th>' : ''}
      </tr>
    </thead>
    <tbody>
      ${sortedPolars().map(polar => `
        <tr>
          ${selectable ? `<td><input type="radio" name="activePolarRadio" data-id="${escapeHtml(polar.id)}" ${polar.id === activeStatus.id ? 'checked' : ''}></td>` : ''}
          ${POLAR_COLUMNS.map(column => `<td>${escapeHtml(column.value(polar))}</td>`).join('')}
          ${actions ? `
            <td class="polar-actions">
              <button class="btn btn-link btn-sm" data-action="rename" data-id="${escapeHtml(polar.id)}">Rename</button>
              <button class="btn btn-link btn-sm" data-action="copy" data-id="${escapeHtml(polar.id)}">Copy</button>
              <div class="dropdown d-inline">
                <button class="btn btn-link btn-sm dropdown-toggle" type="button" data-dropdown-toggle>Export</button>
                <div class="dropdown-menu dropdown-menu-right">
                  <a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(polar.id)}/export/json" download>Canonical JSON</a>
                  <a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(polar.id)}/export/jieter" download>Jieter text</a>
                  <a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(polar.id)}/export/expedition" download>Expedition text</a>
                </div>
              </div>
              <button class="btn btn-link btn-sm text-danger" data-action="delete" data-id="${escapeHtml(polar.id)}">Delete</button>
            </td>
          ` : ''}
        </tr>
      `).join('')}
    </tbody>
  `
  table.querySelectorAll('[data-sort-key]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.sortKey
      polarSort = polarSort.key === key
        ? { key, direction: polarSort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
      rerender()
    })
  })
  return table
}

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadPolars() { polars = await api('polars') }
async function loadActiveStatus() { activeStatus = await api('activePolar') }

async function loadPerformanceFactor() {
  const { value } = await api('performanceFactor')
  performanceFactor = Number.isFinite(value) ? value : 1
}

async function loadInternetStatus() { internetStatus = await api('internet') }

async function loadOrcSourceStatus() {
  const sources = await api('imports/sources')
  const orc = sources.find(s => s.id === 'orc')
  orcCached = !!(orc && orc.cached)
}

async function loadAll() {
  await Promise.all([
    loadPolars(), loadActiveStatus(), loadPerformanceFactor(),
    loadInternetStatus(), loadOrcSourceStatus()
  ])
}

// ── Navigation ────────────────────────────────────────────────────────────────
const PAGES = {
  active: { build: buildActivePage },
  management: { build: buildManagementPage },
  import: { build: buildImportPage }
}

function switchPage(page) {
  activePage = page
  if (canvasObserver) { canvasObserver.disconnect(); canvasObserver = null }
  document.querySelectorAll('#main-nav .nav-link').forEach(l =>
    l.classList.toggle('active', l.dataset.page === page)
  )
  const shell = document.getElementById('page-shell')
  const body = document.getElementById('card-body')
  shell.classList.add('page-shellless')
  body.classList.add('page-shellless-body')
  body.innerHTML = ''
  body.appendChild(PAGES[page].build())
}

async function rerender() { switchPage(activePage) }

function cardEl(headerText) {
  const card = document.createElement('div')
  card.className = 'card mb-3'
  const header = document.createElement('div')
  header.className = 'card-header fw-bold text-uppercase small'
  header.textContent = headerText
  const body = document.createElement('div')
  body.className = 'card-body'
  card.appendChild(header)
  card.appendChild(body)
  return { card, body }
}

function sectionHeading(text) {
  const h = document.createElement('h6')
  h.className = 'text-uppercase fw-bold text-muted border-bottom pb-1 mt-3 mb-2 small'
  h.textContent = text
  return h
}

// Renders a 'Warnings' section heading + list. Always append this last so the
// warnings stay the final paragraph of their container.
// Returns an empty fragment (nothing appended) when there are no messages.
function warningsSection(messages) {
  const frag = document.createDocumentFragment()
  if (!messages.length) return frag
  frag.appendChild(sectionHeading('Warnings'))
  const ul = document.createElement('ul')
  ul.className = 'text-danger small mb-0 ps-3'
  ul.innerHTML = messages.map(m => `<li>${escapeHtml(m)}</li>`).join('')
  frag.appendChild(ul)
  return frag
}

// ── Active polar page ─────────────────────────────────────────────────────────
function buildActivePage() {
  const wrap = document.createElement('div')

  // --- Active polar card ---
  const overview = cardEl('Active polar')
  wrap.appendChild(overview.card)

  const row = document.createElement('div')
  row.className = 'row'
  overview.body.appendChild(row)

  const colGraph = document.createElement('div')
  colGraph.className = 'col-md-5 col-lg-4'
  row.appendChild(colGraph)

  const colDetails = document.createElement('div')
  colDetails.className = 'col-md-7 col-lg-8'
  row.appendChild(colDetails)

  const activePolar = activeStatus.exists && activeStatus.valid ? polarById(activeStatus.id) : null

  if (activePolar) {
    const canvas = document.createElement('canvas')
    canvas.id = 'polarCanvas'
    canvas.className = 'polar-canvas'
    colGraph.appendChild(canvas)
    const canvasInstance = new window.PolarCanvas(canvas)
    observeCanvasSize(canvas, canvasInstance)
    loadOverviewCurves(activeStatus.id, canvasInstance)
  } else {
    const placeholder = document.createElement('div')
    placeholder.className = 'text-muted small'
    placeholder.textContent = 'No valid active polar to display.'
    colGraph.appendChild(placeholder)
  }

  colDetails.appendChild(sectionHeading('Polar'))
  if (activePolar) {
    const dl = document.createElement('table')
    dl.className = 'table table-kv table-sm table-borderless mb-0'
    dl.innerHTML = [
      ['Boat name', activePolar.name],
      ['ID', activePolar.id],
      ['Boat type', activePolar.boatType],
      ['Sail no.', activePolar.sailnumber],
      ['Year', activePolar.year],
      ['Source', activePolar.source],
      ['Notes', activePolar.notes]
    ].filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([label, value]) => `<tr><td class="text-muted">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
      .join('')
    colDetails.appendChild(dl)
  } else {
    const empty = document.createElement('div')
    empty.className = 'text-muted small'
    empty.textContent = 'No metadata to display.'
    colDetails.appendChild(empty)
  }

  colDetails.appendChild(sectionHeading('Polar adjustment'))
  const adjWrap = document.createElement('div')
  adjWrap.className = 'input-group'
  adjWrap.style.maxWidth = '14rem'
  adjWrap.innerHTML = `
    <input type="number" id="performanceFactor" class="form-control form-control-sm" min="0" max="100" step="1" value="${Math.round(performanceFactor * 100)}">
    <span class="input-group-text">%</span>
  `
  colDetails.appendChild(adjWrap)
  const adjSave = document.createElement('button')
  adjSave.className = 'btn btn-primary btn-sm mt-2'
  adjSave.textContent = 'Save'
  adjSave.addEventListener('click', async () => {
    const percent = Number(colDetails.querySelector('#performanceFactor').value)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      setMessage('Enter a performance factor from 0 to 100%', true)
      return
    }
    try {
      const { value } = await api('performanceFactor', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: percent / 100 })
      })
      performanceFactor = value
      setMessage(`Polar adjustment set to ${Math.round(performanceFactor * 100)}%`)
      await rerender()
    } catch (e) {
      setMessage(e.message, true)
    }
  })
  colDetails.appendChild(adjSave)

  const warnings = []
  if (!activeStatus.id) {
    warnings.push('No active polar is selected.')
  } else if (!activeStatus.exists) {
    warnings.push(`Configured active polar '${activeStatus.id}' was not found.`)
  } else if (!activeStatus.valid) {
    warnings.push(...activeStatus.errors)
  }
  colDetails.appendChild(warningsSection(warnings))

  // --- Polar selection card ---
  const selection = cardEl('Select polar')
  wrap.appendChild(selection.card)

  if (!polars.length) {
    const empty = document.createElement('div')
    empty.className = 'text-muted small'
    empty.textContent = 'No stored polars. Import one from the Import page first.'
    selection.body.appendChild(empty)
  } else {
    const table = buildPolarTable({ selectable: true })
    selection.body.appendChild(table)
    table.addEventListener('change', async (event) => {
      if (event.target.name !== 'activePolarRadio') return
      try {
        await api('activePolar', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: event.target.dataset.id })
        })
        await loadActiveStatus()
        setMessage(`Active polar set to '${event.target.dataset.id}'`)
        await rerender()
      } catch (e) {
        setMessage(e.message, true)
      }
    })
  }

  return wrap
}

async function loadOverviewCurves(id, canvas) {
  try {
    const curves = await api(`polars/${encodeURIComponent(id)}/curves?step=5&corrected=true`)
    canvas.loadCurves(curves)
  } catch (e) {
    setMessage(e.message, true)
  }
}

// Resize + redraw the canvas whenever its CSS size changes. This covers both the
// asynchronously injected CoreUI stylesheet (which changes layout after first
// paint) and later window resizes; without it the backing store is sized from a
// stale CSS box and the diagram renders blurry.
function observeCanvasSize(el, instance) {
  if (canvasObserver) canvasObserver.disconnect()
  const applySize = () => {
    if (el.offsetWidth > 0) instance.resize()
  }
  if (window.ResizeObserver) {
    let rafPending = false
    canvasObserver = new ResizeObserver(() => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => { rafPending = false; applySize() })
    })
    canvasObserver.observe(el)
  } else {
    canvasObserver = null
    requestAnimationFrame(applySize)
  }
}

// ── Management page ───────────────────────────────────────────────────────────
function buildManagementPage() {
  const wrap = document.createElement('div')

  const stored = cardEl('Stored polars')
  wrap.appendChild(stored.card)

  const table = buildPolarTable({ actions: true })
  stored.body.appendChild(table)

  table.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-dropdown-toggle]')
    if (toggle) {
      event.preventDefault()
      const menu = toggle.nextElementSibling
      const isOpen = menu.classList.contains('show')
      table.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'))
      if (!isOpen) menu.classList.add('show')
      return
    }
    if (event.target.closest('.dropdown-item')) {
      table.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'))
      return
    }
    const target = event.target.closest('[data-action]')
    if (!target) return
    const { action, id } = target.dataset
    try {
      if (action === 'rename') await renamePolar(id)
      if (action === 'copy') await copyPolar(id)
      if (action === 'delete') await deletePolar(id)
      await rerender()
    } catch (e) {
      setMessage(e.message, true)
    }
  })

  return wrap
}

async function renamePolar(id) {
  const newId = window.prompt('New name for polar', id)
  if (!newId || newId === id) return
  await api(`polars/${encodeURIComponent(id)}/rename`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: newId })
  })
  await loadPolars()
  await loadActiveStatus()
  setMessage(`Renamed to '${newId}'`)
}

async function copyPolar(id) {
  const newId = window.prompt('Name for the copy', `${id}-copy`)
  if (!newId) return
  await api(`polars/${encodeURIComponent(id)}/copy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: newId })
  })
  await loadPolars()
  setMessage(`Copied as '${newId}'`)
}

async function deletePolar(id) {
  if (!window.confirm(`Delete polar '${id}'?`)) return
  await api(`polars/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await loadPolars()
  await loadActiveStatus()
  setMessage(`Deleted '${id}'`)
}

// ── Import page ────────────────────────────────────────────────────────────────
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

// The server auto-detects the format, so no format picker is offered.
async function importPolarText(content) {
  const { id } = await api('imports/text/auto', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
  })
  return id
}

function buildImportPage() {
  const wrap = document.createElement('div')

  // --- Import from file ---
  const fileCard = cardEl('Import from file')
  wrap.appendChild(fileCard.card)
  const fileFormWrap = document.createElement('div')
  fileFormWrap.innerHTML = `
    <div class="form-group mb-2">
      <label>File</label>
      <input type="file" id="fileImportFile" class="form-control form-control-sm">
      <div class="form-text small text-muted">Canonical JSON, Jieter or Expedition — the format is detected automatically.</div>
    </div>
  `
  fileCard.body.appendChild(fileFormWrap)
  const fileImportBtn = document.createElement('button')
  fileImportBtn.className = 'btn btn-primary btn-sm'
  fileImportBtn.textContent = 'Import'
  fileImportBtn.addEventListener('click', async () => {
    const file = fileFormWrap.querySelector('#fileImportFile').files[0]
    if (!file) { lastFileImportError = 'Choose a file to import'; await rerender(); return }
    try {
      const id = await importPolarText(await readFileAsText(file))
      lastFileImportError = ''
      await loadPolars()
      setMessage(`Imported as '${id}'`)
    } catch (e) {
      lastFileImportError = e.message
    }
    await rerender()
  })
  fileCard.body.appendChild(fileImportBtn)
  fileCard.body.appendChild(warningsSection(lastFileImportError ? [lastFileImportError] : []))

  // --- Import from text ---
  const textCard = cardEl('Import from text')
  wrap.appendChild(textCard.card)
  const textFormWrap = document.createElement('div')
  textFormWrap.innerHTML = `
    <div class="form-group mb-2">
      <label>Text</label>
      <textarea id="textImportText" class="form-control form-control-sm" rows="6"></textarea>
      <div class="form-text small text-muted">Canonical JSON, Jieter or Expedition — the format is detected automatically.</div>
    </div>
  `
  textCard.body.appendChild(textFormWrap)
  const textImportBtn = document.createElement('button')
  textImportBtn.className = 'btn btn-primary btn-sm'
  textImportBtn.textContent = 'Import'
  textImportBtn.addEventListener('click', async () => {
    const content = textFormWrap.querySelector('#textImportText').value
    if (!content || !content.trim()) { lastTextImportError = 'Paste polar text first'; await rerender(); return }
    try {
      const id = await importPolarText(content)
      lastTextImportError = ''
      await loadPolars()
      setMessage(`Imported as '${id}'`)
    } catch (e) {
      lastTextImportError = e.message
    }
    await rerender()
  })
  textCard.body.appendChild(textImportBtn)
  textCard.body.appendChild(warningsSection(lastTextImportError ? [lastTextImportError] : []))

  // --- Import from ORC ---
  const orcCard = cardEl('Import from ORC')
  wrap.appendChild(orcCard.card)

  const orcTermsLink = document.createElement('p')
  orcTermsLink.className = 'mb-2'
  orcTermsLink.innerHTML = '<a href="https://orc.org/offshore-racing-congress---website-terms-of-use" target="_blank" rel="noopener noreferrer">ORC terms of use</a>'
  orcCard.body.appendChild(orcTermsLink)

  const searchRow = document.createElement('div')
  searchRow.className = 'input-group mb-2'
  searchRow.style.maxWidth = '28rem'
  searchRow.innerHTML = `
    <input type="text" id="orcQuery" class="form-control form-control-sm" placeholder="Sail number, yacht name...">
    <button id="orcSearchBtn" class="btn btn-secondary btn-sm">Search</button>
  `
  const queryEl = searchRow.querySelector('#orcQuery')
  const searchBtn = searchRow.querySelector('#orcSearchBtn')
  queryEl.value = orcQuery
  queryEl.disabled = !internetStatus.online
  searchBtn.disabled = !internetStatus.online
  orcCard.body.appendChild(searchRow)

  const orcResultsEl = document.createElement('div')
  orcResultsEl.id = 'orc-results'
  orcCard.body.appendChild(orcResultsEl)

  function renderOrcResults() {
    if (orcResults === null) { orcResultsEl.innerHTML = ''; return }
    if (!orcResults.length) {
      orcResultsEl.innerHTML = '<div class="text-muted small">No matching certificates.</div>'
      return
    }
    orcResultsEl.innerHTML = `
      <table class="table table-sm mb-0">
        <tbody>
          ${orcResults.map(r => `
            <tr>
              <td>${escapeHtml(r.name)}</td>
              <td class="text-muted">${escapeHtml(r.sailnumber || '')}</td>
              <td class="text-muted">${escapeHtml(r.boatType || '')}</td>
              <td class="text-muted">${escapeHtml(r.year || '')}</td>
              <td><button class="btn btn-link btn-sm" data-action="orc-import" data-external-id="${escapeHtml(r.externalId)}">Import</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `
  }
  renderOrcResults()

  async function runOrcSearch() {
    orcQuery = queryEl.value
    try {
      orcResults = await api(`imports/sources/orc/search?q=${encodeURIComponent(orcQuery)}`)
      lastOrcImportError = ''
      // A successful search means the certificate cache is now populated.
      await loadOrcSourceStatus()
    } catch (e) {
      orcResults = null
      lastOrcImportError = e.message
    }
    await rerender()
  }

  searchBtn.addEventListener('click', () => runOrcSearch())
  queryEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runOrcSearch() }
  })
  // Editing the query invalidates the displayed results, but keeps them until then.
  queryEl.addEventListener('input', () => {
    orcQuery = queryEl.value
    if (orcResults === null) return
    orcResults = null
    renderOrcResults()
  })

  orcResultsEl.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action="orc-import"]')
    if (!target) return
    try {
      const { id } = await api(`imports/sources/orc/items/${encodeURIComponent(target.dataset.externalId)}`, { method: 'POST' })
      lastOrcImportError = ''
      await loadPolars()
      setMessage(`Imported as '${id}' from ORC`)
    } catch (e) {
      lastOrcImportError = e.message
    }
    await rerender()
  })

  const orcWarnings = []
  if (!internetStatus.online) orcWarnings.push('No internet connection — ORC import is unavailable.')
  else if (!orcCached) orcWarnings.push('No current cache — the first search may be slow.')
  if (lastOrcImportError) orcWarnings.push(lastOrcImportError)
  orcCard.body.appendChild(warningsSection(orcWarnings))

  return wrap
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const isMobile = () => window.matchMedia('(max-width: 767.98px)').matches

  document.querySelectorAll('#main-nav .nav-link').forEach(link =>
    link.addEventListener('click', (e) => {
      e.preventDefault()
      switchPage(link.dataset.page)
      if (isMobile()) document.body.classList.remove('sidebar-mobile-show')
    })
  )
  document.getElementById('sidebarMinimizer').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-minimized')
    document.body.classList.toggle('brand-minimized')
  })
  document.getElementById('sidebarToggler').addEventListener('click', () => {
    if (isMobile()) {
      document.body.classList.toggle('sidebar-mobile-show')
    } else {
      document.body.classList.toggle('sidebar-hidden')
    }
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.dropdown')) {
      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'))
    }
  })

  try {
    await loadAll()
  } catch (e) {
    setMessage(e.message, true)
  }
  switchPage('active')
}

init()
