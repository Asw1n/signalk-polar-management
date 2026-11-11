# Polar management

Polar Management helps you keep your boat's sailing polar data organised in
Signal K. A polar describes the speed your boat can make in different wind
conditions. Sailing apps use it to estimate performance, compare routes, and
help with decisions on the water.

Requires Signal K Server >=2.31.0.

## Install

1. Open your Signal K admin UI.
2. Go to the AppStore.
3. Search for "Polar Management".
4. Click **Install** and follow the prompts.

## Find a polar for your boat

After installation, open the Polar Management page and choose the import
option. You can search for your boat model or hull type with the ORC import,
then choose and import the closest match. You can also import a polar file
provided for your boat.

The ORC importer currently uses a service that ORC plans to discontinue on
**31 January 2027**. The importer will need to be updated before then.

## Choose the active polar

On the **Active polar** page, select a stored polar. If it has sailplans, you
can choose one as well. This selection is shared with the sailing apps that use
your polar.

The **Adjustments** card lets you change the shared performance factor
(0–100%) and, when available, turn wave correction on or off. Changes take
effect immediately. These adjustments do not change the graph, which shows the
unadjusted polar.

## View or edit a stored polar

Choose **Open** beside a polar in **Stored polars** to view its details, curves,
tables, and targets. You can edit boat details, view available sailplans, and
add or remove supported data. Editing requires Signal K administrator access.

## Export

In the **Open** view, export the complete polar to keep all its information.
Other export formats contain a single table and may leave out information,
especially for polars with multiple sailplans or extra data.

## Access

Signal K read-only users can view polars and download exports. Importing,
searching external sources, and making changes require administrator access.
The Signal K server controls access to its standard resource API.

## For developers

For plugin integration, data formats, API details, and test guidance, see the
[developer guide](https://github.com/Asw1n/signalk-polar-management/blob/main/docs/developer-guide.md).
The detailed
[in-process API guide](https://github.com/Asw1n/signalk-polar-management/blob/main/docs/in-process-api.md)
describes how other plugins can use the calculation service.
