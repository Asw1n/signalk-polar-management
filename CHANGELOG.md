# Changelog

## 1.6.0 - 2026-11-04

### Added
- Extend the in-process API with `listPolars()`, `getPolar(id)`, `getSelection()` and service-wide `onChange(callback)`. Reads return fresh, deeply immutable results without preparing calculation tables. Lists omit validation and active flags; complete document reads preserve readable invalid data and report validity separately in `state`. Existing calculation handles and API version 1 remain unchanged.

## 1.5.1 - 2026-11-02

### Fixed
- Register the `polars` resource provider before publishing the active polar at start, so a plugin that loads the polar as soon as `polars.activePolar` arrives no longer fails with `No provider for polars`.

## 1.5.0 - 2026-11-02

### Added
- Publish the active selection's identity as plain strings for simple displays: `vessels.self.polars.boatName` (the active document's boat name, falling back to the resource id) and `vessels.self.polars.sailPlan` (the shared active sailplan's name, `best` for a v2 best selection, null for v1 documents or unusable selections). Both paths are event-driven, follow document and sailplan renames, and reset to null when no usable polar is active or the plugin stops.
- Other Signal K plugins can calculate speeds, VMG, targets and sailing ranges directly using live polar handles. Active handles follow the vessel's current polar and performance factor automatically; specific-polar handles support independent performance assumptions and optional change notifications.
- Live polar handles also describe their current selection (`describe()`): boat metadata, the selected sailplan, the applied performance factor and the selected table's wind-speed axis, so consumer plugins can show polar details and draw per-wind-speed curves without reading stored resources or parsing Signal K paths.
- Canonical v2 validation, non-destructive storage/import/metadata editing and complete-document JSON export, alongside unchanged v1 resources and legacy importer output defaults.
- Automatically detected ORC speed-guide HTML import to v2, using embedded high-precision numeric data when present and visible-table fallback otherwise. Preserves independent best/sailplan targets, heel/reef/flat and minimal sail descriptions; exact source 0.01-knot placeholders become unavailable, not real targets.
- Local best/sailplan table display and curve selection, plus explicitly acknowledged selected-table exports (Expedition, Jieter or lossy canonical v1 projection). Incompatible missing speeds are rejected rather than filled.
- Explicit v2 active-document acknowledgment to protect consumer rollout.
- Shared sailplan selection for an active v2 polar: pick best (default) or a named sailplan together with the active polar. The choice is published with the active-polar pointer, persists across restarts, resets to best when the active polar changes, and is followed automatically by live calculation handles. A sailplan that disappears from the document makes the selection explicitly invalid; it never silently falls back to best.
- Shared wave-correction toggle (default on): choose whether consumers apply a v2 polar's optional wave correction. The setting persists across restarts and polar changes and never affects the webapp curve display. The published Signal K path reflects usability: it carries null whenever the active polar cannot use wave correction (v1, no wave correction table, or no usable active polar) and the stored setting otherwise. Active-polar calculation handles honor it automatically; specific-polar handles are independent of it and of all other shared settings.
- Redesigned Active polar page: one selection table activates polar and sailplan together — v2 rows expand to show their indented sailplans with radio buttons, and picking a polar defaults to best. The v2 activation warning dialog is removed; the webapp acknowledges v2 activation automatically. The polar details now show the document format, sailplan count and wave-correction availability. A dedicated Adjustments card carries the shared performance factor (applied automatically, without a Save button) and the new wave-correction switch, grayed out when the active polar cannot use wave correction. The graph now always shows the uncorrected polar for the shared selection; the former local display-table dropdown and graph performance correction are removed.
- New Open view for stored polars, replacing the View tables, Modify and per-row Export actions: one page edits boat metadata (now including the notes field), shows each table's curves and numbers, exports the selected table or complete document, and edits v2 documents in place.
- Wave-correction import, export and removal for v2 polars: import a TimeZero Wave_Polar.xml or a canonical JSON fragment (detected automatically, replacing the whole correction), export the current correction as JSON, or remove it. UTF-16 TimeZero files are decoded correctly. The active polar's published wave-correction path updates immediately.
- Sailplan editing for v2 polars: add a sailplan from a single-table polar file (canonical v1 JSON, Jieter, Expedition or TimeZero), edit a sailplan's id, name and notes, and delete sailplans. Renaming updates best's winning references and the shared active selection; deletion is strictly rejected while best references the sailplan or while it is active.

### Changed
- Prepare calculation data only for the active polar and specifically requested polars, avoiding startup work and memory use for unused stored tables.
- Use published `polar-format` 2 for both document versions. No automatic migration or package version change.
- V2 curves use the agreed `Polar.fromPolarSet` API when available. Published `polar-math` 1.1.1 remains pinned by the existing dependency range and cannot render v2: return an explicit 503 until a compatible release is selected. Integration verification uses an isolated immutable unreleased math commit, not a local link or production dependency.
- Preserve the newly merged in-process live-handle API: active v2 handles follow the shared sailplan selection (best by default) on every call, and specific handles can fix a sailplan; local table display never changes handles. Unsupported math returns an explicit `unsupported_math` result and plugin error.

## 1.4.0 - 2026-10-29

### Added
- Import TimeZero `Wind_Polar.xml` polar files (TZ Professional, TZ Navigator); the format is detected automatically like the others.

### Fixed
- Preserve specific errors from recognised formats during automatic import, including the hint to use `Wind_Polar.xml` when a TimeZero wave polar is selected.

## 1.3.0 - 2026-10-26

### Added
- Edit a stored polar's boat name, ID, boat type, sail number, and year from the stored polars table using a matching form with Save and Cancel. Optional boat details can be cleared without changing speed data, source, or notes.

### Changed
- Modify replaces Rename in the stored polars table. Change the ID in the Modify form to rename a polar; an active polar stays selected under its new ID.
- Read-only Signal K users can now view stored polar data, curves and validation, active selection and performance factor, exports, and the import/export catalogs. Polar selection, imports, external searches, and other management operations remain administrator-only.
- Requires signalk-server >=2.31.0 for native plugin route access policies; support for Signal K 2.28–2.30 is dropped.

## 1.2.0 - 2026-09-17

### Added

- Added a link to the ORC terms of use in the ORC import view.
- Added a confirmation dialog after a polar is imported successfully.

## 1.1.0 - 2026-09-15

### Added

- Added automatic detection for canonical, Jieter, and Expedition polar imports.
- Added ORC RMS JSON imports using the public certificate data endpoint.

### Changed

- Improved the polar management interface and polar diagram rendering.

### Fixed

- Reject invalid polar resource IDs before using them as storage filenames.
- Prevent external ORC requests from hanging indefinitely during certificate imports
  and active-certificate cache refreshes.
- Allow additional time for ORC active-certificate cache refreshes to complete.
- Preserve usable sparse downwind polar curves when target markers are unavailable.
- Exempt `polars.activePolar` from Signal K's stale-data timeout by declaring it as an event-driven path.
- Exempt `polars.performanceFactor` from Signal K's stale-data timeout by declaring it as an event-driven path.
- Omit the stored polar id from resource responses and stored document bodies.

## 1.0.0 - 2026-09-09

Initial release.

### Added

- Initial extraction from `signalk-polar-performance-plugin`: polar storage, selection, import
  (Jieter/ORC matrix text, Expedition text, ORC active certificates), export (JSON, Jieter, Expedition),
  and a management webapp. Registers as a Signal K Resource Provider for type `polars` and publishes
  `vessels.self.polars.activePolar`.
- Added a webapp-adjustable polar performance factor published at
  `vessels.self.polars.performanceFactor`, with metadata for both plugin-owned Signal K output paths.
- Added `GET /polars/:id/curves`, which uses `polar-math` to sample each TWS curve at a fixed angular
  step (5° by default) across the full valid TWA range, so the webapp draws complete polar lines
  including pinch and run extrapolation.
- Added polar validation and copy endpoints, offline-aware external import handling,
  and a reorganized management webapp with separate active, management, and import pages.
- Added the Polar Management icon to Signal K plugin metadata and the published package.
- Added sortable polar tables to the active-polar and management views.
- Added optional performance-factor scaling to sampled polar curves, including beat, run,
  and maximum-speed targets.

### Fixed

- Made the Polar Management icon available in both the Signal K AppStore and the webapp header.
