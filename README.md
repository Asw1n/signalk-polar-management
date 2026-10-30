# Polar management

This plugin helps you keep your boat's sailing polar data organised in Signal K.

If you are not sure what a polar is, think of it as the speed your boat should make in different wind conditions. It is used by sailing apps to estimate performance, compare routes, and help with decisions on the water.

This plugin makes it easy to store more than one polar, pick the one you want to use, and manage it from a simple interface.

Requires Signal K Server >=2.31.0.

## Canonical v1 and v2

Resources accept and validate both canonical `polarTable` v1 and `polarSet` v2
using `polar-format` 2. Existing resources are **not migrated**. Canonical JSON
imports retain their version; all existing vendor importers (including online
ORC certificates and TimeZero wind XML) still produce v1.

A v2 resource contains a source-supplied `best` table and optional descriptive
sailplans, each with its own grid and targets. Storage, copy, rename and boat
metadata edits preserve every nested field: auxiliary heel/reef/flat matrices,
nulls, targets, winning references and vessel-wide wave correction. Sail
descriptions are not inventory associations or operational reef settings.

Choose **View tables** in Polar management to inspect best or a sailplan's
speed/auxiliary tables and exact supplied targets. Table selection is local;
root boat metadata and wave context are not embedded-table metadata.

### Math readiness and consumer rollout

The production dependency remains the published `polar-math` 1.1.1. It cannot
prepare v2 curves. Until a compatible math release is selected, v2 curve
requests explicitly return **503** and the UI displays the error; storage,
numeric table display, metadata editing, import and export remain available.
There is no synthetic v1 math wrapper or silent fallback to a different table.
Integration can be verified separately against immutable unreleased
`polar-math` commit `4e33ef0be27ea0b85424be691504dc75ae3eb518`
([math PR](https://github.com/Asw1n/polar-math/pull/2)); this is not a production
dependency or a local link. Selecting a future math release is a remaining
deployment prerequisite, not part of this no-release change.

The active pointer remains `{ "href": "/resources/polars/<id>" }` at
`vessels.self.polars.activePolar`: it selects the **complete document**, never a
local display/export sailplan. No shared active-sailplan path is introduced.
Before activating a v2 resource, every performance/navigation consumer must
support v2. The UI requires confirmation; the activation API requires
`{ "id": "...", "acknowledgeV2": true }`. This acknowledgment is not automatic
consumer capability detection. Existing v1 activation and persisted active
selection behavior are unchanged. The performance plugin is not modified here.

## Import an ORC speed-guide HTML file

Use **Import from file** and select the downloaded HTML guide. It participates
in **automatic detection** and produces canonical **v2**, unlike existing
importers. No manual format selection, internet access or standalone SYLK
importer is required. This is separate from the online ORC certificate search.

The importer reads numeric tables only, without executing scripts, loading
external resources or interpreting graphics. When present, the embedded `.slk`
download supplies higher-precision scalar data, checked against the visible
table values at their display precision. Malformed or conflicting embedded data
is rejected, not silently replaced by rounded values. Without that download,
visible tables are used. AWS/AWA are deliberately not imported: the source's
visible and spreadsheet apparent-wind conventions differ, and canonical v2 has
no such fields.

HTML is limited to 8 MiB before parsing. Signal K's JSON upload limit also
applies (normally 10 MB, configurable by the server's `FILEUPLOADSIZELIMIT`);
the JSON request may be larger than the original file because of escaping.

Best performance is authoritative, not reconstructed from sailplan maxima.
Each table retains its own supplied beat/run angles, speed, nonnegative VMG
magnitude and available heel/reef/flat targets. No winning sailplan is guessed
from approximate equality. Known sail names, source identifiers and square-metre
areas are descriptive only. Knots and degrees become m/s and radians; model
factors stay dimensionless, including values slightly above one.

**ORC placeholder policy:** exact source BTV `0.01` knot values are treated as
unavailable, as confirmed for these guides. Their speed and auxiliary matrix
cells become `null`; corresponding placeholder beat/run targets are omitted.
This is not a general low-speed threshold: zero and other small numeric speeds
remain numeric. Do not interpret unavailable values as real sailing optima.

## Export a document or selected table

- **Complete canonical JSON** retains the document's version and all stored
  information. This is the lossless/round-trip option, including v2 nulls,
  references, auxiliary values and wave correction.
- **Selected table** (best by default, or a chosen descriptive sailplan) offers
  Expedition, Jieter, and canonical v1 JSON. For v2 these are explicitly
  **lossy projections**, requiring acknowledgment. Other tables, sail
  descriptions, auxiliary quantities, wave correction and winning references
  are omitted. Supported root boat metadata is retained, not relabeled as
  sailplan metadata. Text formats also round numbers and may lose target
  details. Canonical v1 projection is not a lossless canonical v2 export.
- Missing speeds are incompatible with these single-table formats and produce
  an error. No interpolation, zero filling or flattening of the set occurs.
  Existing v1 download actions retain their behavior.

API: `GET /polars/{id}/export/json` exports the complete document and rejects
table-selection parameters. For a v2 projection use
`/polars/{id}/export/{expedition|jieter|json-v1}?scope=table&acknowledgeLoss=true`
and optionally `&sailplanId=<document-local-id>`; omit the ID for best. Unknown
IDs are errors, never best-table fallbacks. All routes have the
`/plugins/signalk-polar-management` prefix.

## HTTP endpoint access

Signal K read-only users can view stored polar data, curves and validation, the current active selection and performance factor, export downloads, connectivity status, and import/export catalogs. External-source searches and all changes—including imports, selection changes, and other management operations—require administrator access. The standard Signal K Resource Provider API remains governed by the server's own authorization rules. Anonymous access is controlled by the server's security configuration and is not enabled by this plugin.

## Install from the Signal K AppStore

1. Open your Signal K admin UI.
2. Go to the AppStore.
3. Search for "Polar Management".
4. Click Install.
5. Follow any normal Signal K prompts to finish the install.

No manual command-line installation is needed for the normal AppStore workflow.

## Find a polar for your boat

Once the plugin is installed, the next step is to load a polar for your boat.

1. Open the Polar Management page in Signal K.
2. Choose the import option.
3. Use the ORC import.
4. Search by your boat model or hull type.
5. Pick the closest match and import it.

This is the easiest way to get a suitable polar for your boat before using other sailing apps that depend on it.

### ORC data source

The ORC importer currently uses the legacy `WPub.dll` service. ORC says it will stop serving requests on **31 January 2027**, so the importer will need to move to the ORC API before then. See the [ORC API migration notes](./docs/orc-api.md) for the affected requests and documentation link.

## What this plugin does

- Keeps your polar data in one place.
- Lets you save and name different polars.
- Lets you edit stored polars' boat details without changing their speed data.
- Lets you choose which polar is the active one.
- Makes it easier to import a polar from a file or an external source.
- Helps other sailing tools use the correct polar without having to edit raw files by hand.

## Modify a stored polar

Editing requires Signal K administrator access.

1. Open **Polar management**.
2. Choose **Modify** beside a polar in the **Stored polars** table.
3. Edit the boat name, ID, boat type, sail number, or year.
4. Choose **Save** to apply the changes, or **Cancel** to return to the table
   without saving.

Boat name, boat type, sail number, and year are optional; leaving them blank clears
their stored values. If supplied, the year must be a whole number. Validation
errors appear in the form so you can correct them without losing your edits.

Changing the ID replaces the former Rename action. The new ID must be unique.
If you modify the active polar's ID, its active selection follows the new ID.
All polar performance data (including nested v2 tables and wave correction),
source, and notes are preserved.

Administrators can make the same changes with `PUT /plugins/signalk-polar-management/polars/{id}/metadata`.
The JSON body requires `id` and optionally accepts `name`, `boatType`, `sailnumber`,
and integer `year`. Omitted fields are unchanged; empty strings clear text fields,
and `null` clears the year. The existing rename API remains available for compatibility.

## Why this is useful

This plugin is most useful when used together with other sailing apps in Signal K. Those apps can do the actual performance calculations, routing help, or sailing analysis, but they need a good polar to work with.

## In-process calculations for other plugins

Plugins in the same Signal K server can discover the versioned `polarManagement`
service through PropertyValues and retain live calculation handles. An active
handle automatically follows the current selection and shared performance factor
on every call. A specific-polar handle follows that stored table, using factor 1
unless an explicit factor is supplied. Optional change subscriptions let consumers
react without being required to keep calculations current.

For example, inside a consumer plugin:

```js
let activePolar = null
let unsubscribeDiscovery = null

// In plugin.start():
unsubscribeDiscovery = app.onPropertyValues('polarManagement', history => {
  const service = history.findLast(
    entry => entry?.setter === 'signalk-polar-management'
  )?.value

  activePolar = null
  if (service?.apiVersion !== 1 || service.available !== true ||
      typeof service.activePolar !== 'function' ||
      typeof service.polar !== 'function') return

  activePolar = service.activePolar()

  // Alternatively, request a specific stored polar:
  // const raw = service.polar('cruising') // factor defaults to 1
  // const adjusted = service.polar('cruising', { performanceFactor: 0.85 })
})

// In the consumer's calculation callback (SI units: m/s and radians):
const result = activePolar?.speedAt({ tws: 8, twa: 1.2 })
if (result?.value !== null && result?.value !== undefined) {
  const targetSpeed = result.value // m/s; zero is a valid result
  // Use targetSpeed in the consumer's calculations.
}
// The retained handle uses the current selection and factor on every call.
// value: null means no usable speed; inspect result.state for the reason.

// In plugin.stop():
unsubscribeDiscovery?.()
unsubscribeDiscovery = null
activePolar = null
```

See the [in-process API design and consumer guide](./docs/in-process-api.md)
for discovery, calculations, notifications, errors and lifecycle behaviour.
