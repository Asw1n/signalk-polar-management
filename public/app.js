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

function showImportSuccessDialog(id) {
  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop fade show'

  const modal = document.createElement('div')
  modal.className = 'modal fade show'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-labelledby', 'importSuccessTitle')
  modal.tabIndex = -1
  modal.style.display = 'block'
  modal.innerHTML = `
    <div class="modal-dialog modal-dialog-centered" role="document">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title" id="importSuccessTitle">Import successful</h5>
        </div>
        <div class="modal-body">
          <p class="mb-0">The polar <strong>${escapeHtml(id)}</strong> was imported successfully.</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-primary btn-sm" data-action="close-import-success">Close</button>
        </div>
      </div>
    </div>
  `

  const close = () => {
    document.body.classList.remove('modal-open')
    modal.remove()
    backdrop.remove()
    document.removeEventListener('keydown', onKeyDown)
  }
  const onKeyDown = event => {
    if (event.key === 'Escape') close()
  }

  modal.addEventListener('click', event => {
    if (event.target === modal || event.target.closest('[data-action="close-import-success"]')) close()
  })
  backdrop.addEventListener('click', close)
  document.addEventListener('keydown', onKeyDown)
  document.body.classList.add('modal-open')
  document.body.append(backdrop, modal)
  modal.querySelector('[data-action="close-import-success"]').focus()
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
let activeStatus = { id: null, sailplanId: null, exists: false, valid: false, errors: [] }
let performanceFactor = 1
let applyWaveCorrection = true
let internetStatus = { online: false }
let orcCached = false
let lastFileImportError = ''
let lastTextImportError = ''
let lastOrcImportError = ''
let orcQuery = ''
let orcResults = null // null = no search run yet
let activePage = 'active'
let polarSort = { key: 'name', direction: 'asc' }
// V2 rows whose sailplan sub-rows are shown in the selection table.
const expandedPolars = new Set()
let canvasObserver = null
const curveRequests = new WeakMap()

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
      ${sortedPolars().map(polar => {
        const v2 = polar.kind === 'polarSet'
        const expanded = selectable && v2 && expandedPolars.has(polar.id)
        const cells = POLAR_COLUMNS.map((column, index) => `<td>${
          index === 0 && selectable
            ? (v2
              ? `<button type="button" class="btn btn-link btn-sm p-0 text-reset text-decoration-none polar-expand" data-expand="${escapeHtml(polar.id)}" aria-expanded="${expanded}" aria-label="${expanded ? 'Hide' : 'Show'} sailplans">${expanded ? '&#9662;' : '&#9656;'}</button>${escapeHtml(column.value(polar))}`
              : `<span class="polar-expand"></span>${escapeHtml(column.value(polar))}`)
            : escapeHtml(column.value(polar))
        }</td>`).join('')
        const sailplanRows = expanded
          ? (polar.tables || []).map(choice => {
            const sailplanId = choice.id ?? ''
            const checked = polar.id === activeStatus.id && (activeStatus.sailplanId || '') === sailplanId
            return `
        <tr class="sailplan-row">
          <td></td>
          <td colspan="${POLAR_COLUMNS.length}" class="sailplan-cell"><label><input type="radio" name="activeSailplanRadio" data-polar-id="${escapeHtml(polar.id)}" data-sailplan-id="${escapeHtml(sailplanId)}" ${checked ? 'checked' : ''}>${escapeHtml(choice.name)}${choice.id === undefined ? '<span class="text-muted small"> (default)</span>' : ''}</label></td>
        </tr>`
          }).join('')
          : ''
        return `
        <tr>
          ${selectable ? `<td><input type="radio" name="activePolarRadio" data-id="${escapeHtml(polar.id)}" ${polar.id === activeStatus.id ? 'checked' : ''}></td>` : ''}
          ${cells}
          ${actions ? `
            <td class="polar-actions">
              <button class="btn btn-link btn-sm" data-action="open" data-id="${escapeHtml(polar.id)}">Open</button>
              <button class="btn btn-link btn-sm" data-action="copy" data-id="${escapeHtml(polar.id)}">Copy</button>
              <button class="btn btn-link btn-sm text-danger" data-action="delete" data-id="${escapeHtml(polar.id)}">Delete</button>
            </td>
          ` : ''}
        </tr>${sailplanRows}`
      }).join('')}
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
  table.querySelectorAll('[data-expand]').forEach(button => {
    button.addEventListener('click', () => {
      const id = button.dataset.expand
      if (expandedPolars.has(id)) expandedPolars.delete(id)
      else expandedPolars.add(id)
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

async function loadWaveCorrection() {
  const { apply } = await api('waveCorrection')
  applyWaveCorrection = apply !== false
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
    loadWaveCorrection(), loadInternetStatus(), loadOrcSourceStatus()
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
    const curveError = document.createElement('p')
    curveError.className = 'text-danger small'
    curveError.setAttribute('role', 'status')
    colGraph.appendChild(curveError)
    const canvasInstance = new window.PolarCanvas(canvas)
    observeCanvasSize(canvas, canvasInstance)
    // The graph always shows the shared selection, uncorrected: no performance
    // factor and no wave correction are applied to it.
    loadOverviewCurves(activeStatus.id, canvasInstance, activeStatus.sailplanId || undefined, curveError)
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
      ['Format', activePolar.kind === 'polarSet' ? `v2 polarSet (${activePolar.schemaVersion})` : 'v1 polarTable'],
      ['Sailplan', activePolar.kind === 'polarSet'
        ? (activePolar.tables?.find(choice => (choice.id ?? null) === (activeStatus.sailplanId ?? null))?.name || activeStatus.sailplanId)
        : undefined],
      ['Sailplans', activePolar.kind === 'polarSet' ? String(Math.max((activePolar.tables?.length || 1) - 1, 0)) : undefined],
      ['Wave correction', activePolar.kind === 'polarSet' ? (activePolar.hasWaveCorrection ? 'Included' : 'Not included') : undefined],
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

  const warnings = []
  if (!activeStatus.id) {
    warnings.push('No active polar is selected.')
  } else if (!activeStatus.exists) {
    warnings.push(`Configured active polar '${activeStatus.id}' was not found.`)
  } else if (!activeStatus.valid) {
    warnings.push(...activeStatus.errors)
  }
  colDetails.appendChild(warningsSection(warnings))

  // --- Adjustments card ---
  // Shared consumer settings; they never change the graph above.
  const adjustments = cardEl('Adjustments')
  wrap.appendChild(adjustments.card)
  const adjIntro = document.createElement('p')
  adjIntro.className = 'text-muted small'
  adjIntro.textContent = 'Shared with all polar consumers. The graph shows the uncorrected polar: neither adjustment changes it.'
  adjustments.body.appendChild(adjIntro)

  const factorLabel = document.createElement('label')
  factorLabel.className = 'small'
  factorLabel.setAttribute('for', 'performanceFactor')
  factorLabel.textContent = 'Performance factor'
  adjustments.body.appendChild(factorLabel)
  const adjWrap = document.createElement('div')
  adjWrap.className = 'input-group'
  adjWrap.style.maxWidth = '14rem'
  adjWrap.innerHTML = `
    <input type="number" id="performanceFactor" class="form-control form-control-sm" min="0" max="100" step="1" value="${Math.round(performanceFactor * 100)}">
    <span class="input-group-text">%</span>
  `
  adjustments.body.appendChild(adjWrap)
  // Applied automatically on change (blur, Enter or spinner) — no Save button.
  adjWrap.querySelector('#performanceFactor').addEventListener('change', async (event) => {
    const percent = Number(event.target.value)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      setMessage('Enter a performance factor from 0 to 100%', true)
      event.target.value = Math.round(performanceFactor * 100)
      return
    }
    try {
      const { value } = await api('performanceFactor', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: percent / 100 })
      })
      performanceFactor = value
      setMessage(`Polar adjustment set to ${Math.round(performanceFactor * 100)}%`)
    } catch (e) {
      setMessage(e.message, true)
      event.target.value = Math.round(performanceFactor * 100)
    }
  })

  const waveWrap = document.createElement('div')
  const activeHasWaves = !!(activePolar && activePolar.kind === 'polarSet' && activePolar.hasWaveCorrection)
  waveWrap.className = 'mt-3' + (activeHasWaves ? '' : ' wave-unavailable')
  waveWrap.innerHTML = `
    <label class="small d-block" for="applyWaveCorrection">Wave correction</label>
    <label class="switch switch-text switch-primary mb-0">
      <input type="checkbox" id="applyWaveCorrection" class="switch-input form-check-input" ${applyWaveCorrection ? 'checked' : ''} ${activeHasWaves ? '' : 'disabled'}>
      <span class="switch-label" data-on="On" data-off="Off"></span>
      <span class="switch-handle"></span>
    </label>
    <div class="form-text small text-muted">${activeHasWaves
      ? 'Apply the active polar\u2019s wave correction when consumers supply sea state.'
      : 'The active polar has no wave correction table; this setting has no effect on it.'}</div>
  `
  adjustments.body.appendChild(waveWrap)
  waveWrap.querySelector('#applyWaveCorrection').addEventListener('change', async (event) => {
    try {
      const { apply } = await api('waveCorrection', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply: event.target.checked })
      })
      applyWaveCorrection = apply
      setMessage(`Wave correction ${apply ? 'enabled' : 'disabled'}`)
    } catch (e) {
      setMessage(e.message, true)
      event.target.checked = applyWaveCorrection
    }
  })

  // --- Polar selection card ---
  const selection = cardEl('Select active polar')
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
      const { name } = event.target
      if (name !== 'activePolarRadio' && name !== 'activeSailplanRadio') return
      // A polar radio selects the document with the default (best) sailplan; a
      // sailplan radio selects document and sailplan in one atomic request.
      const id = name === 'activePolarRadio' ? event.target.dataset.id : event.target.dataset.polarId
      const sailplanId = name === 'activeSailplanRadio' ? event.target.dataset.sailplanId : ''
      try {
        const polar = polarById(id)
        const v2 = polar?.kind === 'polarSet'
        await api('activePolar', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, ...(sailplanId ? { sailplanId } : {}), ...(v2 ? { acknowledgeV2: true } : {}) })
        })
        await loadActiveStatus()
        if (v2) expandedPolars.add(id)
        const sailplanName = sailplanId
          ? polar?.tables?.find(choice => choice.id === sailplanId)?.name || sailplanId
          : ''
        setMessage(`Active polar set to '${id}'${sailplanName ? ` \u2014 ${sailplanName}` : ''}`)
        await rerender()
      } catch (e) {
        setMessage(e.message, true)
        await rerender()
      }
    })
  }

  return wrap
}

async function loadOverviewCurves(id, canvas, sailplanId, errorEl) {
  const request = {}
  curveRequests.set(canvas, request)
  canvas.loadCurves({ curves: [] })
  if (errorEl) errorEl.textContent = ''
  try {
    const selection = sailplanId === undefined ? '' : `&sailplanId=${encodeURIComponent(sailplanId)}`
    const curves = await api(`polars/${encodeURIComponent(id)}/curves?step=5${selection}`)
    if (curveRequests.get(canvas) === request) canvas.loadCurves(curves)
  } catch (e) {
    if (curveRequests.get(canvas) !== request) return
    if (errorEl) errorEl.textContent = e.message
    else setMessage(e.message, true)
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
  stored.body.appendChild(warningsSection(polars.filter(polar => polar.error).map(polar => `${polar.id}: ${polar.error}`)))

  table.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    const { action, id } = target.dataset
    try {
      if (action === 'open') {
        await showPolarDocument(id)
        return
      }
      if (action === 'copy') await copyPolar(id)
      if (action === 'delete') await deletePolar(id)
      await rerender()
    } catch (e) {
      setMessage(e.message, true)
    }
  })

  return wrap
}

// ── Open document view ─────────────────────────────────────────────────────────
// One card for everything about a stored polar: editable metadata, table
// display/export, sailplan editing (v2), wave correction (v2) and the
// complete-document export.
async function showPolarDocument(polarId) {
  let documentBody
  try {
    documentBody = await api(`polars/${encodeURIComponent(polarId)}`)
  } catch (e) {
    setMessage(e.message, true)
    return
  }
  const v2 = documentBody.kind === 'polarSet'
  const reopen = async (id = polarId) => {
    await Promise.all([loadPolars(), loadActiveStatus(), loadWaveCorrection()])
    await showPolarDocument(id)
  }
  const view = cardEl(`Polar \u2014 ${documentBody.name || polarId}`)
  const body = view.body

  // --- Metadata ---
  body.appendChild(sectionHeading('Metadata'))
  const info = document.createElement('p')
  info.className = 'small text-muted'
  info.textContent = [
    v2 ? `Format: v2 polarSet (${documentBody.schemaVersion})` : 'Format: v1 polarTable',
    documentBody.source ? `Source: ${documentBody.source}` : ''
  ].filter(Boolean).join(' \u2022 ')
  body.appendChild(info)
  const metaForm = document.createElement('form')
  metaForm.innerHTML = `
    <fieldset>
      <div class="row">
        ${POLAR_COLUMNS.filter(column => column.key !== 'source').map(column => `
          <div class="col-md-6 mb-3">
            <label class="small" for="meta-${column.key}">${column.label}</label>
            <input class="form-control form-control-sm" id="meta-${column.key}" name="${column.key}"
              type="${column.key === 'year' ? 'number' : 'text'}"
              ${column.key === 'year' ? 'step="1"' : ''}
              ${column.key === 'id' ? 'required maxlength="100"' : ''}
              value="${escapeHtml((column.key === 'id' ? polarId : documentBody[column.key]) ?? '')}">
          </div>
        `).join('')}
        <div class="col-md-6 mb-3">
          <label class="small" for="meta-notes">Notes</label>
          <input class="form-control form-control-sm" id="meta-notes" name="notes" type="text"
            value="${escapeHtml(documentBody.notes ?? '')}">
        </div>
      </div>
      <div class="alert alert-danger small" role="alert" hidden></div>
      <button type="submit" class="btn btn-primary btn-sm">Save metadata</button>
    </fieldset>
  `
  metaForm.addEventListener('submit', async event => {
    event.preventDefault()
    if (!metaForm.reportValidity()) return
    const fieldset = metaForm.querySelector('fieldset')
    const error = metaForm.querySelector('[role="alert"]')
    const metadata = Object.fromEntries(new FormData(metaForm))
    metadata.year = metadata.year === '' ? null : Number(metadata.year)
    error.hidden = true
    fieldset.disabled = true
    try {
      const { id } = await api(`polars/${encodeURIComponent(polarId)}/metadata`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata)
      })
      setMessage(`Saved '${id}'`)
      await reopen(id)
    } catch (e) {
      error.textContent = e.message
      error.hidden = false
      fieldset.disabled = false
    }
  })
  body.appendChild(metaForm)

  // --- Tables ---
  body.appendChild(sectionHeading('Tables'))
  const choices = v2
    ? [{ name: 'Best performance', table: documentBody.best }, ...(documentBody.sailplans || [])]
    : [{ name: 'Polar table', table: documentBody }]
  const tables = document.createElement('div')
  tables.innerHTML = `
    ${v2 ? `
    <label for="docTable">Table</label>
    <div class="d-flex align-items-center mb-1">
      <select id="docTable" class="form-select form-select-sm" style="max-width:20rem">
        ${choices.map((choice, index) => `<option value="${index}">${escapeHtml(choice.name)}</option>`).join('')}
      </select>
      <button class="btn btn-danger btn-sm ms-2" data-table-delete hidden>Delete</button>
    </div>
    <p data-table-error class="text-danger small" role="alert"></p>` : ''}
    <div data-sailplan-editor class="mb-2"></div>
    <div class="row"><div class="col-md-5 col-lg-4"><canvas class="polar-canvas"></canvas></div></div>
    <div data-curve-error class="text-danger small" role="status"></div>
    <div data-table></div>
    <h6 class="mt-3">Export selected table</h6>
    <p class="small">Exports only the boat speeds of the selected table.</p>
    <select data-export-format class="form-select form-select-sm mb-2" aria-label="Selected-table export format">
      <option value="expedition">Expedition text</option>
      <option value="jieter">Jieter text</option>
      <option value="json-v1">Canonical v1 table${v2 ? ' (lossy projection)' : ''}</option>
    </select>
    <div><button class="btn btn-primary btn-sm" data-export-table>Export selected table</button></div>
    <p data-export-error class="text-danger small mt-2" role="alert"></p>
    ${v2 ? `
    <h6 class="mt-3">Add sailplan specific table</h6>
    <div class="row">
      <div class="col-md-4 mb-2"><input data-sailplan-name class="form-control form-control-sm" placeholder="Sailplan name" aria-label="New sailplan name"></div>
      <div class="col-md-5 mb-2"><input type="file" data-sailplan-file class="form-control form-control-sm" aria-label="Single-table polar file"></div>
      <div class="col-md-3 mb-2"><button class="btn btn-primary btn-sm" data-sailplan-add>Add sailplan</button></div>
    </div>
    <p class="form-text small text-muted">Single-table formats (canonical v1 JSON, Jieter, Expedition, TimeZero) are detected automatically; the table keeps its own wind grid.</p>
    <p data-sailplan-error class="text-danger small" role="alert"></p>` : ''}
  `
  body.appendChild(tables)
  const select = tables.querySelector('#docTable')
  const selectedIndex = () => (select ? Number(select.value) : 0)
  const canvas = new window.PolarCanvas(tables.querySelector('canvas'))
  let generation = 0

  const renderSailplanEditor = () => {
    const editor = tables.querySelector('[data-sailplan-editor]')
    const choice = choices[selectedIndex()]
    if (!v2 || choice.id === undefined) {
      editor.innerHTML = ''
      return
    }
    editor.innerHTML = `
      <div class="row align-items-end">
        <div class="col-md-3 mb-2"><label class="small" for="sp-id">Sailplan ID</label>
          <input id="sp-id" data-sp-id class="form-control form-control-sm" value="${escapeHtml(choice.id)}"></div>
        <div class="col-md-3 mb-2"><label class="small" for="sp-name">Name</label>
          <input id="sp-name" data-sp-name class="form-control form-control-sm" value="${escapeHtml(choice.name)}"></div>
        <div class="col-md-4 mb-2"><label class="small" for="sp-notes">Notes</label>
          <input id="sp-notes" data-sp-notes class="form-control form-control-sm" value="${escapeHtml(choice.notes ?? '')}"></div>
        <div class="col-md-2 mb-2">
          <button class="btn btn-primary btn-sm" data-sp-save>Save</button>
        </div>
      </div>
      <p data-sp-error class="text-danger small" role="alert"></p>
    `
    editor.querySelector('[data-sp-save]').addEventListener('click', async () => {
      const payload = {
        id: editor.querySelector('[data-sp-id]').value.trim(),
        name: editor.querySelector('[data-sp-name]').value.trim(),
        notes: editor.querySelector('[data-sp-notes]').value
      }
      try {
        await api(`polars/${encodeURIComponent(polarId)}/sailplans/${encodeURIComponent(choice.id)}/metadata`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        })
        setMessage(`Saved sailplan '${payload.id}'`)
        await reopen()
      } catch (e) {
        editor.querySelector('[data-sp-error]').textContent = e.message
      }
    })
  }

  const render = async () => {
    const current = ++generation
    const choice = choices[selectedIndex()]
    const table = choice.table
    const number = (value, factor = 1, digits = 2) => value === null || value === undefined ? '-' : (value * factor).toFixed(digits)
    const knots = 3600 / 1852
    const degrees = 180 / Math.PI
    const quantities = [['boatSpeedMatrix', 'Boat speed (kn)', knots], ['heelMatrix', 'Heel (deg)', degrees], ['reefMatrix', 'Reef factor', 1], ['flatMatrix', 'Flat factor', 1]]
    tables.querySelector('[data-table]').innerHTML = `
      ${choice.sails ? `<p class="small">${choice.sails.map(sail => escapeHtml(`${sail.name}${sail.sourceId ? ` / source ${sail.sourceId}` : ''}${sail.area ? ` / ${sail.area} m2` : ''}`)).join('; ')}</p>` : ''}
      ${quantities.filter(([key]) => table.values[key]).map(([key, title, factor]) => `
        <h6 class="mt-3">${title}</h6><div class="table-responsive"><table class="table table-sm">
        <thead><tr><th>TWS (kn) / TWA (deg)</th>${table.axes.twa.map(twa => `<th>${number(twa, degrees, 1)}</th>`).join('')}</tr></thead>
        <tbody>${table.axes.tws.map((tws, row) => `<tr><th>${number(tws, knots)}</th>${table.values[key][row].map(value => `<td>${number(value, factor, key === 'reefMatrix' || key === 'flatMatrix' ? 4 : 2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('')}
      <h6>Supplied targets (not recalculated from the grid)</h6>
      <div class="table-responsive"><table class="table table-sm"><thead><tr><th>TWS (kn)</th><th>Role</th><th>TWA (deg)</th><th>Speed (kn)</th><th>VMG magnitude (kn)</th><th>Heel (deg)</th><th>Reef</th><th>Flat</th></tr></thead>
      <tbody>${(table.derived?.rows || []).flatMap(row => ['beat', 'run'].map(role => {
        const target = row[role]
        return `<tr><th>${number(row.tws, knots)}</th><td>${role}</td><td>${number(target?.twa, degrees)}</td><td>${number(target?.tbs, knots)}</td><td>${number(target?.vmg, knots)}</td><td>${number(target?.heel, degrees)}</td><td>${number(target?.reef, 1, 4)}</td><td>${number(target?.flat, 1, 4)}</td></tr>`
      })).join('')}</tbody></table></div>`
    renderSailplanEditor()
    const deleteButton = tables.querySelector('[data-table-delete]')
    if (deleteButton) deleteButton.hidden = choice.id === undefined
    const errorEl = tables.querySelector('[data-curve-error]')
    errorEl.textContent = ''
    canvas.loadCurves({ curves: [] })
    try {
      const selection = choice.id === undefined ? '' : `&sailplanId=${encodeURIComponent(choice.id)}`
      const result = await api(`polars/${encodeURIComponent(polarId)}/curves?step=5${selection}`)
      if (current === generation) canvas.loadCurves(result)
    } catch (error) {
      if (current === generation) errorEl.textContent = error.message
    }
  }
  select?.addEventListener('change', render)

  tables.querySelector('[data-table-delete]')?.addEventListener('click', async () => {
    const choice = choices[selectedIndex()]
    if (choice.id === undefined) return
    const errorEl = tables.querySelector('[data-table-error]')
    errorEl.textContent = ''
    if (!window.confirm(`Delete sailplan '${choice.name}'?`)) return
    try {
      await api(`polars/${encodeURIComponent(polarId)}/sailplans/${encodeURIComponent(choice.id)}`, { method: 'DELETE' })
      setMessage(`Deleted sailplan '${choice.name}'`)
      await reopen()
    } catch (e) {
      errorEl.textContent = e.message
    }
  })

  tables.querySelector('[data-export-table]').addEventListener('click', async () => {
    const errorEl = tables.querySelector('[data-export-error]')
    errorEl.textContent = ''
    const format = tables.querySelector('[data-export-format]').value
    const choice = choices[selectedIndex()]
    const query = new URLSearchParams({ scope: 'table', acknowledgeLoss: 'true' })
    if (choice.id !== undefined) query.set('sailplanId', choice.id)
    try {
      const text = await api(`polars/${encodeURIComponent(polarId)}/export/${format}?${query}`)
      const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text, null, 2)], { type: format === 'json-v1' ? 'application/json' : 'text/plain' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${polarId}-${selectedIndex()}.${format === 'json-v1' ? 'json' : 'txt'}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      errorEl.textContent = error.message
    }
  })

  tables.querySelector('[data-sailplan-add]')?.addEventListener('click', async () => {
    const errorEl = tables.querySelector('[data-sailplan-error]')
    errorEl.textContent = ''
    const name = tables.querySelector('[data-sailplan-name]').value.trim()
    const file = tables.querySelector('[data-sailplan-file]').files[0]
    if (!name) { errorEl.textContent = 'Enter a sailplan name.'; return }
    if (!file) { errorEl.textContent = 'Choose a single-table polar file.'; return }
    try {
      const content = await readFileAsText(file)
      const { id } = await api(`polars/${encodeURIComponent(polarId)}/sailplans`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, name })
      })
      setMessage(`Added sailplan '${id}'`)
      await reopen()
    } catch (e) {
      errorEl.textContent = e.message
    }
  })

  // --- Wave correction (v2 only) ---
  if (v2) {
    body.appendChild(sectionHeading('Wave correction'))
    const wave = document.createElement('div')
    const current = documentBody.waveCorrection
    const summary = current
      ? (() => {
        const heights = current.heights.map(layer => layer.significantWaveHeight)
        const periods = current.heights.flatMap(layer => layer.axes.wavePeriod)
        return `${current.heights.length} height layer(s), ${Math.min(...heights)}\u2013${Math.max(...heights)} m, wave periods ${Math.min(...periods)}\u2013${Math.max(...periods)} s.`
      })()
      : 'No wave correction table available.'
    wave.innerHTML = `
      <p class="small mb-2">${escapeHtml(summary)}</p>
      <div class="row">
        <div class="col-md-5 mb-2"><input type="file" data-wave-file class="form-control form-control-sm" aria-label="Wave correction file"></div>
        <div class="col-md-7 mb-2">
          <button class="btn btn-primary btn-sm" data-wave-import>Import${current ? ' (replace)' : ''}</button>
          ${current ? `<button class="btn btn-primary btn-sm" data-wave-export>Export JSON</button>
          <button class="btn btn-link btn-sm text-danger" data-wave-delete>Remove</button>` : ''}
        </div>
      </div>
      <p class="form-text small text-muted">TimeZero Wave_Polar.xml or a canonical JSON fragment, detected automatically. Import replaces the whole correction; missing factors are never filled.</p>
      <p data-wave-error class="text-danger small" role="alert"></p>
    `
    body.appendChild(wave)
    wave.querySelector('[data-wave-import]').addEventListener('click', async () => {
      const errorEl = wave.querySelector('[data-wave-error]')
      errorEl.textContent = ''
      const file = wave.querySelector('[data-wave-file]').files[0]
      if (!file) { errorEl.textContent = 'Choose a wave-correction file.'; return }
      try {
        const content = await readFileAsText(file)
        const { heights } = await api(`polars/${encodeURIComponent(polarId)}/waveCorrection/import`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
        })
        setMessage(`Imported wave correction (${heights} height layers)`)
        await reopen()
      } catch (e) {
        errorEl.textContent = e.message
      }
    })
    wave.querySelector('[data-wave-export]')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ waveCorrection: current }, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${polarId}-wave-correction.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
    wave.querySelector('[data-wave-delete]')?.addEventListener('click', async () => {
      if (!window.confirm('Remove the wave correction from this polar?')) return
      try {
        await api(`polars/${encodeURIComponent(polarId)}/waveCorrection`, { method: 'DELETE' })
        setMessage('Wave correction removed')
        await reopen()
      } catch (e) {
        wave.querySelector('[data-wave-error]').textContent = e.message
      }
    })
  }

  // --- Document ---
  body.appendChild(sectionHeading('Document'))
  const footer = document.createElement('div')
  footer.innerHTML = `
    <a class="btn btn-primary btn-sm" href="${BASE}/polars/${encodeURIComponent(polarId)}/export/json" download>Export complete canonical JSON</a>
    <button class="btn btn-primary btn-sm ms-2" data-close-view>Close</button>
  `
  footer.querySelector('[data-close-view]').addEventListener('click', () => rerender())
  body.appendChild(footer)

  document.getElementById('card-body').replaceChildren(view.card)
  observeCanvasSize(tables.querySelector('canvas'), canvas)
  await render()
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
// Decodes an uploaded file as text. Some sources (e.g. TimeZero) write UTF-16
// with or without a BOM despite their declared encodings; plain UTF-8 decoding
// would NUL-pad every character and break format detection.
async function readFileAsText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let encoding = 'utf-8'
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
    else if (bytes[0] !== 0 && bytes[1] === 0) encoding = 'utf-16le'
    else if (bytes[0] === 0 && bytes[1] !== 0) encoding = 'utf-16be'
  }
  return new TextDecoder(encoding).decode(bytes)
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
      <div class="form-text small text-muted">Canonical v1/v2 JSON, Jieter, Expedition, TimeZero Wind_Polar.xml or ORC speed-guide HTML — detected automatically. ORC HTML imports v2; exact 0.01-knot ORC placeholders become unavailable, not real targets.</div>
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
      await rerender()
      showImportSuccessDialog(id)
      return
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
      <div class="form-text small text-muted">Canonical v1/v2 JSON, Jieter, Expedition, TimeZero Wind_Polar.xml or ORC speed-guide HTML — detected automatically. Standalone SYLK is not supported.</div>
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
      await rerender()
      showImportSuccessDialog(id)
      return
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
      await rerender()
      showImportSuccessDialog(id)
      return
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

  try {
    await loadAll()
    if (activeStatus.id && polarById(activeStatus.id)?.kind === 'polarSet') {
      expandedPolars.add(activeStatus.id)
    }
  } catch (e) {
    setMessage(e.message, true)
  }
  switchPage('active')
}

init()