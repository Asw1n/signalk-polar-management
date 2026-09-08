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
let importFormats = []
let internetStatus = { online: false }
let orcCached = false
let lastFileImportError = ''
let lastTextImportError = ''
let lastOrcImportError = ''
let validation = null // { id, valid, errors } — Management inspection results
let activePage = 'active'

function polarById(id) {
  return polars.find(p => p.id === id)
}

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadPolars() { polars = await api('polars') }
async function loadActiveStatus() { activeStatus = await api('activePolar') }

async function loadPerformanceFactor() {
  const { value } = await api('performanceFactor')
  performanceFactor = Number.isFinite(value) ? value : 1
}

async function loadImportFormats() { importFormats = await api('imports/formats') }
async function loadInternetStatus() { internetStatus = await api('internet') }

async function loadOrcSourceStatus() {
  const sources = await api('imports/sources')
  const orc = sources.find(s => s.id === 'orc')
  orcCached = !!(orc && orc.cached)
}

async function loadAll() {
  await Promise.all([
    loadPolars(), loadActiveStatus(), loadPerformanceFactor(),
    loadImportFormats(), loadInternetStatus(), loadOrcSourceStatus()
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

// Renders a 'Warnings' section heading + list, matching the Overview container.
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

  // --- Overview card ---
  const overview = cardEl('Overview')
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
    // Load curves after the element is attached and sized.
    setTimeout(() => loadOverviewCurves(activeStatus.id, canvasInstance), 0)
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
      ['Name', activePolar.name],
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

  // --- Active polar selection card ---
  const selection = cardEl('Active polar')
  wrap.appendChild(selection.card)

  if (!polars.length) {
    const empty = document.createElement('div')
    empty.className = 'text-muted small'
    empty.textContent = 'No stored polars. Import one from the Import page first.'
    selection.body.appendChild(empty)
  } else {
    const table = document.createElement('table')
    table.className = 'table table-sm table-borderless align-middle mb-0'
    table.innerHTML = `
      <tbody>
        ${polars.map(p => `
          <tr>
            <td style="width:2rem"><input type="radio" name="activePolarRadio" data-id="${escapeHtml(p.id)}" ${p.id === activeStatus.id ? 'checked' : ''}></td>
            <td>${escapeHtml(p.name || p.id)}</td>
            <td class="text-muted">${escapeHtml(p.boatType || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    `
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
    canvas.resize()
    canvas.loadCurves(curves)
  } catch (e) {
    setMessage(e.message, true)
  }
}

// ── Management page ───────────────────────────────────────────────────────────
function buildManagementPage() {
  const wrap = document.createElement('div')

  const stored = cardEl('Stored polars')
  wrap.appendChild(stored.card)

  const table = document.createElement('table')
  table.className = 'table table-sm table-borderless align-middle mb-0'
  table.innerHTML = `
    <thead>
      <tr>
        <th>Name</th><th>Boat type</th><th>Sail no.</th><th>Year</th><th>Source</th><th></th>
      </tr>
    </thead>
    <tbody>
      ${polars.map(p => `
        <tr>
          <td>${escapeHtml(p.name || p.id)}</td>
          <td>${escapeHtml(p.boatType || '')}</td>
          <td>${escapeHtml(p.sailnumber || '')}</td>
          <td>${escapeHtml(p.year || '')}</td>
          <td>${escapeHtml(p.source || '')}</td>
          <td class="polar-actions">
            <button class="btn btn-link btn-sm" data-action="rename" data-id="${escapeHtml(p.id)}">Rename</button>
            <button class="btn btn-link btn-sm" data-action="copy" data-id="${escapeHtml(p.id)}">Copy</button>
            <div class="dropdown d-inline">
              <button class="btn btn-link btn-sm dropdown-toggle" type="button" data-dropdown-toggle>Export</button>
              <div class="dropdown-menu dropdown-menu-right">
                <a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(p.id)}/export/json" download>Canonical JSON</a>
                <a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(p.id)}/export/jieter" download>Jieter text</a>
                <a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(p.id)}/export/expedition" download>Expedition text</a>
              </div>
            </div>
            <button class="btn btn-link btn-sm" data-action="validate" data-id="${escapeHtml(p.id)}">Validate</button>
            <button class="btn btn-link btn-sm text-danger" data-action="delete" data-id="${escapeHtml(p.id)}">Delete</button>
          </td>
        </tr>
      `).join('')}
    </tbody>
  `
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
      if (action === 'validate') await validatePolar(id)
      await rerender()
    } catch (e) {
      setMessage(e.message, true)
    }
  })

  // --- Validation results card ---
  const results = cardEl('Validation results')
  wrap.appendChild(results.card)
  if (!validation) {
    const empty = document.createElement('div')
    empty.className = 'text-muted small'
    empty.textContent = 'Click Validate on a stored polar to inspect it.'
    results.body.appendChild(empty)
  } else {
    const heading = document.createElement('div')
    heading.className = 'fw-semibold mb-2'
    heading.textContent = validation.id
    results.body.appendChild(heading)
    if (validation.valid) {
      const ok = document.createElement('div')
      ok.className = 'text-success small'
      ok.textContent = 'No issues found.'
      results.body.appendChild(ok)
    } else {
      const ul = document.createElement('ul')
      ul.className = 'text-danger small mb-0 ps-3'
      ul.innerHTML = validation.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')
      results.body.appendChild(ul)
    }
  }

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
  if (validation && validation.id === id) validation = null
  setMessage(`Deleted '${id}'`)
}

async function validatePolar(id) {
  const result = await api(`polars/${encodeURIComponent(id)}/validate`)
  validation = { id, ...result }
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

function buildImportPage() {
  const wrap = document.createElement('div')
  const formatOptions = importFormats.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('')

  // --- Import from file ---
  const fileCard = cardEl('Import from file')
  wrap.appendChild(fileCard.card)
  fileCard.body.appendChild(warningsSection(lastFileImportError ? [lastFileImportError] : []))
  const fileFormWrap = document.createElement('div')
  fileFormWrap.innerHTML = `
    <div class="form-group mb-2">
      <label>Format</label>
      <select id="fileImportFormat" class="form-select form-select-sm">${formatOptions}</select>
    </div>
    <div class="form-group mb-2">
      <label>File</label>
      <input type="file" id="fileImportFile" class="form-control form-control-sm">
    </div>
  `
  fileCard.body.appendChild(fileFormWrap)
  const fileImportBtn = document.createElement('button')
  fileImportBtn.className = 'btn btn-primary btn-sm'
  fileImportBtn.textContent = 'Import'
  fileImportBtn.disabled = !importFormats.length
  fileImportBtn.addEventListener('click', async () => {
    const format = fileFormWrap.querySelector('#fileImportFormat').value
    const file = fileFormWrap.querySelector('#fileImportFile').files[0]
    if (!file) { lastFileImportError = 'Choose a file to import'; await rerender(); return }
    try {
      const content = await readFileAsText(file)
      const { id } = await api(`imports/text/${encodeURIComponent(format)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
      })
      lastFileImportError = ''
      await loadPolars()
      setMessage(`Imported as '${id}'`)
      await rerender()
    } catch (e) {
      lastFileImportError = e.message
      await rerender()
    }
  })
  fileCard.body.appendChild(fileImportBtn)

  // --- Import from text ---
  const textCard = cardEl('Import from text')
  wrap.appendChild(textCard.card)
  textCard.body.appendChild(warningsSection(lastTextImportError ? [lastTextImportError] : []))
  const textFormWrap = document.createElement('div')
  textFormWrap.innerHTML = `
    <div class="form-group mb-2">
      <label>Format</label>
      <select id="textImportFormat" class="form-select form-select-sm">${formatOptions}</select>
    </div>
    <div class="form-group mb-2">
      <label>Text</label>
      <textarea id="textImportText" class="form-control form-control-sm" rows="6"></textarea>
    </div>
  `
  textCard.body.appendChild(textFormWrap)
  const textImportBtn = document.createElement('button')
  textImportBtn.className = 'btn btn-primary btn-sm'
  textImportBtn.textContent = 'Import'
  textImportBtn.disabled = !importFormats.length
  textImportBtn.addEventListener('click', async () => {
    const format = textFormWrap.querySelector('#textImportFormat').value
    const content = textFormWrap.querySelector('#textImportText').value
    if (!content || !content.trim()) { lastTextImportError = 'Paste polar text first'; await rerender(); return }
    try {
      const { id } = await api(`imports/text/${encodeURIComponent(format)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
      })
      lastTextImportError = ''
      await loadPolars()
      setMessage(`Imported as '${id}'`)
      await rerender()
    } catch (e) {
      lastTextImportError = e.message
      await rerender()
    }
  })
  textCard.body.appendChild(textImportBtn)

  // --- Import from ORC ---
  const orcCard = cardEl('Import from ORC')
  wrap.appendChild(orcCard.card)
  const orcWarnings = []
  if (!internetStatus.online) orcWarnings.push('No internet connection — ORC import is unavailable.')
  else if (!orcCached) orcWarnings.push('No current cache — the first search may be slow.')
  if (lastOrcImportError) orcWarnings.push(lastOrcImportError)
  orcCard.body.appendChild(warningsSection(orcWarnings))

  const searchRow = document.createElement('div')
  searchRow.className = 'input-group mb-2'
  searchRow.style.maxWidth = '28rem'
  searchRow.innerHTML = `
    <input type="text" id="orcQuery" class="form-control form-control-sm" placeholder="Sail number, yacht name...">
    <button id="orcSearchBtn" class="btn btn-secondary btn-sm">Search</button>
  `
  searchRow.querySelector('#orcQuery').disabled = !internetStatus.online
  searchRow.querySelector('#orcSearchBtn').disabled = !internetStatus.online
  orcCard.body.appendChild(searchRow)

  const orcResultsEl = document.createElement('div')
  orcResultsEl.id = 'orc-results'
  orcCard.body.appendChild(orcResultsEl)

  async function runOrcSearch() {
    const q = searchRow.querySelector('#orcQuery').value
    try {
      const results = await api(`imports/sources/orc/search?q=${encodeURIComponent(q)}`)
      orcResultsEl.innerHTML = `
        <table class="table table-sm mb-0">
          <tbody>
            ${results.map(r => `
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
      lastOrcImportError = ''
    } catch (e) {
      lastOrcImportError = e.message
      await rerender()
    }
  }

  searchRow.querySelector('#orcSearchBtn').addEventListener('click', () => runOrcSearch())
  searchRow.querySelector('#orcQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runOrcSearch() }
  })

  orcResultsEl.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action="orc-import"]')
    if (!target) return
    try {
      const { id } = await api(`imports/sources/orc/items/${encodeURIComponent(target.dataset.externalId)}`, { method: 'POST' })
      lastOrcImportError = ''
      await loadPolars()
      setMessage(`Imported as '${id}' from ORC`)
      await rerender()
    } catch (e) {
      lastOrcImportError = e.message
      await rerender()
    }
  })

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
