# Interactive Running Track Viewer

A lightweight, purely client-side web application designed to visualize, audit, and visually tune track geometries using Leaflet and WebAssembly.

This tool reads a local SQLite database of running track coordinates and renders them on an interactive map. It is designed to rapidly audit database entries around the world.

This SQLite database is located in `GARMIN\SQL` forlder on the watch.
You should be able to get it from backup made with Garmin Express
Please note that original file has name extension `.db` which should be changed to `.sqlite` for this app to work.

## Features

* **Zero-Backend Architecture:** Uses `sql-wasm.js` (WebAssembly) to load and parse the SQLite database entirely in the browser's memory. No server required.
* **Geospatial Rendering:** Maps tracks dynamically using Leaflet, calculating precise ovals based on coordinate centers, straightaway lengths, and angles.
* **Auto-Play Auditing:** A built-in interval timer that automatically pans through the database track-by-track for hands-free visual inspection.
* **Live Visual Editor:** An interactive UI to fix shifted GPS coordinates, incorrect angles, or malformed track radii. Features a reverse-math engine that spits out raw Garmin-formatted database integers (semicircles and centi-units) for easy copying.
* **Layer Toggling:** Instantly swap between standard OpenStreetMap vector tiles and high-resolution Esri Satellite imagery.

## Repository Structure

```text
├── 006-DA389-00.sqlite    # The track database (Must be provided by user)
├── app.js                 # Core application logic, geometry math, and UI handlers
├── index.html             # Main entry point
├── sql-wasm.js            # SQLite WebAssembly loader
├── sql-wasm.wasm          # SQLite WebAssembly binary
└── lib/                   # Localized Leaflet libraries and marker assets
```

## Usage Guide

* **Navigate:** Click any green cluster marker to dive into a specific region, or use the **Track ID Search** box in the top left to jump directly to a known database entry.
* **Auto-Play:** Click the `▶️ Auto-Play` button to automatically cycle through tracks. Press it again, hit the `Esc` key, or manually interact with a track to pause.
* **Edit Mode:** When viewing a track's telemetry card, click `✏️ Edit`. A draggable center pin and slider panel will appear. Align the track with the satellite imagery, and copy the new Garmin values from the dark terminal box at the bottom of the panel. *(Note: Edit mode is visual only; it does not write back to the `.sqlite` file).*

## Author
**pdurys**