# Changelog

## Unreleased

### Added
- Other Signal K plugins can calculate speeds, VMG, targets and sailing ranges directly using live polar handles. Active handles follow the vessel's current polar and performance factor automatically; specific-polar handles support independent performance assumptions and optional change notifications.
- Canonical v2 validation, non-destructive storage/import/metadata editing and complete-document JSON export, alongside unchanged v1 resources and legacy importer output defaults.
- Automatically detected ORC speed-guide HTML import to v2, using embedded high-precision numeric data when present and visible-table fallback otherwise. Preserves independent best/sailplan targets, heel/reef/flat and minimal sail descriptions; exact source 0.01-knot placeholders become unavailable, not real targets.
- Local best/sailplan table display and curve selection, plus explicitly acknowledged selected-table exports (Expedition, Jieter or lossy canonical v1 projection). Incompatible missing speeds are rejected rather than filled.
- Explicit v2 active-document acknowledgment to protect consumer rollout; the active-pointer shape is unchanged and no shared sailplan selection is introduced.

### Changed
- Prepare calculation data only for the active polar and specifically requested polars, avoiding startup work and memory use for unused stored tables.
- Use published `polar-format` 2 for both document versions. No automatic migration or package version change.
- V2 curves use the agreed `Polar.fromPolarSet` API when available. Published `polar-math` 1.1.1 remains pinned by the existing dependency range and cannot render v2: return an explicit 503 until a compatible release is selected. Integration verification uses an isolated immutable unreleased math commit, not a local link or production dependency.
- Preserve the newly merged in-process live-handle API: v2 handles prepare best without changing local table selection or pointer semantics; unsupported math returns an explicit `unsupported_math` result and plugin error.

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
