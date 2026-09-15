# Changelog

## Unreleased

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
