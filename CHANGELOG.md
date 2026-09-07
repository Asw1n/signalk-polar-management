# Changelog

## 0.1.0 - Unreleased

- Initial extraction from `signalk-polar-performance-plugin`: polar storage, selection, import
  (Jieter/ORC matrix text, Expedition text, ORC active certificates), export (JSON, Jieter, Expedition),
  and a management webapp. Registers as a Signal K Resource Provider for type `polars` and publishes
  `vessels.self.polars.activePolar`.
- Added a webapp-adjustable polar performance factor published at
  `vessels.self.polars.performanceFactor`, with metadata for both plugin-owned Signal K output paths.
- Added `GET /polars/:id/curves`, which uses `polar-math` to sample each TWS curve at a fixed angular
  step (5° by default) across the full valid TWA range, so the webapp draws complete polar lines
  including pinch and run extrapolation.
