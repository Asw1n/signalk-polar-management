# In-process polar service API

## Design summary

Polar Management owns a live calculation service for other plugins running in
the same Signal K server. Discovery uses the `polarManagement` PropertyValue,
not HTTP, an npm dependency on this plugin, or a Signal K delta subscription.
The service contract has `apiVersion: 1`.

- `service.activePolar()` creates a live calculation handle. **Every calculation
  call** uses the current active table and current shared performance factor.
- `service.polar(id)` creates a live handle for that storage ID, with factor **1**.
- `service.polar(id, { performanceFactor: 0.85 })` uses that explicit factor instead.
  It replaces, rather than multiplies, the shared factor. The factor must be a
  finite non-negative number; unlike the shared setting, it may exceed 1.
- `service.polar(id, { sailplanId: 'headsail' })` creates a handle fixed to that
  v2 document-local sailplan; omit `sailplanId` for best. It must be a nonempty
  string. An unknown or v1-incompatible sailplan yields `sailplan_not_found`
  results, never a fallback to best.
- The two handle types differ deliberately. **Active handles mirror every
  shared setting per call** — active polar, active sailplan, performance factor
  and the wave-correction toggle — and none of them can be overridden; changes
  apply between calls. **Specific handles are completely independent of shared
  settings**: their consumer chooses the document, sailplan and factor at
  acquisition, and controls wave correction per call by supplying or omitting
  `seaState`. The shared wave-correction toggle never affects them.
- Canonical v1 documents keep their table behavior. V2 documents select the
  table with `Polar.fromPolarSet`. Active handles follow the **shared active
  sailplan** on every calculation call: it defaults to best, is set together
  with the active polar, and resets to best whenever the active polar changes.
  Active handles also honor the **shared wave-correction toggle** (default on):
  when off, supplied `seaState` is dropped before reaching math, so a present
  `waveCorrection` table is not applied. Specific handles never drop `seaState`.
  Local display/export table choices never change a handle or the shared
  active pointer.
  Complete root context, including wave correction, is passed to math, not
  flattened into a synthetic v1 table.
- Table edits are reflected on the next calculation call, including calls on
  already-retained handles. A specific handle stays bound to its ID: it does not
  follow a rename. If the ID is recreated, the same handle uses the new table.
- Optional `handle.onChange(callback)` subscriptions are informational. Consumers
  decide whether to recalculate, cancel work, refresh a display, or do nothing.
  Calculations do not depend on subscribing.
- There are **no calculation snapshots**. A long calculation can observe configuration
  changes between calls. Freezing a routing scenario is outside this API.
- Read-only `listPolars()`, `getPolar(id)` and `getSelection()` calls return
  immutable point-in-time results. Each new call reads current information.
  Service-level `onChange(callback)` observes all managed documents and shared
  settings, independently of calculation handles.

Prepared `polar-math` tables are private and shared between handles, prepared
per document **and selected sailplan**. Only the active selection is prepared at
startup. Other tables are prepared when first
requested through `polar(id)`, or when selected as active. Importing or editing
an unused table does not prepare it. Successful managed mutations refresh only
previously requested tables, including IDs that were missing or deleted.
Preparation never happens during a calculation call. Selecting an already
prepared table or changing a factor does not rebuild it.
Prepared tables remain cached until deletion or plugin stop; there is no
automatic eviction. Missing IDs remain tracked until stop so retained handles
recover if those IDs are created again.
Direct filesystem edits are not monitored; restart the plugin to load them.

This deliberately extends the original resource-only architecture: management
now provides an optional computation service as well as canonical resources.
`polar-math` remains a standalone, Signal K-independent library. Existing resource
APIs, delta paths and consumers remain supported. This change does not add REST
calculation endpoints or migrate other plugins.

## Discovery and lifecycle

The service has this shape:

```js
{
  apiVersion: 1,
  available: true, // provider running, not a guarantee of an active selection
  listPolars(),
  getPolar(id),
  getSelection(),
  onChange(callback),
  activePolar(),
  polar(id, { performanceFactor = 1, sailplanId } = {})
}
```

Management announces the service after startup, and announces
`{ apiVersion: 1, available: false }` on stop. PropertyValues retains history,
including an initial `undefined`. Process the latest record from the management
plugin, including an unavailable record; do not search for an older available
service. Check the version and method shapes, not `instanceof`.

```js
let active = null
let unsubscribeChanges = null

// In the consumer's start():
const unsubscribeDiscovery = app.onPropertyValues('polarManagement', (history) => {
  const record = history.findLast(
    entry => entry?.setter === 'signalk-polar-management'
  )
  const service = record?.value
  unsubscribeChanges?.()
  unsubscribeChanges = null
  active = null
  if (service?.apiVersion !== 1 || service.available !== true ||
      typeof service.activePolar !== 'function' ||
      typeof service.polar !== 'function') return

  active = service.activePolar()
  // Optional; no subscription is needed to keep calculations current.
  unsubscribeChanges = active.onChange(change => {
    app.debug('Polar configuration changed: %o', change)
  })
})

// In the consumer's calculation callback:
const result = active?.speedAt({ tws: 8, twa: 1.2 })
if (result?.value !== null && result?.value !== undefined) {
  // Use result.value, including a valid zero.
}

// In the consumer's stop():
unsubscribeDiscovery()
unsubscribeChanges?.()
active = null
```

Startup order does not matter. After provider stop, old handles return
`provider_stopped` permanently; they never attach to a later provider session.
Discovery supplies a new service on restart. The service's `available` getter
also becomes false when stopped.

PropertyValues has a server-wide history limit of 1,000 values. Management emits
only at lifecycle boundaries, not on table, selection or factor changes.
Repeated starts retire the previous service before announcing a new one.

## Catalog, document reads and shared selection

These are methods on the existing service, not additional handles. They are
additive to `apiVersion: 1`; consumers requiring them must feature-detect the
methods because older providers expose only the calculation API.

All three reads return `{ value, state }` synchronously. Results, including
nested arrays, documents and diagnostics, are deeply frozen. They never expose
mutable store or prepared-math internals. Earlier results never update
themselves, and each new call reads current information. Separate calls are not
a transaction. Listing and document reads may perform filesystem I/O; use them
for discovery and inspection, not high-frequency calculation loops.
Neither method prepares calculation tables.

### `service.listPolars()`

Returns summaries sorted by storage ID, without matrices, axes, full validation,
or active-selection flags:

```js
{
  value: [{
    id: 'boat-36',
    kind: 'polarSet',
    schemaVersion: '2.0.0',
    name: 'Boat 36',
    boatType: null,
    sailnumber: null,
    year: null,
    source: null,
    notes: null,
    sailplans: [{ id: 'jib', name: 'Main + jib' }],
    hasWaveCorrection: true
  }],
  state: { available: true }
}
```

Absent or unusable metadata fields are `null`. V1 documents have
`sailplans: []` and `hasWaveCorrection: false`. V2 best is not a sailplan and is
not listed as one. `hasWaveCorrection` reports presence, not model validity.
For unvalidated malformed documents, only sailplan entries with string IDs are
summarized; missing or non-string names become `null`.
No `valid` field is returned: successful summary extraction does not establish
canonical validity or calculation readiness.

One unreadable or unparseable file does not prevent listing the others. Its
entry is `{ id, error: { reason, message } }`; reasons are `read_error`,
`parse_error`, or `polar_not_found` if it disappeared during the read.
An unreadable catalog directory returns `value: null` with
`state: { available: false, reason: 'read_error', message }`.
An empty catalog returns `value: []`, not an unavailable result.

### `service.getPolar(id)`

Reads and validates one stored document. The storage ID is authoritative and
returned separately; the parsed document is not normalized, repaired, migrated,
or adjusted by performance/wave factors.

```js
{
  value: { id: 'boat-36', document: { /* complete stored JSON document */ } },
  state: { available: true, valid: true, errors: [] }
}
```

A readable but invalid document is still returned unchanged:

```js
{
  value: { id: 'boat-36', document: { /* invalid stored document */ } },
  state: {
    available: true,
    valid: false,
    errors: [{ path: 'best.values.boatSpeedMatrix', message: '...' }]
  }
}
```

`available` means retrieval and JSON parsing succeeded, even if the parsed
value is not an object. `valid` reports canonical structural and semantic
validation by `polar-format`, not compatibility with the installed math
library. Invalid documents are also reported through plugin error status.

The complete document contains:

- V1 table axes, matrices and derived targets at the document root.
- V2 best and sailplan tables at `best` and `sailplans[].table`.
- Sailplan IDs, names, notes and descriptive sails in `sailplans[]`.
- Optional vessel-wide wave correction in `waveCorrection`. Each height layer
  has independent period and angle axes and its speed-factor matrix; do not
  assume common grids or uniform intervals.
- Root units, symmetry and descriptive metadata.

Null cells and omitted fields are preserved. Wind matrices use
`[twsRow][twaColumn]` indexing. There are no separate cell/table/wave accessors
and no operational sail-inventory ownership.

When retrieval or parsing fails:

```js
{
  value: null,
  state: {
    available: false,
    valid: null,
    reason: 'polar_not_found',
    message: '...'
  }
}
```

Other reasons are `read_error`, `parse_error`, and `provider_stopped`.
Read/parse failures are also reported through plugin error status; a missing
ID is an expected lookup failure. Malformed storage IDs throw `TypeError`
before filesystem access. File contents that parse but fail validation do not
produce a retrieval-failure result.

### `service.getSelection()`

Returns configured shared state without reading or preparing a document:

```js
{
  value: {
    polarId: 'boat-36',
    sailplanId: 'jib',
    performanceFactor: 0.9,
    applyWaveCorrection: true
  },
  state: { available: true }
}
```

`polarId` is `null` when nothing is selected. `sailplanId` is `null` for best,
v1, or no polar selection. These are configuration values, not a guarantee that
the selected document/sailplan exists or can calculate. Likewise, an enabled
wave toggle does not imply the document provides a wave model.

`handle.describe()` retains its existing role and shape: it describes the
handle's resolved calculation context and availability, including specific
handle choices, rather than catalog or raw-document state.

### `service.onChange(callback)`

Returns an idempotent unsubscribe function. Unlike handle subscriptions, this
receives every managed document mutation and shared-setting change, plus stop.
It uses the same event types and frozen `{ type, ids }` shape documented below.
Callbacks are synchronous after each completed transition, not immediately on
subscription. Reads inside a callback see the completed change.
Listener exceptions are reported without preventing other listeners from
running. Invalid callbacks throw `TypeError`.

All read methods return `value: null` and an unavailable `provider_stopped`
state after stop (`valid: null` additionally for `getPolar`). They perform no
filesystem access then. Stop notifies subscribers once and removes them;
subscribing after stop throws. Old service objects never attach to a later
provider session. Rediscover the service on restart.

Managed changes emit notifications; direct filesystem edits do not. Reads
can see direct edits, but calculation caches still require a restart as
documented above.

## Calculation methods

Both handle types expose `speedAt(options)`, `vmgAt(options)`,
`targetsAt(options)` and `rangeAt(options)`. They preserve polar-math's
`{ value, state }` results, m/s speeds and wind speeds, radian angles, range
classifications and `extrapolate` option (default `true`).

The factor is owned by the handle: a `performanceFactor` supplied to a calculation
method does not override it. Consumers must not apply the shared factor again.
Calls are synchronous and perform no filesystem access, validation or preparation.
Neither prepared instances nor internal table data are exposed.

## Handle description

Both handle types also expose `describe()`: a synchronous, filesystem-free
descriptive snapshot of the handle's current selection, for display purposes
such as a consumer webapp's overview. It resolves exactly like the calculation
methods — active handles mirror the shared selection per call, specific handles
stay fixed to their acquisition choices — and returns a frozen object:

```js
{
  available: true,
  id,                 // storage id of the selected document
  sailplanId,         // document-local sailplan id, or null for best / v1
  performanceFactor,  // the factor this handle applies in calculations
  name, boatType, sailnumber, year, source, notes, // document metadata, null when absent
  twsAxis             // the selected table's TWS axis, canonical m/s, frozen
}
```

`twsAxis` describes the grid of the table the handle calculates from (best or
the selected sailplan's table), so consumers can render per-TWS curves without
reading the resource document. Matrix data is still not exposed. Descriptions
are rebuilt with the prepared table, so edits are reflected on the next call.
When the handle cannot calculate, `describe()` returns
`{ available: false, reason }` with the same reasons as the calculation
methods. Consumers that only display metadata should prefer `describe()` over
resource lookups and the `polars.*` paths: it already reflects the shared
selection and needs no href or document-structure parsing.

Provider-level unavailability returns:

```js
{
  value: null,
  state: {
    available: false,
    reason: 'no_active_polar',
    tws: null,
    twa: null
  }
}
```

Reasons are `no_active_polar`, `polar_not_found`, `invalid_polar`,
`sailplan_not_found`, `unsupported_math` and
`provider_stopped`. An invalid/unreadable table is reported through the plugin's
error status when preparation fails, and does not fall back to an old table.
Other result states, including `invalid_input` and `no_data`, come from
polar-math. Unavailable calculations do not throw. Invalid handle acquisition
arguments and invalid subscription callbacks throw descriptive errors.

## Change subscriptions

`handle.onChange(callback)` returns an idempotent unsubscribe function. It does
not invoke the callback immediately. Callbacks run synchronously after the
relevant change and receive a frozen `{ type, ids }` event:

| Type | Meaning |
| --- | --- |
| `selection` | Active selection (polar or shared sailplan) was published or cleared |
| `performanceFactor` | Shared factor was published |
| `waveCorrection` | Shared wave-correction toggle was published |
| `saved` | Table created or replaced, including resource writes and imports |
| `modified` | Metadata changed, possibly including its ID |
| `renamed` | Storage ID changed through the rename API |
| `copied` | Table copied to a new ID |
| `deleted` | Table deleted |
| `stopped` | Provider stopped; handles are already unavailable |

`ids` contains affected storage IDs, or is empty for selection, shared factor,
wave-correction toggle and stop events. Specific handles receive only events
affecting their ID, plus
stop. Active handles receive changes affecting the current active ID, selection,
shared factor, wave-correction toggle and stop events.

A compound operation, such as renaming the active polar and saving its new
selection, can generate multiple events. Notifications describe completed
individual transitions, not an atomic transaction for the whole HTTP request.
Callbacks should be short; defer substantial work rather than blocking the server.
Callback exceptions are reported through plugin error status and do not prevent
other listeners from being notified. Stop notifies listeners once and removes
all subscriptions. Subscribing to an already-stopped handle throws.
