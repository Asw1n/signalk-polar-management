# signalk-polar-management

Signal K plugin that stores, imports, exports, and selects **canonical polar tables**, following the
[`polar-format`](https://github.com/Asw1n/polar-format) specification (SI units: `tws=m/s`, `twa=rad`, `boatSpeed=m/s`).

This plugin owns polar **storage and selection** only — it does not compute performance, VMG, or optimum
angles. Compute plugins (e.g. wind-performance) resolve the active polar via the Signal K Resource API and
the `vessels.self.polars.activePolar` pointer published by this plugin.

## Compatible Signal K server versions

`>=2.28.0`

## Installation

Install via the Signal K AppStore, or:

```shell
cd ~/.signalk
npm install signalk-polar-management
```

## What it does

- Registers a Signal K **Resource Provider** for resource type `polars`
  (`GET/PUT/POST/DELETE /signalk/v2/api/resources/polars/<id>`).
- Publishes the active polar as `vessels.self.polars.activePolar = { href: "/resources/polars/<id>" }`.
  The active polar id itself is a persisted plugin setting; the Signal K path is the plugin's output only.
- Provides a webapp (`/signalk-polar-management/`) to:
  - list, rename, and delete stored polars
  - select the active polar
  - view a polar's boat-speed curves (only derived beat/run targets that are present in the canonical
    document are shown; nothing is computed by this plugin)
  - import a polar from a file (Jieter/ORC matrix text, Expedition text) or from the ORC active
    certificates database
  - export a polar as canonical JSON, Jieter text, or Expedition text

## HTTP endpoints

See [openApi.json](openApi.json) for the full reference, exposed in the Admin UI's API docs.

| Method & path | Purpose |
|---|---|
| `GET /polars` | List stored polars with metadata |
| `GET/PUT/DELETE /polars/:id` | Read, replace, or delete a stored polar |
| `POST /polars/:id/rename` | Rename a stored polar |
| `GET /polars/:id/export/:format` | Export as `json`, `jieter`, or `expedition` |
| `GET/PUT /activePolar` | Read or set the active polar id |
| `GET /imports/formats` / `POST /imports/text/:format` | List/import supported text formats |
| `GET /imports/sources` / `GET /imports/sources/:source/search` / `POST /imports/sources/:source/items/:externalId` | External sources (ORC) |

## Known limitations

- Import/export text formats currently supported: Jieter/ORC matrix text, Expedition text.
- Deleting the active polar is rejected; select a different active polar first.
- Only port/starboard-symmetric canonical polars are supported (per `polar-format` v1).
