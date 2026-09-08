# TODO

- Add `app.debug` logging for plugin lifecycle/state (e.g. "Starting", "Plugin started", provider registration) similar to the other plugins in the family (advancedwind, speedandcurrent, signalk-polar-performance-plugin). Currently the only visible evidence in logs that this plugin is running is indirect (e.g. downstream subscriptions to `polars.activePolar`/`polars.performanceFactor` succeeding), which made debugging the activePolar delivery issue harder than necessary.
