// app.js — Polar Management webapp
// All data comes from this plugin's own HTTP endpoints (never the SK bus directly).
'use strict'

const BASE = '/plugins/signalk-polar-management'

let activePolarId = null

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

async function loadActivePolar() {
  const { id } = await api('activePolar')
  activePolarId = id
}

async function loadPolars() {
  const [polars] = await Promise.all([api('polars'), loadActivePolar()])
  const tbody = document.getElementById('polarRows')
  tbody.innerHTML = ''
  polars.forEach((p) => {
    const tr = document.createElement('tr')
    const isActive = p.id === activePolarId
    tr.innerHTML = `
      <td><input type="radio" name="activePolar" ${isActive ? 'checked' : ''} data-id="${p.id}"></td>
      <td>${p.name || p.id}</td>
      <td>${p.boatType || ''}</td>
      <td>${p.sailnumber || ''}</td>
      <td>${p.year || ''}</td>
      <td>${p.source || ''}</td>
      <td class="text-end">
        <button class="btn btn-link btn-sm" data-action="view" data-id="${p.id}">View</button>
        <button class="btn btn-link btn-sm" data-action="rename" data-id="${p.id}">Rename</button>
        <div class="dropdown d-inline">
          <button class="btn btn-link btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown">Export</button>
          <ul class="dropdown-menu">
            <li><a class="dropdown-item" href="${BASE}/polars/${p.id}/export/json">Canonical JSON</a></li>
            <li><a class="dropdown-item" href="${BASE}/polars/${p.id}/export/jieter">Jieter text</a></li>
            <li><a class="dropdown-item" href="${BASE}/polars/${p.id}/export/expedition">Expedition text</a></li>
          </ul>
        </div>
        <button class="btn btn-link btn-sm text-danger" data-action="delete" data-id="${p.id}">Delete</button>
      </td>
    `
    tbody.appendChild(tr)
  })
}

let polarCanvas = null

async function viewPolar(id) {
  const resource = await api(`polars/${id}`)
  document.getElementById('viewerEmpty').style.display = 'none'
  const canvas = document.getElementById('polarCanvas')
  canvas.style.display = 'block'
  if (!polarCanvas) polarCanvas = new window.PolarCanvas(canvas)
  polarCanvas.resize()
  polarCanvas.loadResource(resource)
}

async function setActivePolar(id) {
  await api('activePolar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
  activePolarId = id
  setMessage(`Active polar set to '${id}'`)
}

async function renamePolar(id) {
  const newId = window.prompt('New name for polar', id)
  if (!newId || newId === id) return
  await api(`polars/${id}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: newId })
  })
  await loadPolars()
}

async function deletePolar(id) {
  if (!window.confirm(`Delete polar '${id}'?`)) return
  await api(`polars/${id}`, { method: 'DELETE' })
  await loadPolars()
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

async function loadImportFormats() {
  const formats = await api('imports/formats')
  const select = document.getElementById('importFormat')
  select.innerHTML = formats.map(f => `<option value="${f.id}">${f.name}</option>`).join('')
}

async function doImport() {
  const format = document.getElementById('importFormat').value
  const file = document.getElementById('importFile').files[0]
  const pasted = document.getElementById('importText').value
  const content = file ? await readFileAsText(file) : pasted
  if (!content || !content.trim()) {
    setMessage('Provide a file or paste text to import', true)
    return
  }
  const { id } = await api(`imports/text/${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })
  setMessage(`Imported as '${id}'`)
  document.getElementById('importText').value = ''
  document.getElementById('importFile').value = ''
  await loadPolars()
}

async function doOrcSearch() {
  const q = document.getElementById('orcQuery').value
  const results = await api(`imports/sources/orc/search?q=${encodeURIComponent(q)}`)
  const tbody = document.getElementById('orcResults')
  tbody.innerHTML = results.map(r => `
    <tr>
      <td>${r.name}</td>
      <td>${r.sailnumber || ''}</td>
      <td>${r.boatType || ''}</td>
      <td>${r.year || ''}</td>
      <td><button class="btn btn-link btn-sm" data-action="orc-import" data-external-id="${r.externalId}">Import</button></td>
    </tr>
  `).join('')
}

async function doOrcImport(externalId) {
  const { id } = await api(`imports/sources/orc/items/${encodeURIComponent(externalId)}`, { method: 'POST' })
  setMessage(`Imported as '${id}'`)
  await loadPolars()
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  const { action, id, externalId } = target.dataset
  try {
    if (action === 'view') await viewPolar(id)
    if (action === 'rename') await renamePolar(id)
    if (action === 'delete') await deletePolar(id)
    if (action === 'orc-import') await doOrcImport(externalId)
  } catch (e) {
    setMessage(e.message, true)
  }
})

document.addEventListener('change', async (event) => {
  if (event.target.name === 'activePolar') {
    try {
      await setActivePolar(event.target.dataset.id)
      await loadPolars()
    } catch (e) {
      setMessage(e.message, true)
    }
  }
})

document.getElementById('importSubmit').addEventListener('click', () => doImport().catch(e => setMessage(e.message, true)))
document.getElementById('orcSearch').addEventListener('click', () => doOrcSearch().catch(e => setMessage(e.message, true)))

loadImportFormats().catch(e => setMessage(e.message, true))
loadPolars().catch(e => setMessage(e.message, true))
