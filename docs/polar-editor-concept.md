# Graph-based polar editor concept

Status: exploratory design, not an implementation specification. Open questions
below still need decisions before development.

## Goal

Extend Modify with a graph-first editor that combines intuitive changes,
immediate visual feedback, and precise numeric input. Keep the existing webapp's
look and feel, including its cards, buttons, form controls, and offline operation.

Ordinary point editing changes boat speed at a fixed TWA and TWS. Changing the
grid is a separate, deliberate operation.

## Selection and numeric inspector

Use three selection types:

1. A stored boat-speed point.
2. A TWA or TWS grid anchor.
3. A beat or run target point.

A consistent inspector beside or below the graph shows the selected item's
values and available actions. Highlight the selection and its curve; dim other
curves when useful.

Only actual stored points are editable handles. Interpolated and extrapolated
curve samples must not look like independently editable data.

### Boat-speed points

Selecting a point displays its fixed TWS and TWA and an editable boat speed:

```text
TWS 10 kn / TWA 60 degrees
Boat speed: [6.25] kn
[Apply]
```

The point can also be dragged radially along its fixed TWA line. Numeric editing
and dragging modify the same underlying speed value.

Proposed interaction:

- Apply or Enter accepts a numeric edit into the draft.
- Escape cancels the current numeric edit.
- Accepted numeric edits and dragging update the draft graph immediately.
- Keep the graph scale fixed during a drag so it does not move under the pointer.
- Treat one complete drag as one Undo operation.

Apply and Enter are proposals; the exact acceptance interaction remains to be
confirmed. Accepting an individual edit is distinct from saving the complete
editing session.

## Grid anchors

### TWA anchors

Place selectable angle markers around the outer arc. Selecting an angle selects
that TWA across every TWS curve. Highlight all affected speed points before
offering deletion.

Deletion should explain its scope, for example:

> Delete TWA 60 degrees and its speed values from all curves?

Angle modification may be supported later through an explicit inspector action.
Do not make normal point dragging change the shared TWA axis.

### TWS anchors

TWS identifies curves rather than a spatial axis on the polar diagram. Use
selectable legend entries or chips, for example:

```text
[6 kn] [8 kn] [10 kn] [12 kn]
```

Selecting an entry highlights its curve and offers deletion of that TWS and all
its speed values. Modification of an existing TWS remains an open option.

All grid changes should be undoable. Prevent deletion that leaves an unusable
polar.

### Adding a TWA or TWS

Provide Add TWA and Add TWS buttons with numeric inputs. Initialise new speed
values using the existing polar calculations where appropriate.

Calculate defaults from a snapshot of the draft before inserting the axis value.
Partly initialised new data must not influence its own interpolation.

| Operation | Proposed default |
| --- | --- |
| Add a TWA within the available data span | Sample existing curves where speeds are available |
| Add a TWS between existing curves | Interpolate between those curves |
| Add outside the available range | Require an explicit policy; distinguish extrapolation or clamping from interpolation |
| Calculation returns no usable speed | Require resolution; never silently insert zero |

Unavailable speeds can occur near the no-go region. Their handling needs a
specific design because the stored matrix does not support missing cells.

Adding interpolated points can slightly change the subsequently fitted curve;
it is not necessarily a mathematically neutral operation.

Changing an existing axis value also needs explicit semantics:

- **Move data:** associate existing speeds with a different angle or wind speed.
- **Resample:** calculate replacement speeds at the new axis value.

Neither should silently substitute for the other.

## Beat and run targets

Beat and run markers are selectable and show TWA, boat speed, and VMG in the
inspector.

These are not three independent quantities:

```text
signed VMG = boat speed * cos(TWA)
```

Proposed initial behaviour:

- TWA is editable.
- Boat speed is editable.
- VMG is calculated immediately and read-only.

If editable VMG is required, offer it as an alternative input that calculates
speed while keeping TWA fixed. Handle the instability near 90 degrees explicitly.

Choose and label the downwind convention: signed VMG or positive downwind VMG
magnitude. Convert consistently between the displayed and stored conventions.

Imported beat/run targets participate in curve construction; they are not merely
annotations. Editing them can change the curve, and editing ordinary speed points
can leave imported targets inconsistent with the new shape.

Before implementation, decide how to preserve, edit, or recalculate these targets
and how to handle stored maximum-speed information. Do not silently discard or
retain stale target data without a defined policy.

## Observed sailing data overlay

Use a Signal K history provider, which provides recorded deltas, as the source of
sailing observations. Retrieval and alignment of the recorded wind and boat-speed
measurements remain to be defined.

For the selected TWS curve:

- Show only observations within plus or minus 1 knot of the selected TWS.
- Plot each observation at its actual TWA and boat speed. Do not snap or project
  observations onto a TWA grid axis.
- Colour observations by observed TWS minus selected TWS, with a visible legend.
  The exact palette remains to be chosen.
- Keep observation markers visually distinct from editable polar handles.

Observations provide evidence for manually adjusting a polar point; they do not
automatically replace polar values. Keep them read-only and separate from the
stored polar document.

Provide additional observation filters. Their criteria and interface are to be
determined later.

## Input limits and validation

Separate invalid data from unusual but potentially legitimate sailing data.

### Hard constraints

- All numeric values must be finite.
- Boat speeds must be non-negative.
- TWS must be strictly positive.
- TWA must remain within 0 to 180 degrees.
- Axis values must be unique and strictly increasing.
- Matrix dimensions must match the axes.
- Beat and run targets must stay in their respective upwind/downwind domains.
- Target VMG must be consistent with angle and speed.
- Grid deletion must retain a usable polar.
- Blank or unavailable speed values must not silently become zero.

The exact target-angle bounds and minimum usable grid size remain to be defined.
The file format permits very small tables, but schema validity alone does not
guarantee useful editing or curve behaviour.

### Warnings rather than prohibitions

Consider warnings for:

- Sharp spikes relative to neighbouring points.
- Speed decreasing as TWS increases.
- Unusually large boat speeds.
- Beat/run targets that no longer appear to give the best VMG.

Do not automatically force monotonic speed growth or a supposedly correct curve
shape. Such constraints can reject legitimate data.

## Session behaviour and safeguards

- Work on a draft; do not persist individual point movements.
- Save commits the complete draft; Cancel discards the session.
- Provide Undo/Redo for numeric edits, dragging, target edits, and grid changes.
- Offer Save as copy to preserve imported originals.
- Consider an original-polar overlay for comparison.
- Mirror edits across port and starboard because the format is symmetric.
- Edit the base polar without applying the performance-factor reduction.
- Preserve full stored precision; display rounding must not alter untouched data.
- Protect against overwriting changes saved by another editing session.
- Preserve source and notes unless the user explicitly changes them.

Use distinct marker shapes for speed points, beat targets, and run targets. Where
handles overlap, allow curve selection first or provide a small selection chooser.
Provide usable touch targets and numeric/keyboard alternatives to dragging.

## Existing implementation context

- [The current graph renderer](../public/polar-canvas.js) renders sampled curves;
  editable handles would need to be tied to original stored values.
- [CurveService](../lib/CurveService.js) uses polar-math for interpolation, targets,
  and extrapolation. Draft previews should use the same calculation semantics as
  consumers rather than an unrelated visual smoothing algorithm.
- The canonical document stores TWS and boat speed in m/s and TWA in radians.
  The editor can display knots and degrees while converting at its boundaries.
- The speed matrix is indexed by TWS row and TWA column. Structural edits must
  keep both axes and every matrix entry aligned.

## Decisions still open

1. Exact numeric-edit acceptance interaction: button, Enter, or both.
2. Whether existing TWA/TWS anchors can be modified as well as deleted.
3. Move-versus-resample behaviour for modified axis values.
4. Initialisation outside the available range and for unavailable interpolated speeds.
5. Beat/run editing bounds, VMG input behaviour, and downwind sign convention.
6. Preservation or recalculation of imported targets and maximum-speed information.
7. Minimum usable grid dimensions and appropriate warning thresholds.
8. Whether previews run locally or through a draft-preview endpoint.
9. History retrieval and additional observation filters.

No grid library is required for this graph-first concept. The central investment
is a reliable draft-editing model shared by graph interactions, numeric inputs,
validation, previews, and Undo/Redo.
