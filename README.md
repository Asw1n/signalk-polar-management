# Polar management

This plugin helps you keep your boat's sailing polar data organised in Signal K.

If you are not sure what a polar is, think of it as the speed your boat should make in different wind conditions. It is used by sailing apps to estimate performance, compare routes, and help with decisions on the water.

This plugin makes it easy to store more than one polar, pick the one you want to use, and manage it from a simple interface.

Requires Signal K Server >=2.31.0.

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
- Lets you choose which polar is the active one.
- Makes it easier to import a polar from a file or an external source.
- Helps other sailing tools use the correct polar without having to edit raw files by hand.

## Why this is useful

This plugin is most useful when used together with other sailing apps in Signal K. Those apps can do the actual performance calculations, routing help, or sailing analysis, but they need a good polar to work with.
