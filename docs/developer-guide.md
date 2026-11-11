# Developer guide

This guide covers integration and implementation details for Polar Management.
For the in-process calculation service contract, see the
[in-process API guide](./in-process-api.md). For sailors, see the
[main README](../README.md).

## Polar documents

The plugin stores canonical v1 `polarTable` and v2 `polarSet` documents. Existing
resources are not migrated. Canonical JSON imports retain their version; the
other existing vendor importers produce v1, while ORC speed-guide HTML imports
produce v2.

A v2 document has a source-supplied `best` table and may have descriptive
sailplans, each with its own grid and targets. Storage, copy, rename, and boat
metadata edits preserve nested fields, including auxiliary matrices, nulls,
targets, winning references, and vessel-wide wave correction. Sail descriptions
are not inventory associations or operational reef settings.

The **Open** view can display the best table or a sailplan's speed and auxiliary
tables and supplied targets. Its display and export table choices are local;
they do not alter the shared active selection.

## Shared active selection

`vessels.self.polars.activePolar` selects the complete document and, for v2,
the shared active sailplan. Its value has the form
`{ "href": "/resources/polars/<id>" }`, with a `sailplanId` field when a
non-best sailplan is selected. Set it with `PUT /activePolar`, passing `id` and,
for v2, optionally `sailplanId`. A v2 activation requires
`acknowledgeV2: true`; the webapp supplies this acknowledgment. It does not
detect whether consumers support v2, so consumers should be checked before
activating v2 documents. Changing the active polar resets the shared sailplan
to best. An invalid or removed sailplan selection does not silently fall back.

Active in-process handles follow the shared selection and settings on each
calculation call. A `polar(id, { sailplanId })` handle is fixed to that
document-local sailplan. The **Open** view's display and export choices remain
independent of both.

For consumers that need labels, the plugin publishes
`vessels.self.polars.boatName` and `vessels.self.polars.sailPlan` as strings.
The sailplan path is `best` for a v2 best selection and `null` for v1, an
unusable selection, or when no usable polar is active. Both paths are published
on change and reset to `null` when the plugin stops.

A v2 document may include a vessel-wide `waveCorrection` table. The shared
toggle is available through `GET/PUT /waveCorrection` and defaults to on.
`vessels.self.polars.applyWaveCorrection` is `null` when no usable active polar
can apply wave correction. The setting is retained when a polar without wave
correction is active and published again when a compatible polar is selected.
The webapp curve display does not apply wave correction. Specific-polar handles
are independent of shared settings; their consumers control wave correction by
supplying or omitting sea state.

## HTTP API and access

All plugin routes use the `/plugins/signalk-polar-management` prefix.

- `GET /polars/{id}/export/json` exports a complete document and rejects
  table-selection parameters.
- To export one table, use
  `/polars/{id}/export/{expedition|jieter|json-v1}?scope=table&acknowledgeLoss=true`
  and optionally `&sailplanId=<document-local-id>`. Omit the sailplan ID for
  best. These exports are lossy projections of v2 documents; missing speeds
  cause an error rather than interpolation or zero filling.
- Wave-correction routes include `GET/PUT/DELETE /polars/{id}/waveCorrection`
  and `POST /polars/{id}/waveCorrection/import`.
- Sailplan routes include `POST /polars/{id}/sailplans`,
  `DELETE /polars/{id}/sailplans/{sailplanId}`, and
  `PUT /polars/{id}/sailplans/{sailplanId}/metadata`.
- Boat metadata edits use `PUT /polars/{id}/metadata`.

Signal K read-only users can view stored data, curves, validation, active
selection, performance factor, export downloads, connectivity, and catalogs.
External-source searches and management changes require administrator access.
The standard Signal K Resource Provider API continues to use the server's own
authorization rules.

Custom endpoint mutations publish Signal K deltas at
`resources.polars.<id>` with the complete stored document, or `null` on
deletion. Renames announce removal of the old ID and the document at the new
ID. Rollbacks announce the restored state. Standard Resources API writes rely
on the server's deltas and do not emit duplicate plugin notifications.
Stopping the plugin does not announce resource deletion.

## ORC speed-guide importer

Importing an ORC speed-guide HTML file produces canonical v2. The importer
parses numeric tables without executing scripts, loading external resources, or
interpreting graphics. When present, embedded `.slk` scalar data is checked
against the visible values at their displayed precision; malformed or
conflicting data is rejected. Without it, visible tables are used.

The importer accepts the documented English Best Performance, Headsail (`Jib`),
and Symmetric spinnaker (`Sym`) groups. Grids and point counts come from each
group, not fixed reference dimensions. Unsupported sail families, alternate
layouts, and non-scalar or formula-bearing SYLK are rejected. Apparent-wind
quantities are not imported. Exact source BTV `0.01` knot placeholders become
`null`; zero and other small numeric speeds remain numeric. Knots and degrees
are converted to m/s and radians, while model factors remain dimensionless.

The HTML limit is 8 MiB before parsing. Signal K's JSON upload limit also
applies and the escaped request may be larger than the source file.

## Tests and related documentation

Run `npm test` for importer, v1/v2 storage, API, lifecycle, and export regression
tests. To verify the private local ORC reference without adding it to the
repository, set `ORC_SPEED_GUIDE_HTML` to its file path before running the
suite. The opt-in test checks source points, conversions, targets, placeholders,
round trips, and selected-table exports.

See the [in-process API guide](./in-process-api.md) for service discovery,
calculation handles, notifications, errors, and lifecycle behavior. See the
[ORC API migration notes](./orc-api.md) for the planned change from the legacy
ORC service.
