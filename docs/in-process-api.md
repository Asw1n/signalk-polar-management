# In-process polar calculation API

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
- Table edits are reflected on the next calculation call, including calls on
  already-retained handles. A specific handle stays bound to its ID: it does not
  follow a rename. If the ID is recreated, the same handle uses the new table.
- Optional `handle.onChange(callback)` subscriptions are informational. Consumers
  decide whether to recalculate, cancel work, refresh a display, or do nothing.
  Calculations do not depend on subscribing.
- There are **no snapshots**. A long calculation can observe configuration
  changes between calls. Freezing a routing scenario is outside this API.

Prepared `polar-math` tables are private and shared between handles. Only the
active table is prepared at startup. Other tables are prepared when first
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
  activePolar(),
  polar(id, { performanceFactor = 1 } = {})
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

## Calculation methods

Both handle types expose `speedAt(options)`, `vmgAt(options)`,
`targetsAt(options)` and `rangeAt(options)`. They preserve polar-math's
`{ value, state }` results, m/s speeds and wind speeds, radian angles, range
classifications and `extrapolate` option (default `true`).

The factor is owned by the handle: a `performanceFactor` supplied to a calculation
method does not override it. Consumers must not apply the shared factor again.
Calls are synchronous and perform no filesystem access, validation or preparation.
Neither prepared instances nor internal table data are exposed.

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

Reasons are `no_active_polar`, `polar_not_found`, `invalid_polar` and
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
| `selection` | Active selection was published or cleared |
| `performanceFactor` | Shared factor was published |
| `saved` | Table created or replaced, including resource writes and imports |
| `modified` | Metadata changed, possibly including its ID |
| `renamed` | Storage ID changed through the rename API |
| `copied` | Table copied to a new ID |
| `deleted` | Table deleted |
| `stopped` | Provider stopped; handles are already unavailable |

`ids` contains affected storage IDs, or is empty for selection, shared factor
and stop events. Specific handles receive only events affecting their ID, plus
stop. Active handles receive changes affecting the current active ID, selection,
shared factor and stop events.

A compound operation, such as renaming the active polar and saving its new
selection, can generate multiple events. Notifications describe completed
individual transitions, not an atomic transaction for the whole HTTP request.
Callbacks should be short; defer substantial work rather than blocking the server.
Callback exceptions are reported through plugin error status and do not prevent
other listeners from being notified. Stop notifies listeners once and removes
all subscriptions. Subscribing to an already-stopped handle throws.
