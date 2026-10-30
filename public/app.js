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
      ${sortedPolars().map(polar => `
        <tr>
          ${selectable ? `<td><input type="radio" name="activePolarRadio" data-id="${escapeHtml(polar.id)}" ${polar.id === activeStatus.id ? 'checked' : ''}></td>` : ''}
          ${POLAR_COLUMNS.map(column => `<td>${escapeHtml(column.value(polar))}</td>`).join('')}
          ${actions ? `
            <td class="polar-actions">
              <button class="btn btn-link btn-sm" data-action="preview" data-id="${escapeHtml(polar.id)}">View tables</button>
              <button class="btn btn-link btn-sm" data-action="modify" data-id="${escapeHtml(polar.id)}">Modify</button>
              <button class="btn btn-link btn-sm" data-action="copy" data-id="${escapeHtml(polar.id)}">Copy</button>
              <div class="dropdown d-inline">
                <button class="btn btn-link btn-sm dropdown-toggle" type="button" data-dropdown-toggle>Export</button>
                <div class="dropdown-menu dropdown-menu-right">
                  <a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(polar.id)}/export/json" download>Complete canonical JSON</a>
                  ${polar.kind === 'polarSet'
                    ? `<button class="dropdown-item" data-action="preview" data-id="${escapeHtml(polar.id)}">Selected table (lossy)...</button>`
                    : `<a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(polar.id)}/export/jieter" download>Jieter text</a>
                       <a class="dropdown-item" href="${BASE}/polars/${encodeURIComponent(polar.id)}/export/expedition" download>Expedition text</a>`}
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
    if (activePolar.kind === 'polarSet') {
      const label = document.createElement('label')
      label.textContent = 'Local display table (does not change the active document)'
      const select = document.createElement('select')
      select.className = 'form-select form-select-sm mb-2'
      select.innerHTML = activePolar.tables.map((choice, index) => `<option value="${index}">${escapeHtml(choice.name)}</option>`).join('')
      label.appendChild(select)
      colGraph.appendChild(label)
      select.addEventListener('change', () => {
        loadOverviewCurves(activeStatus.id, canvasInstance, activePolar.tables[Number(select.value)].id, curveError)
      })
    }
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
    loadOverviewCurves(activeStatus.id, canvasInstance, undefined, curveError)
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
        const v2 = polarById(event.target.dataset.id)?.kind === 'polarSet'
        if (v2 && !window.confirm('Activate this complete v2 document? All performance consumers must support polarSet v2 first. The local display table is NOT shared.')) {
          event.target.checked = false
          return
        }
        await api('activePolar', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: event.target.dataset.id, ...(v2 ? { acknowledgeV2: true } : {}) })
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

async function loadOverviewCurves(id, canvas, sailplanId, errorEl) {
  const request = {}
  curveRequests.set(canvas, request)
  canvas.loadCurves({ curves: [] })
  if (errorEl) errorEl.textContent = ''
  try {
    const selection = sailplanId === undefined ? '' : `&sailplanId=${encodeURIComponent(sailplanId)}`
    const curves = await api(`polars/${encodeURIComponent(id)}/curves?step=5&corrected=true${selection}`)
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
    const toggle = event.target.closest('[data-dropdown-toggle]')
    if (toggle) {
      event.preventDefault()
      const menu = toggle.nextElementSibling
      const isOpen = menu.classList.contains('show')
      table.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'))
      if (!isOpen) menu.classList.add('show')
      return
    }
    if (event.target.closest('a.dropdown-item')) {
      table.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'))
      return
    }
    const target = event.target.closest('[data-action]')
    if (!target) return
    const { action, id } = target.dataset
    try {
      if (action === 'preview') {
        await showPolarTables(polarById(id))
        return
      }
      if (action === 'modify') {
        showModifyPolar(polarById(id))
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

async function showPolarTables(polar) {
  const documentBody = await api(`polars/${encodeURIComponent(polar.id)}`)
  const v2 = documentBody.kind === 'polarSet'
  const choices = v2
    ? [{ name: 'Best performance', table: documentBody.best }, ...(documentBody.sailplans || [])]
    : [{ name: 'Polar table', table: documentBody }]
  const view = cardEl('Polar tables')
  view.body.innerHTML = `
    <p class="small text-muted">Document: ${escapeHtml(documentBody.name || polar.id)} (${escapeHtml(documentBody.schemaVersion)}).
      Table selection is local to this view; the active-polar pointer is unchanged.</p>
    <label for="viewTable">Display / export table</label>
    <select id="viewTable" class="form-select form-select-sm mb-2">
      ${choices.map((choice, index) => `<option value="${index}">${escapeHtml(choice.name)}</option>`).join('')}
    </select>
    <div class="row"><div class="col-md-5 col-lg-4"><canvas class="polar-canvas"></canvas></div></div>
    <div data-curve-error class="text-danger small" role="status"></div>
    <div data-table></div>
    <h5 class="mt-3">Export</h5>
    <a class="btn btn-secondary btn-sm mb-2" href="${BASE}/polars/${encodeURIComponent(polar.id)}/export/json" download>Complete canonical document (lossless)</a>
    <p class="small">Selected-table exports are projections, not complete-document exports.
      ${v2 ? 'They omit other tables, sail descriptions, wave correction, heel/reef/flat and winning references. Root boat metadata is retained where the format supports it; it does not describe the selected sailplan.' : ''}
      Text formats round numbers and may lose target details. Missing speeds are rejected, never replaced with zero.</p>
    <select data-export-format class="form-select form-select-sm mb-2" aria-label="Selected-table export format">
      <option value="expedition">Expedition text</option>
      <option value="jieter">Jieter text</option>
      <option value="json-v1">Canonical v1 table${v2 ? ' (lossy projection)' : ''}</option>
    </select>
    <label><input type="checkbox" data-ack-loss> I accept the selected-table projection and information loss.</label>
    <div><button class="btn btn-primary btn-sm" data-export-table>Export selected table</button>
      <button class="btn btn-secondary btn-sm" data-close-view>Close</button></div>
    <p data-export-error class="text-danger small mt-2" role="alert"></p>
  `
  const select = view.body.querySelector('#viewTable')
  const canvas = new window.PolarCanvas(view.body.querySelector('canvas'))
  let generation = 0
  const render = async () => {
    const current = ++generation
    const choice = choices[Number(select.value)]
    const table = choice.table
    const number = (value, factor = 1, digits = 2) => value === null || value === undefined ? '-' : (value * factor).toFixed(digits)
    const knots = 3600 / 1852
    const degrees = 180 / Math.PI
    const quantities = [['boatSpeedMatrix', 'Boat speed (kn)', knots], ['heelMatrix', 'Heel (deg)', degrees], ['reefMatrix', 'Reef factor', 1], ['flatMatrix', 'Flat factor', 1]]
    view.body.querySelector('[data-table]').innerHTML = `
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
    const errorEl = view.body.querySelector('[data-curve-error]')
    errorEl.textContent = ''
    canvas.loadCurves({ curves: [] })
    try {
      const selection = choice.id === undefined ? '' : `&sailplanId=${encodeURIComponent(choice.id)}`
      const result = await api(`polars/${encodeURIComponent(polar.id)}/curves?step=5${selection}`)
      if (current === generation) canvas.loadCurves(result)
    } catch (error) {
      if (current === generation) errorEl.textContent = error.message
    }
  }
  select.addEventListener('change', render)
  view.body.querySelector('[data-export-table]').addEventListener('click', async () => {
    const errorEl = view.body.querySelector('[data-export-error]')
    errorEl.textContent = ''
    if (!view.body.querySelector('[data-ack-loss]').checked) {
      errorEl.textContent = 'Acknowledge the selected-table projection before exporting.'
      return
    }
    const format = view.body.querySelector('[data-export-format]').value
    const choice = choices[Number(select.value)]
    const query = new URLSearchParams({ scope: 'table', acknowledgeLoss: 'true' })
    if (choice.id !== undefined) query.set('sailplanId', choice.id)
    try {
      const text = await api(`polars/${encodeURIComponent(polar.id)}/export/${format}?${query}`)
      const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text, null, 2)], { type: format === 'json-v1' ? 'application/json' : 'text/plain' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${polar.id}-${Number(select.value)}.${format === 'json-v1' ? 'json' : 'txt'}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      errorEl.textContent = error.message
    }
  })
  view.body.querySelector('[data-close-view]').addEventListener('click', () => rerender())
  document.getElementById('card-body').replaceChildren(view.card)
  observeCanvasSize(view.body.querySelector('canvas'), canvas)
  await render()
}

function showModifyPolar(polar) {
  const editor = cardEl('Modify polar')
  const form = document.createElement('form')
  form.innerHTML = `
    <fieldset>
      <div class="row">
        ${POLAR_COLUMNS.filter(column => column.key !== 'source').map(column => `
          <div class="col-md-6 mb-3">
            <label class="small" for="modify-${column.key}">${column.label}</label>
            <input class="form-control form-control-sm" id="modify-${column.key}" name="${column.key}"
              type="${column.key === 'year' ? 'number' : 'text'}"
              ${column.key === 'year' ? 'step="1"' : ''}
              ${column.key === 'id' ? 'required maxlength="100"' : ''}
              value="${escapeHtml(polar[column.key] ?? '')}">
          </div>
        `).join('')}
      </div>
      <div class="alert alert-danger small" role="alert" hidden></div>
      <button type="submit" class="btn btn-primary btn-sm">Save</button>
      <button type="button" class="btn btn-secondary btn-sm ms-2" data-action="cancel">Cancel</button>
    </fieldset>
  `
  form.querySelector('[data-action="cancel"]').addEventListener('click', () => rerender())
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!form.reportValidity()) return
    const fieldset = form.querySelector('fieldset')
    const error = form.querySelector('[role="alert"]')
    const data = new FormData(form)
    const metadata = Object.fromEntries(data)
    metadata.year = metadata.year === '' ? null : Number(metadata.year)
    error.hidden = true
    fieldset.disabled = true
    try {
      const { id } = await api(`polars/${encodeURIComponent(polar.id)}/metadata`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata)
      })
      await Promise.all([loadPolars(), loadActiveStatus()])
      setMessage(`Saved '${id}'`)
      if (activePage === 'management') await rerender()
    } catch (e) {
      error.textContent = e.message
      error.hidden = false
      setMessage(e.message, true)
    } finally {
      fieldset.disabled = false
    }
  })
  editor.body.appendChild(form)
  const body = document.getElementById('card-body')
  body.replaceChildren(editor.card)
  form.querySelector('input').focus()
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
