# ORC API

Official API documentation: <https://sas.orc.org/api-docs.php>

The new endpoints include an API key in the URL path (`/api/{key}/...`). ORC says to request a key from the Developers page linked at the foot of <https://sas.orc.org/>.

## Impact on Polar Management

The ORC importer currently uses the legacy `WPub.dll` service:

- `action=activecerts` returns the active certificate index as XML. The importer parses `<ROW>` elements.
- `action=DownBoatRMS&RefNo=...&ext=json` returns RMS performance data as JSON. The importer converts its `rms[0].Allowances` to the canonical polar format.

ORC says `WPub.dll` will stop serving requests on **31 January 2027**. After that date, searches cannot refresh the certificate index and new RMS imports fail. A stale certificate cache may temporarily allow searches, but it is not a replacement for migration and RMS responses are not cached.

## New API endpoints relevant to the importer

- `GET /api/{key}/activecerts` returns JSON, with certificate rows under `data.rows` (rather than the legacy XML `<ROW>` format). It accepts optional filters combined with AND: `Family` (number, not a code such as `ORC`), `VPPYear`, `CountryId`, `RefNo`, `YachtName`, `SailNo`, and `Class`. With no filters it returns several thousand certificates.
- `GET /api/{key}/DownBoatRMS_byrefno?RefNo=...&ext=json` gets RMS data for a specific certificate. `RefNo` and `ext` are required. An unknown reference returns `{"rms":[]}`. Its JSON contains `rms` without the `Countries` and `ScoringOptions` fields; this matches the portion currently read by the polar converter.

The new API therefore does not make this a URL-only change. Certificate discovery needs to read the JSON envelope and rows. The existing RMS conversion can likely be reused, but should be tested against an API response fixture. API-key configuration and secure handling must also be added. Server-side filters may reduce the amount of certificate data downloaded, but their AND and pattern matching semantics need to be reconciled with the importer's existing free-text search before changing search behavior.

## Migration checklist

- Add a way to configure the API key without exposing it in browser-facing source or responses.
- Switch certificate discovery to the new `activecerts` JSON endpoint and normalize its `data.rows` to the importer's existing entry shape.
- Switch RMS fetches to `DownBoatRMS_byrefno`, retaining `ext=json`.
- Test representative documented API responses, including empty/unknown certificate results, and verify the canonical polar output remains unchanged.
- Decide whether to remove the legacy service immediately or temporarily retain a controlled fallback before its retirement date.
