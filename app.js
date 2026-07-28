// Minimal Track Viewer app.js
// Uses Leaflet, sql.js, and Leaflet.markercluster

// ==========================================
// 1. CONFIGURATION & STATE
// ==========================================

const R_EARTH = 6371000; 
const DEG_PER_UNIT = 180 / Math.pow(2, 31); 

// Global State
let map, db, sql;
let allTracks = []; 

// Map Layers
let trackLayer;     
let clusterLayer;   
let boundsLayer;    
let osmLayer, satelliteLayer;
let currentLayer = 'osm'; // Tracks which layer is currently active

// History tracking for back button
let previousZoomLevel = null;
let previousMapCenter = null;

let isAutoPlaying = false;
let autoPlayTimer = null;
const AUTO_PLAY_DELAY = 2800; // 2.8 seconds to allow for tile loading

// ==========================================
// 2. UTILITY & CONVERSION FUNCTIONS
// ==========================================

function toDegreesFromGarmin(value) { return value * DEG_PER_UNIT; }
function centidegToDeg(value) { return value / 100.0; }
function metersFromStored(value) { return (value == null) ? null : value / 100.0; }
function degToRad(d) { return d * Math.PI / 180; }
function radToDeg(r) { return r * 180 / Math.PI; }

function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const φ1 = degToRad(lat), λ1 = degToRad(lon), θ = degToRad(bearingDeg), δ = distanceM / R_EARTH;
  const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1), sinδ = Math.sin(δ), cosδ = Math.cos(δ);
  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const y = Math.sin(θ) * sinδ * cosφ1, x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return [radToDeg(φ2), (radToDeg(λ2) + 540) % 360 - 180]; 
}

function formatDMS(deg) {
  const sign = deg < 0 ? -1 : 1;
  deg = Math.abs(deg);
  const d = Math.floor(deg), mFloat = (deg - d) * 60, m = Math.floor(mFloat), s = (mFloat - m) * 60;
  return `${sign < 0 ? '-' : ''}${d}° ${m}' ${s.toFixed(2)}"`;
}

function computeTrackLength(straightM, radiusM) {
  if (straightM == null) return null;
  if (radiusM == null) return 2 * straightM; 
  
  const curbOffset = 0.3; // Standard IAAF functional track offset
  return 2 * straightM + 2 * Math.PI * (radiusM + curbOffset);
}

// ==========================================
// 3. GEOMETRY BUILDERS
// ==========================================

function buildOvalPoints(centerLat, centerLon, angleDeg, straightM, radiusM, samplesPerArc = 28) {
  if (!straightM || straightM <= 0) return [];
  if (!radiusM || radiusM <= 0) {
    const half = straightM / 2;
    const pA = destinationPoint(centerLat, centerLon, angleDeg, half);
    const pB = destinationPoint(centerLat, centerLon, (angleDeg + 180) % 360, half);
    return [pA, pB, pA];
  }

  const lat0 = centerLat, lon0 = centerLon;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * degToRad(lat0)) + 1.175 * Math.cos(4 * degToRad(lat0));
  const mPerDegLon = 111412.84 * Math.cos(degToRad(lat0)) - 93.5 * Math.cos(3 * degToRad(lat0));
  const xyToLL = (x, y) => [lat0 + y / mPerDegLat, lon0 + x / mPerDegLon];

  const θ = degToRad(angleDeg);
  const ux = Math.sin(θ), uy = Math.cos(θ); 
  const vx = Math.cos(θ), vy = -Math.sin(θ); 

  const halfStraight = straightM / 2;
  const C1 = [ux * halfStraight, uy * halfStraight];
  const C2 = [-ux * halfStraight, -uy * halfStraight];
  const pts = [];
  const straightSamples = Math.max(2, Math.round(Math.min(12, straightM / 50)));

  for (let i = 0; i <= samplesPerArc; i++) {
    const a = Math.PI * (1 - i / samplesPerArc); 
    pts.push(xyToLL(C1[0] + radiusM * (vx * Math.cos(a) + ux * Math.sin(a)), C1[1] + radiusM * (vy * Math.cos(a) + uy * Math.sin(a))));
  }

  const T1xy = [C1[0] + radiusM * vx, C1[1] + radiusM * vy], T2xy = [C2[0] + radiusM * vx, C2[1] + radiusM * vy];
  for (let i = 1; i <= straightSamples; i++) {
    const f = i / straightSamples;
    pts.push(xyToLL(T1xy[0] + (T2xy[0] - T1xy[0]) * f, T1xy[1] + (T2xy[1] - T1xy[1]) * f));
  }

  for (let i = 1; i <= samplesPerArc; i++) {
    const a = 0 - Math.PI * (i / samplesPerArc); 
    pts.push(xyToLL(C2[0] + radiusM * (vx * Math.cos(a) + ux * Math.sin(a)), C2[1] + radiusM * (vy * Math.cos(a) + uy * Math.sin(a))));
  }

  const T3xy = [C2[0] - radiusM * vx, C2[1] - radiusM * vy], T4xy = [C1[0] - radiusM * vx, C1[1] - radiusM * vy];
  for (let i = 1; i <= straightSamples; i++) {
    const f = i / straightSamples;
    pts.push(xyToLL(T3xy[0] + (T4xy[0] - T3xy[0]) * f, T3xy[1] + (T4xy[1] - T3xy[1]) * f));
  }

  return pts;
}

function buildDynamicBounds(t) {
  if (!t.lat || !t.lon || !t.radiusM) return [];
  const halfLength = (t.straightM / 2) + t.radiusM, halfWidth = t.radiusM; 
  const cornersM = [[-halfWidth, -halfLength], [-halfWidth, halfLength], [halfWidth, halfLength], [halfWidth, -halfLength]];

  const lat0 = t.lat, lon0 = t.lon;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * degToRad(lat0));
  const mPerDegLon = 111412.84 * Math.cos(degToRad(lat0));
  const θ = degToRad(-t.angle), cos = Math.cos(θ), sin = Math.sin(θ);

  return cornersM.map(c => {
    const rx = c[0] * cos - c[1] * sin, ry = c[0] * sin + c[1] * cos;
    return [lat0 + ry / mPerDegLat, lon0 + rx / mPerDegLon];
  });
}

// ==========================================
// 4. INITIALIZATION & DATA LOADING
// ==========================================

function initMap() {
  map = L.map('map').setView([0, 0], 2);
  
  // Define standard map layer
  osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  });

  // Define satellite layer
  satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles © Esri'
  });

  // Set default starting layer
  osmLayer.addTo(map);

  // Initialize MarkerCluster Plugin layer
  clusterLayer = L.markerClusterGroup({
    chunkedLoading: true,      
    maxClusterRadius: 50,      
    showCoverageOnHover: false 
  });

  trackLayer = L.layerGroup();
  boundsLayer = L.layerGroup().addTo(map); 

  map.on('zoomend moveend', renderByZoom);

  // =========================================================================
  // MANUAL TRACK SEARCH CONTROL (POSITIONED TO THE RIGHT OF ZOOM BUTTONS)
  // =========================================================================
  const SearchControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      // Create the main container element
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-search-control');
      
      // Create Auto-Play button
      const autoBtn = L.DomUtil.create('button', '', container);
      autoBtn.id = 'autoplay-btn';
      autoBtn.innerHTML = '▶️ Auto-Play';
      autoBtn.style.width = '85px';
      autoBtn.style.height = '30px';
      autoBtn.style.boxSizing = 'border-box'; // The magic fix
      autoBtn.style.cursor = 'pointer';
      autoBtn.style.border = '1px solid #ccc';
      autoBtn.style.borderRadius = '4px';
      autoBtn.style.backgroundColor = '#f4f4f4';
      autoBtn.style.fontSize = '11px';

      // Emulate CSS :hover
      autoBtn.onmouseenter = () => autoBtn.style.backgroundColor = '#e0e0e0';
      autoBtn.onmouseleave = () => autoBtn.style.backgroundColor = '#f4f4f4';
      
      autoBtn.onclick = window.toggleAutoPlay;

      // DYNAMIC ALIGNMENT: Remove absolute offsets and leverage standard margins
      container.style.clear = 'none'; // Prevent Leaflet from dropping this control to a new row!
      container.style.display = 'flex';
      container.style.gap = '3px';
      container.style.backgroundColor = '#ffffff';
      container.style.padding = '5px';
      container.style.borderRadius = '4px';
      container.style.boxShadow = '0 1px 5px rgba(0,0,0,0.65)';
      
      // Match Leaflet's precise structural alignment with the adjacent zoom panel
      container.style.marginTop = '10px';
      container.style.marginLeft = '5px'; // Small gap between the zoom buttons and our box

      // Create input box
      const input = L.DomUtil.create('input', '', container);
      input.type = 'number';
      input.placeholder = 'Track ID...';
      input.style.width = '85px';
      input.style.height = '30px';
      input.style.boxSizing = 'border-box'; // The magic fix
      input.style.padding = '0 6px';
      input.style.border = '1px solid #ccc';
      input.style.borderRadius = '4px';
      input.style.fontSize = '12px';
      input.style.outline = 'none';

      // Create search action button
      const button = L.DomUtil.create('button', '', container);
      button.innerHTML = '🔍';
      button.style.width = '30px';
      button.style.height = '30px';
      button.style.boxSizing = 'border-box'; // The magic fix
      button.style.cursor = 'pointer';
      button.style.border = '1px solid #ccc';
      button.style.borderRadius = '4px';
      button.style.backgroundColor = '#f4f4f4';
      button.style.display = 'flex';
      button.style.alignItems = 'center';
      button.style.justifyContent = 'center';

      // Emulate CSS :hover
      button.onmouseenter = () => button.style.backgroundColor = '#e0e0e0';
      button.onmouseleave = () => button.style.backgroundColor = '#f4f4f4';

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      const performSearch = () => {
        const trackId = parseInt(input.value);
        if (!trackId || isNaN(trackId)) return;
        window.jumpToTrackById(trackId);
      };

      button.onclick = performSearch;
      input.onkeydown = (e) => { if (e.key === 'Enter') performSearch(); };

      return container;
    }
  });

  map.addControl(new SearchControl());

  // =========================================================================
  // DYNAMIC RIGHT SIDE CONTROLS (MIRRORS LEFT SIDE CONTAINER AESTHETICS)
  // =========================================================================
  const RightControls = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      // Create the parent container wrapping both buttons
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control responsive-right-panel');
      
      // Match the Left side container styling exactly
      container.style.display = 'flex';
      container.style.flexDirection = 'column'; // Stack vertically on the right
      container.style.gap = '5px';
      container.style.backgroundColor = '#ffffff';
      container.style.padding = '5px';
      container.style.borderRadius = '4px';
      container.style.boxShadow = '0 1px 5px rgba(0,0,0,0.65)';
      container.style.marginTop = '10px';
      container.style.marginRight = '10px';
      
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      // Shared inline styling for both buttons to match the inner buttons on the left
      const applyBtnStyles = (btn) => {
        btn.style.width = '150px';
        btn.style.height = '30px'; // Perfectly matches the 30px height of left elements
        btn.style.boxSizing = 'border-box';
        btn.style.cursor = 'pointer';
        btn.style.border = '1px solid #ccc';
        btn.style.borderRadius = '4px';
        btn.style.backgroundColor = '#f4f4f4';
        btn.style.fontFamily = 'Arial, sans-serif';
        btn.style.fontWeight = 'bold';
        btn.style.fontSize = '12px';
        
        // Emulate CSS :hover
        btn.onmouseenter = () => btn.style.backgroundColor = '#e0e0e0';
        btn.onmouseleave = () => btn.style.backgroundColor = '#f4f4f4';
      };

      // Create Satellite Toggle Button
      const toggleBtn = L.DomUtil.create('button', '', container);
      toggleBtn.id = 'layer-toggle-btn';
      toggleBtn.innerHTML = '🛰️ Satellite View';
      applyBtnStyles(toggleBtn);
      toggleBtn.onclick = window.toggleMapLayer;

      // Create Back Button
      const backBtn = L.DomUtil.create('button', '', container);
      backBtn.id = 'back-btn';
      backBtn.innerHTML = '← Back to Overview';
      applyBtnStyles(backBtn);
      backBtn.style.display = 'none'; // Hidden by default
      backBtn.onclick = window.goBackToPreviousView;

      return container;
    }
  });

  map.addControl(new RightControls());

  // Dismiss interactive cards and bounds when clicking the map background
  map.on('click', () => {
    if (typeof window.closeInteractiveTelemetryCard === 'function') {
      window.closeInteractiveTelemetryCard();
    }
  });
}

async function initSqlJsAndBind() {
  const SQL = await initSqlJs({ locateFile: file => file });
  sql = SQL;
  
  try {
    const response = await fetch('006-DA389-00.sqlite');
    if (!response.ok) throw new Error("Could not find database file.");
    const ab = await response.arrayBuffer();
    db = new sql.Database(new Uint8Array(ab));
    
    console.log("⏱️ LOG [3]: Database parsed. Loading tracks into memory array...");
    await loadTracksFromDb();
    
    // Check if the user arrived via a deep link
    const urlParams = new URLSearchParams(window.location.search);
    const hasUrlId = urlParams.has('id');
    
    if (!window.isAutomationRun && !hasUrlId) {
      console.log("⏱️ LOG [4a]: Normal session. Rendering all markers and fitting bounds.");
      renderByZoom();
      fitMapToTracks();
    } else if (window.isAutomationRun) {
      console.log("⏱️ LOG [4b]: 🤖 AUTOMATION DETECTED. Skipping global view changes!");
    }
  } catch (error) {
    console.error("Auto-load failed:", error);
  }
}

async function handleFileSelect(evt) {
  const f = evt.target.files[0];
  if (!f) return;
  const ab = await f.arrayBuffer();
  db = new sql.Database(new Uint8Array(ab));
  await loadTracksFromDb();
  renderByZoom();
  fitMapToTracks();
}

async function loadTracksFromDb() {
  allTracks = [];
  try {
    const query = `SELECT Id, CenterLat, CenterLong, Angle, StraightawayLength, InsideRadius FROM Tracks`;
    const stmt = db.prepare(query);
    
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const id = row.Id;
      const lat = (row.CenterLat != null) ? toDegreesFromGarmin(row.CenterLat) : null;
      const lon = (row.CenterLong != null) ? toDegreesFromGarmin(row.CenterLong) : null;
      const angle = (row.Angle != null) ? centidegToDeg(row.Angle) : 0;
      
      // Inside loadTracksFromDb() loop...
      let straightM = (row.StraightawayLength != null) ? metersFromStored(row.StraightawayLength) : null;
      let radiusM = (row.InsideRadius != null) ? metersFromStored(row.InsideRadius) : null;
      let assumedRadius = false;
      let assumedStraight = false;

      // 1. Handle absolute fallback if the straightaway itself is missing/zero
      if (straightM === null || straightM === 0) { 
        straightM = 84.39; 
        assumedStraight = true; 
      }

      // 2. DYNAMIC RADIUS FIX: If radius is missing, calculate the exact radius 
      // needed to make this specific straightaway length result in a 400m track.
      if (radiusM === null || radiusM === 0) {
        const curbOffset = 0.3; // IAAF standard lane 1 line offset from curb
        const targetLength = 400.0;
        
        // Reverse-engineered IAAF formula
        radiusM = ((targetLength - (2 * straightM)) / (2 * Math.PI)) - curbOffset;
        
        // Safety check: ensure a freak database value doesn't cause a negative radius
        if (radiusM < 5) radiusM = 36.5; 
        
        assumedRadius = true;
      }
      
      // Calculate the length. 
      // If it used our dynamic radius above, this will equal exactly 400.0m.
      const lengthM = computeTrackLength(straightM, radiusM);

      allTracks.push({ id, lat, lon, angle, straightM, radiusM, lengthM, assumedRadius, assumedStraight });
    }
    stmt.free();
    
    // One-time build of all markers for the cluster layer
    populateClusters();
  } catch (e) {
    console.error("Error reading DB:", e);
  }
}

function populateClusters() {
  clusterLayer.clearLayers();
  const markers = [];
  
  for (const t of allTracks) {
    if (t.lat == null || t.lon == null) continue;
    
    // Create the circle marker for individual tracks inside clusters
    const m = L.circleMarker([t.lat, t.lon], { 
      radius: 8,                    // Slightly larger visual core (or keep at 5)
      weight: 12,                   // Invisible wide stroke expanding the click area
      color: 'transparent',         // Makes the expanded stroke completely invisible
      fillColor: '#2a7', 
      fillOpacity: 0.9,
      interactive: true
    });    

    // Bind the popup to the marker as before
    // m.bindPopup(buildPopupHtml(t));
    
    m.on('click', (e) => {
      // 1. Save the view state right BEFORE zooming in
      previousZoomLevel = map.getZoom();
      previousMapCenter = map.getCenter();
      
      // 2. Make the floating back button visible
      document.getElementById('back-btn').style.display = 'block';

      // 3. AUTOMATICALLY SWAP TO SATELLITE VIEW
      if (currentLayer === 'osm') {
        map.removeLayer(osmLayer);
        satelliteLayer.addTo(map);
        currentLayer = 'satellite';
        // Update the button text to show the option to switch back
        document.getElementById('layer-toggle-btn').innerHTML = "🗺️ Standard Map";
      }

      // 4. Perform the zoom to level 17
      map.setView([t.lat, t.lon], 17);
      
      // Check this out why there are two setTimeouts: 
      setTimeout(() => {
        // m.openPopup();
        setTimeout(() => {
        // Replace m.openPopup() with our new sleek overlay
        drawDynamicBoundsOnDemand(t);
        showInteractiveTelemetryCard(t);
      }, 300);
      }, 300);
    });

    markers.push(m);
  }
  clusterLayer.addLayers(markers);
}

// ==========================================
// 5. RENDERING & UI LOGIC
// ==========================================

// Function to toggle between Standard Map and Satellite Map with a single click
function toggleMapLayer() {
  const btn = document.getElementById('layer-toggle-btn');
  
  if (currentLayer === 'osm') {
    // Switch to Satellite
    map.removeLayer(osmLayer);
    satelliteLayer.addTo(map);
    currentLayer = 'satellite';
    btn.innerHTML = "🗺️ Standard Map"; // Button changes to offer switching back
  } else {
    // Switch to Standard Map
    map.removeLayer(satelliteLayer);
    osmLayer.addTo(map);
    currentLayer = 'osm';
    btn.innerHTML = "🛰️ Satellite View"; // Button changes to offer satellite again
  }
}

// Function to return to the previous view state AND reset the map background
function goBackToPreviousView() {
  // 1. Instantly dismiss any open track details card and clear the bounding box
  if (typeof window.closeInteractiveTelemetryCard === 'function') {
    window.closeInteractiveTelemetryCard();
  }

  if (previousZoomLevel !== null && previousMapCenter !== null) {
    // 2. Return map to exactly where it was before the dive
    map.setView(previousMapCenter, previousZoomLevel);
    
    // 3. FORCE SWAP BACK TO STANDARD MAP
    if (currentLayer === 'satellite') {
      map.removeLayer(satelliteLayer);
      osmLayer.addTo(map);
      currentLayer = 'osm';
      
      // Update the button text so it matches the state
      document.getElementById('layer-toggle-btn').innerHTML = "🛰️ Satellite View";
    }
  }
  
  // 4. Hide the back button again until the next deep dive
  document.getElementById('back-btn').style.display = 'none';
  // ==========================================================
  // DEEP LINKING: Clear the ID from the URL
  // ==========================================================
  const newUrl = new URL(window.location.href);
  newUrl.searchParams.delete('id');
  window.history.pushState({ path: newUrl.href }, '', newUrl.href);
}

function renderByZoom() {
  // FIX: If an automated script is capturing frames, freeze the background layer manager
  if (window.isAutomationRun) {
    console.log("🤖 Automation Lock active. Blocking background layer rendering updates.");
    return;
  }

  const zoom = map.getZoom();

  if (zoom >= 14) {
    // Zoomed IN: Hide clusters, show physical tracks
    if (map.hasLayer(clusterLayer)) map.removeLayer(clusterLayer);
    if (!map.hasLayer(trackLayer)) map.addLayer(trackLayer);

    trackLayer.clearLayers();
    boundsLayer.clearLayers(); 

    // Performance Boost: Only draw tracks currently visible on screen
    const bounds = map.getBounds().pad(0.1);
    for (const t of allTracks) {
      if (t.lat == null || t.lon == null) continue;
      if (bounds.contains([t.lat, t.lon])) {
        drawTrack(t);
      }
    }
  } else {
    // Zoomed OUT: Hide tracks, rely entirely on MarkerCluster magic
    if (map.hasLayer(trackLayer)) map.removeLayer(trackLayer);
    if (!map.hasLayer(clusterLayer)) map.addLayer(clusterLayer);
    boundsLayer.clearLayers();
  }
}

function drawDynamicBoundsOnDemand(t) {
  boundsLayer.clearLayers();
  const boundPts = buildDynamicBounds(t);
  if (boundPts.length > 0) {
    L.polygon(boundPts, { color: '#0066ff', weight: 2, dashArray: '4, 4', fillOpacity: 0.1 }).addTo(boundsLayer);
  }
}

function drawTrack(t) {
  const pts = buildOvalPoints(t.lat, t.lon, t.angle, t.straightM || 0, t.radiusM || 0, 20);
  const poly = L.polyline(pts, { color: '#ff3333', weight: 3, opacity: 0.9 }).addTo(trackLayer);

  poly.on('click', (e) => {
    L.DomEvent.stop(e); // Prevent map click event from firing and instantly closing the card
    drawDynamicBoundsOnDemand(t);
    showInteractiveTelemetryCard(t);
  });

  const m = L.circleMarker([t.lat, t.lon], { radius: 5, color: '#000' }).addTo(trackLayer);
  m.on('click', (e) => {
    L.DomEvent.stop(e);
    drawDynamicBoundsOnDemand(t);
    showInteractiveTelemetryCard(t);
  });
}

// =========================================================================
// INTERACTIVE TELEMETRY CARD (WITH ACTIVE ID TRACKING)
// =========================================================================

// Global state to remember which track we are currently looking at
window.activeTrackId = null;

// ADDED a flag (isAutoTransition) so it knows not to pause if the script is just turning the page
window.closeInteractiveTelemetryCard = function(isAutoTransition = false) {
  const card = document.getElementById('interactive-telemetry-card');
  if (card) card.remove();
  
  if (boundsLayer) boundsLayer.clearLayers();
  
  window.activeTrackId = null;

  // Stop auto-play ONLY if we manually interact (clicked X, hit Esc, clicked background)
  if (isAutoPlaying && !isAutoTransition) {
    console.log("🛑 Manual interaction detected. Pausing Auto-Play.");
    window.toggleAutoPlay(); 
  }
};

function showInteractiveTelemetryCard(t) {

  window.currentViewedTrack = JSON.parse(JSON.stringify(t));

  // Tell the close function that this is an automatic transition, so don't pause!
  closeInteractiveTelemetryCard(true); 

  window.activeTrackId = t.id;

  const card = document.createElement('div');
  card.id = 'interactive-telemetry-card';
  
  card.style.position = 'absolute';
  card.style.bottom = '20px';
  card.style.left = '20px';
  card.style.zIndex = '10000';
  card.style.backgroundColor = 'rgba(0, 0, 0, 0.75)';
  card.style.color = '#ffffff';
  card.style.padding = '15px';
  card.style.borderRadius = '8px';
  card.style.fontFamily = 'monospace';
  card.style.fontSize = '13px';
  card.style.lineHeight = '1.5';
  card.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
  card.style.border = '1px solid rgba(255,255,255,0.2)';
  card.style.pointerEvents = 'auto'; 
  card.style.minWidth = '220px';

  // const closeBtnHtml = `<div style="position: absolute; top: 8px; right: 10px; cursor: pointer; font-size: 16px; color: #aaaaaa; transition: color 0.2s;" onmouseover="this.style.color='#ffffff'" onmouseout="this.style.color='#aaaaaa'" onclick="closeInteractiveTelemetryCard()">✖</div>`;
  const closeBtnHtml = `
  <div style="position: absolute; top: 8px; right: 10px; display: flex; gap: 10px;">
    <div style="cursor: pointer; font-size: 14px; color: #ffeb3b; transition: color 0.2s;" onmouseover="this.style.color='#ffffff'" onmouseout="this.style.color='#ffeb3b'" onclick="activateEditMode()">✏️ Edit</div>
    <div style="cursor: pointer; font-size: 14px; color: #aaaaaa; transition: color 0.2s;" onmouseover="this.style.color='#ffffff'" onmouseout="this.style.color='#aaaaaa'" onclick="closeInteractiveTelemetryCard()">✖</div>
  </div>`;

  card.innerHTML = closeBtnHtml + `
    <b style="color: #4fc3f7; font-size: 14px;">TRACK ID: ${t.id}</b><br>
    <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.2); margin: 6px 0;">
    📍 Lat: ${t.lat.toFixed(6)}<br>
    📍 Lon: ${t.lon.toFixed(6)}<br>
    📐 Angle: ${t.angle.toFixed(2)}°<br>
    📏 Straight: ${t.straightM.toFixed(2)}m ${t.assumedStraight ? '<span style="color:#ff3333">(Assumed)</span>' : ''}<br>
    ⭕ Radius: ${t.radiusM.toFixed(2)}m ${t.assumedRadius ? '<span style="color:#ff3333">(Calculated)</span>' : ''}<br>
    🏃 Total Len: ${t.lengthM.toFixed(2)}m
  `;

  L.DomEvent.disableClickPropagation(card);
  L.DomEvent.disableScrollPropagation(card);
  document.getElementById('map').appendChild(card);
}

function fitMapToTracks() {
  if (!allTracks || allTracks.length === 0) return;
  const latlngs = allTracks.filter(t => t.lat != null && t.lon != null).map(t => [t.lat, t.lon]);
  if (latlngs.length === 0) return;
  map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
}

// ==========================================
// 6. BOOTSTRAP
// ==========================================

window.toggleAutoPlay = function() {
  const btn = document.getElementById('autoplay-btn');
  isAutoPlaying = !isAutoPlaying;

  if (isAutoPlaying) {
    btn.innerHTML = "⏸️ Pause";
    btn.style.backgroundColor = "#ffcccc";
    // Trigger the first jump immediately
    window.jumpToAdjacentTrack(1); 
  } else {
    btn.innerHTML = "▶️ Auto-Play";
    btn.style.backgroundColor = "#f4f4f4";
    clearTimeout(autoPlayTimer);
  }
};

// =========================================================================
// KEYBOARD NAVIGATION CONTROLLER (LEFT / RIGHT ARROWS)
// =========================================================================

window.jumpToAdjacentTrack = function(direction) {
  if (!window.activeTrackId || typeof db === 'undefined' || !db) return;

  const query = direction === 1 
    ? `SELECT Id FROM Tracks WHERE Id > ${window.activeTrackId} ORDER BY Id ASC LIMIT 1`
    : `SELECT Id FROM Tracks WHERE Id < ${window.activeTrackId} ORDER BY Id DESC LIMIT 1`;

  try {
    const stmt = db.prepare(query);
    if (stmt.step()) {
      const nextId = stmt.getAsObject().Id;
      stmt.free();
      console.log(`⏭️ Routing to ID: ${nextId}`);
      window.jumpToTrackById(nextId);

      // THE FIX: Chain the next jump only after the current one renders
      if (isAutoPlaying) {
        clearTimeout(autoPlayTimer); // Clear any old timers just to be safe
        autoPlayTimer = setTimeout(() => window.jumpToAdjacentTrack(1), AUTO_PLAY_DELAY);
      }
      
    } else {
      stmt.free();
      console.log("🏁 Reached the end of the database in that direction.");
      // Stop auto-play cleanly if we run out of tracks
      if (isAutoPlaying) window.toggleAutoPlay();
    }
  } catch (error) {
    console.error("❌ Adjacent navigation failed:", error);
  }
};

// Global keydown listener
window.addEventListener('keydown', (e) => {
  // CRITICAL: Do not trigger jumps if you are typing a number into the search box!
  if (e.target.tagName.toLowerCase() === 'input') return;

  if (e.key === 'ArrowRight') {
    e.preventDefault(); // Stop standard page scrolling
    window.jumpToAdjacentTrack(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    window.jumpToAdjacentTrack(-1);
  } else if (e.key === 'Escape') {
    // Bonus feature: Hitting 'Esc' dismisses the active card or goes back to overview
    if (typeof window.closeInteractiveTelemetryCard === 'function') {
      window.closeInteractiveTelemetryCard();
    }
    if (typeof window.goBackToPreviousView === 'function' && document.getElementById('back-btn')?.style.display !== 'none') {
      window.goBackToPreviousView();
    }
  }
});

// Global status flag for our automation worker
window.mapIsFullyLoaded = false; // Add at the very top

window.addEventListener('load', async () => {
  console.log("⏱️ LOG [1]: Window load event triggered. Initializing Map...");
  initMap();
  
  console.log("⏱️ LOG [2]: Fetching SQLite database...");
  await initSqlJsAndBind();
  
  window.mapIsFullyLoaded = true; 
  console.log("⏱️ LOG [5]: window.mapIsFullyLoaded set to TRUE.");

  // ==========================================================
  // DEEP LINKING: Check URL for ?id= parameter and execute jump
  // ==========================================================
  const urlParams = new URLSearchParams(window.location.search);
  const trackIdFromUrl = urlParams.get('id');
  
  if (trackIdFromUrl && !isNaN(parseInt(trackIdFromUrl))) {
    console.log(`🔗 URL deep link detected for ID: ${trackIdFromUrl}`);
    // Small timeout ensures all Leaflet map tiles are ready before the camera moves
    setTimeout(() => {
      window.jumpToTrackById(parseInt(trackIdFromUrl));
    }, 200);
  }
});

// =========================================================================
// INTERACTIVE MANUAL VIEWPORT JUMP ENGINE (DIRECT SQLITE LOOKUP)
// =========================================================================
window.jumpToTrackById = function(targetId) {
  try {
    if (typeof db === 'undefined' || !db) {
      alert("❌ The SQLite database is not initialized yet. Please wait for the map to load!");
      return;
    }

    const stmt = db.prepare(`
      SELECT Id, CenterLat, CenterLong, Angle, StraightawayLength, InsideRadius 
      FROM Tracks 
      WHERE Id = :id 
      LIMIT 1
    `);
    
    const row = stmt.getAsObject({ ':id': parseInt(targetId) });
    stmt.free(); 

    if (!row || !row.Id) {
      alert(`❌ Track ID ${targetId} could not be found in the SQLite database.`);
      return;
    }

    window.isAutomationRun = false;

    const lat = (row.CenterLat && row.CenterLat !== 'None') ? toDegreesFromGarmin(parseInt(row.CenterLat)) : null;
    const lon = (row.CenterLong && row.CenterLong !== 'None') ? toDegreesFromGarmin(parseInt(row.CenterLong)) : null;
    let angle = (row.Angle && row.Angle !== 'None') ? centidegToDeg(parseFloat(row.Angle)) : 0;
    let straightM = (row.StraightawayLength && row.StraightawayLength !== 'None') ? metersFromStored(parseFloat(row.StraightawayLength)) : null;
    let radiusM = (row.InsideRadius && row.InsideRadius !== 'None') ? metersFromStored(parseFloat(row.InsideRadius)) : null;
    
    let assumedStraight = false;
    if (straightM === null || straightM === 0) { straightM = 84.39; assumedStraight = true; }
    let assumedRadius = false;
    if (radiusM === null || radiusM === 0) {
      radiusM = ((400.0 - (2 * straightM)) / (2 * Math.PI)) - 0.3;
      if (radiusM < 5) radiusM = 36.5; 
      assumedRadius = true;
    }
    const lengthM = computeTrackLength(straightM, radiusM);

    const trackObj = { id: row.Id, lat, lon, angle, straightM, radiusM, lengthM, assumedRadius, assumedStraight };

    if (trackObj.lat === null || trackObj.lon === null) {
      alert("❌ This track contains invalid or missing GPS coordinate properties.");
      return;
    }

    // Clear out old UI layers
    if (window.trackLayer) trackLayer.clearLayers();
    if (window.boundsLayer) boundsLayer.clearLayers();
    if (window.clusterLayer && map.hasLayer(clusterLayer)) map.removeLayer(clusterLayer);

    // Wire up the Back button state so you can return to the main map after a search
    if (map.getZoom() !== 17) {
      previousZoomLevel = map.getZoom();
      previousMapCenter = map.getCenter();
    }
    document.getElementById('back-btn').style.display = 'block';

    // ==========================================================
    // THE FIX: AUTOMATICALLY SWAP TO SATELLITE VIEW
    // ==========================================================
    if (currentLayer === 'osm') {
      map.removeLayer(osmLayer);
      satelliteLayer.addTo(map);
      currentLayer = 'satellite';
      
      // Update your UI toggle button text so it matches
      const toggleBtn = document.getElementById('layer-toggle-btn');
      if (toggleBtn) toggleBtn.innerHTML = "🗺️ Standard Map";
    }
    // ==========================================================

    // Snap camera directly to the track location
    map.invalidateSize({ animate: false });
    map.setView([trackObj.lat, trackObj.lon], 17, { animate: true });

    if (!map.hasLayer(trackLayer)) map.addLayer(trackLayer);
    drawTrack(trackObj);

    // Strip out the old automation info card panels
    const oldCard = document.getElementById('automation-telemetry-card');
    if (oldCard) oldCard.remove();

    // THE FIX: Automatically trigger the new interactive card and bounding box
    drawDynamicBoundsOnDemand(trackObj);
    showInteractiveTelemetryCard(trackObj);

    console.log(`🎯 Successfully located and navigated to Track ID: ${targetId}`);

    // ==========================================================
    // DEEP LINKING: Update browser URL silently
    // ==========================================================
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('id', targetId);
    window.history.pushState({ path: newUrl.href }, '', newUrl.href);
  } catch (error) {
    console.error("❌ Search Engine Execution Error:", error);
    alert(`An error occurred while loading the track: ${error.message}`);
  }
};

// =========================================================================
// AUTOMATION ENGINE HOOK
// =========================================================================
window.loadSingleTrackForScreenshot = function(id, rawLat, rawLon, rawStraight, rawRadius, rawAngle) {
  // Lock the automation flag immediately to block background map event loops
  window.isAutomationRun = true; 
  console.log(`🤖 Hook processing raw database data for ID: ${id}`);
  
  try {
    // 1. Clear out old canvas layers completely so tracks don't bleed into each other
    if (window.trackLayer) trackLayer.clearLayers();
    if (window.boundsLayer) boundsLayer.clearLayers();
    if (window.clusterLayer && map.hasLayer(clusterLayer)) map.removeLayer(clusterLayer);
    
    // 2. Translate raw numbers using your utility formulas
    const lat = (rawLat && rawLat !== 'None') ? toDegreesFromGarmin(parseInt(rawLat)) : null;
    const lon = (rawLon && rawLon !== 'None') ? toDegreesFromGarmin(parseInt(rawLon)) : null;
    let angle = (rawAngle && rawAngle !== 'None') ? centidegToDeg(parseFloat(rawAngle)) : 0;
    let straightM = (rawStraight && rawStraight !== 'None') ? metersFromStored(parseFloat(rawStraight)) : null;
    let radiusM = (rawRadius && rawRadius !== 'None') ? metersFromStored(parseFloat(rawRadius)) : null;
    
    let assumedStraight = false;
    if (straightM === null || straightM === 0) { 
      straightM = 84.39; 
      assumedStraight = true; 
    }

    let assumedRadius = false;
    if (radiusM === null || radiusM === 0) {
      const curbOffset = 0.3; 
      const targetLength = 400.0;
      radiusM = ((targetLength - (2 * straightM)) / (2 * Math.PI)) - curbOffset;
      if (radiusM < 5) radiusM = 36.5; 
      assumedRadius = true;
    }
    
    const lengthM = computeTrackLength(straightM, radiusM);
    const t = { id: parseInt(id), lat, lon, angle, straightM, radiusM, lengthM, assumedRadius, assumedStraight };
    
    if (t.lat === null || t.lon === null || isNaN(t.lat) || isNaN(t.lon)) {
      throw new Error(`Invalid GPS translation coordinates: [${t.lat}, ${t.lon}]`);
    }

    // 3. Force the map container to recalculate viewport canvas boundaries first
    map.invalidateSize({ animate: false });
    
    // 4. Position camera cleanly on our specific coordinates at Zoom Level 17
    console.log(`⏱️ LOG [8]: Relocating Leaflet camera view to zoom 17...`);
    map.setView([t.lat, t.lon], 17, { animate: false });
    
    // 5. UNCONDITIONAL SWAP TO SATELLITE: Ensure high-res tiles run on every track
    console.log("🛰️ Enforcing high-resolution satellite imagery layer...");
    if (typeof osmLayer !== 'undefined' && map.hasLayer(osmLayer)) {
      map.removeLayer(osmLayer);
    }
    if (typeof satelliteLayer !== 'undefined' && !map.hasLayer(satelliteLayer)) {
      satelliteLayer.addTo(map);
    }
    window.currentLayer = 'satellite';
    
    const btn = document.getElementById('layer-toggle-btn');
    if (btn) btn.innerHTML = "🗺️ Standard Map";
    
    // 6. Mount and draw the track graphics over the fresh satellite layer
    if (!map.hasLayer(trackLayer)) map.addLayer(trackLayer);
    drawTrack(t); 

    // =========================================================================
    // 7. DYNAMIC TELEMETRY OVERLAY GENERATOR (BOTTOM LEFT CORNER)
    // =========================================================================
    // Strip out any pre-existing automation card to prevent multiple text stacking
    const oldCard = document.getElementById('automation-telemetry-card');
    if (oldCard) oldCard.remove();

    // Fabricate a clean UI display panel container
    const card = document.createElement('div');
    card.id = 'automation-telemetry-card';
    
    // Explicit styling rules to snap it cleanly to the bottom left, away from center graphics
    card.style.position = 'absolute';
    card.style.bottom = '20px';
    card.style.left = '20px';
    card.style.zIndex = '10000'; // Sit high above Leaflet layers
    card.style.backgroundColor = 'rgba(0, 0, 0, 0.75)'; // Deep readable backdrop
    card.style.color = '#ffffff';
    card.style.padding = '15px';
    card.style.borderRadius = '8px';
    card.style.fontFamily = 'monospace';
    card.style.fontSize = '13px';
    card.style.lineHeight = '1.5';
    card.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
    card.style.border = '1px solid rgba(255,255,255,0.2)';
    card.style.pointerEvents = 'none'; // Prevent interaction interference

    // Format metrics identically to your native pop-up strings
    card.innerHTML = `
      <b style="color: #4fc3f7; font-size: 14px;">TRACK ID: ${t.id}</b><br>
      <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.2); margin: 6px 0;">
      📍 Lat: ${t.lat.toFixed(6)}<br>
      📍 Lon: ${t.lon.toFixed(6)}<br>
      📐 Angle: ${t.angle.toFixed(1)}°<br>
      📏 Straight: ${t.straightM.toFixed(2)}m ${t.assumedStraight ? '(Assumed)' : ''}<br>
      ⭕ Radius: ${t.radiusM.toFixed(2)}m ${t.assumedRadius ? '(Assumed)' : ''}<br>
      🏃 Total Len: ${t.lengthM.toFixed(2)}m
    `;

    // Append directly inside the main map container frame
    document.getElementById('map').appendChild(card);
    
    console.log(`🎯 Viewport locked and telemetry overlay active for ID: ${t.id}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Hook Execution Failure: ${error.message}`);
    return { success: false, error: error.message };
  }
};

// =========================================================================
// LIVE TRACK EDITOR ENGINE (VISUAL ONLY - NO DB WRITES)
// =========================================================================

let editModeActive = false;
let editMarker = null;

window.adjustEditSlider = function(sliderId, delta) {
  const slider = document.getElementById(sliderId);
  if (slider) {
    // Read the current value, add the delta, and round to 2 decimals to prevent JS floating-point bugs
    let newVal = parseFloat(slider.value) + delta;
    slider.value = newVal.toFixed(2);
    
    // Dispatch an 'input' event so redrawEditedTrack() fires automatically
    slider.dispatchEvent(new Event('input'));
  }
};

window.activateEditMode = function() {
  if (editModeActive || !window.currentViewedTrack) return;
  editModeActive = true;
  
  // Pause auto-play if it's running
  if (isAutoPlaying) window.toggleAutoPlay();

  const t = window.currentViewedTrack;

  // Dynamic initial length calculation with fallback if radius/straight is missing
  const curbOffset = 0.3;
  let initialTargetLength = 400.0;
  
  if (t.straightM != null && t.radiusM != null) {
    initialTargetLength = (2 * t.straightM) + (2 * Math.PI * (t.radiusM + curbOffset));
  }

  // 1. Build the Editor UI Panel
  const editor = document.createElement('div');
  editor.id = 'track-editor-panel';
  editor.style.position = 'absolute';
  editor.style.bottom = '20px';
  editor.style.right = '20px';
  editor.style.zIndex = '10001';
  editor.style.backgroundColor = 'rgba(0, 50, 0, 0.85)';
  editor.style.color = '#ffffff';
  editor.style.padding = '15px';
  editor.style.borderRadius = '8px';
  editor.style.fontFamily = 'monospace';
  editor.style.width = '280px';
  editor.style.border = '1px solid #4CAF50';

  editor.innerHTML = `
    <b style="color: #4CAF50;">🛠️ LIVE TRACK EDITOR</b><br>
    <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.2); margin: 6px 0;">
    
    <label>Angle: <span id="edit-val-angle">${t.angle.toFixed(2)}</span>°</label>
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
      <button onclick="adjustEditSlider('edit-slider-angle', -0.01)" style="width: 35px; height: 30px; background: #555; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">-</button>
      <input type="range" id="edit-slider-angle" min="-360" max="360" step="0.01" value="${t.angle.toFixed(2)}" style="flex: 1;">
      <button onclick="adjustEditSlider('edit-slider-angle', 0.01)" style="width: 35px; height: 30px; background: #555; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">+</button>
    </div>
    
    <label>Straightaway: <span id="edit-val-straight">${t.straightM.toFixed(2)}</span>m</label>
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
      <button onclick="adjustEditSlider('edit-slider-straight', -0.01)" style="width: 35px; height: 30px; background: #555; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">-</button>
      <input type="range" id="edit-slider-straight" min="0" max="150" step="0.01" value="${t.straightM.toFixed(2)}" style="flex: 1;">
      <button onclick="adjustEditSlider('edit-slider-straight', 0.01)" style="width: 35px; height: 30px; background: #555; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">+</button>
    </div>
    
    <label>Target Length: <span id="edit-val-length">${initialTargetLength.toFixed(2)}</span>m</label>
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
      <button onclick="adjustEditSlider('edit-slider-length', -0.01)" style="width: 35px; height: 30px; background: #555; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">-</button>
      <input type="range" id="edit-slider-length" min="100" max="1000" step="0.01" value="${initialTargetLength.toFixed(2)}" style="flex: 1;">
      <button onclick="adjustEditSlider('edit-slider-length', 0.01)" style="width: 35px; height: 30px; background: #555; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">+</button>
    </div>

    <hr style="border: 0; border-top: 1px dashed rgba(255,255,255,0.3); margin: 12px 0 8px 0;">
    <b style="color: #ffeb3b; font-size: 11px;">💾 RAW DB VALUES (GARMIN FORMAT)</b><br>
    <div style="background: rgba(0,0,0,0.5); padding: 8px; border-radius: 4px; margin-top: 5px; font-size: 11px; color: #a5d6a7; user-select: all;">
      CenterLat: <span id="edit-raw-lat"></span><br>
      CenterLong: <span id="edit-raw-lon"></span><br>
      Angle: <span id="edit-raw-angle"></span><br>
      StraightawayLength: <span id="edit-raw-straight"></span><br>
      InsideRadius: <span id="edit-raw-radius"></span>
    </div>

    <div style="display: flex; gap: 10px; margin-top: 12px;">
      <button onclick="resetEditedTrack()" style="flex: 1; padding: 5px; background: #ff9800; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold;">🔄 Reset</button>
      <button onclick="deactivateEditMode()" style="flex: 1; padding: 5px; background: #ff3333; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold;">✖ Close</button>
    </div>
  `;

  L.DomEvent.disableClickPropagation(editor);
  L.DomEvent.disableScrollPropagation(editor);
  document.getElementById('map').appendChild(editor);

  // 2. Setup the Draggable Marker
  trackLayer.clearLayers(); // Clear the static track
  boundsLayer.clearLayers();
  
  editMarker = L.marker([t.lat, t.lon], { draggable: true }).addTo(trackLayer);
  
  // 3. Wire up the Live Render triggers
  editMarker.on('drag', redrawEditedTrack);
  document.getElementById('edit-slider-angle').addEventListener('input', redrawEditedTrack);
  document.getElementById('edit-slider-straight').addEventListener('input', redrawEditedTrack);
  document.getElementById('edit-slider-length').addEventListener('input', redrawEditedTrack);

  // Draw the initial editable state
  redrawEditedTrack();
};

window.resetEditedTrack = function() {
  if (!editModeActive || !window.currentViewedTrack || !db) return;

  const targetId = window.currentViewedTrack.id;

  try {
    // 1. Fetch the pristine, original row directly from the SQLite database
    const stmt = db.prepare(`
      SELECT Id, CenterLat, CenterLong, Angle, StraightawayLength, InsideRadius 
      FROM Tracks WHERE Id = :id LIMIT 1
    `);
    const row = stmt.getAsObject({ ':id': targetId });
    stmt.free();

    if (!row || !row.Id) {
      console.warn("Could not find original track in database.");
      return;
    }

    // 2. Parse the raw values back into Garmin degrees and meters
    const lat = (row.CenterLat != null) ? toDegreesFromGarmin(row.CenterLat) : null;
    const lon = (row.CenterLong != null) ? toDegreesFromGarmin(row.CenterLong) : null;
    let angle = (row.Angle != null) ? centidegToDeg(row.Angle) : 0;
    let straightM = (row.StraightawayLength != null) ? metersFromStored(row.StraightawayLength) : null;
    let radiusM = (row.InsideRadius != null) ? metersFromStored(row.InsideRadius) : null;

    // Apply the exact same fallback math used during standard loading
    if (straightM === null || straightM === 0) { straightM = 84.39; }
    if (radiusM === null || radiusM === 0) {
      radiusM = ((400.0 - (2 * straightM)) / (2 * Math.PI)) - 0.3;
      if (radiusM < 5) radiusM = 36.5; 
    }
    const lengthM = computeTrackLength(straightM, radiusM);

    // 3. Move the physical Leaflet marker back to the original coordinates
    if (editMarker) {
      editMarker.setLatLng([lat, lon]);
    }

    // 4. Reset all the HTML slider bars to match the database values
    document.getElementById('edit-slider-angle').value = angle;
    document.getElementById('edit-slider-straight').value = straightM;
    document.getElementById('edit-slider-length').value = lengthM;

    // 5. Trigger the standard redraw function so the UI text, raw values, and polygon all update automatically!
    redrawEditedTrack();
    
    console.log(`🔄 Track ID ${targetId} successfully reset to database state.`);
  } catch (error) {
    console.error("❌ Failed to reset track:", error);
  }
};

window.redrawEditedTrack = function() {
  if (!editModeActive) return;

  // Fetch current values from UI and Marker
  const newPos = editMarker.getLatLng();
  const newAngle = parseFloat(document.getElementById('edit-slider-angle').value);
  const newStraight = parseFloat(document.getElementById('edit-slider-straight').value);
  const targetLength = parseFloat(document.getElementById('edit-slider-length').value);

  // Update UI Labels
  document.getElementById('edit-val-angle').innerText = newAngle.toFixed(2);
  document.getElementById('edit-val-straight').innerText = newStraight.toFixed(2);
  document.getElementById('edit-val-length').innerText = targetLength.toFixed(2);

  // Recalculate Radius dynamically based on the requested Target Length FIRST
  const curbOffset = 0.3;
  let newRadius = ((targetLength - (2 * newStraight)) / (2 * Math.PI)) - curbOffset;
  if (newRadius < 5) newRadius = 5; // Prevent physics-breaking inverted tracks

  // ==========================================================
  // REVERSE CONVERSION FOR RAW GARMIN DB VALUES
  // ==========================================================
  // Semicircles = Degrees / (180 / 2^31)
  const DEG_PER_UNIT = 180 / Math.pow(2, 31); 
  
  const rawLat = Math.round(newPos.lat / DEG_PER_UNIT);
  const rawLon = Math.round(newPos.lng / DEG_PER_UNIT);
  const rawAngle = Math.round(newAngle * 100);
  const rawStraight = Math.round(newStraight * 100);
  const rawRadius = Math.round(newRadius * 100);

  document.getElementById('edit-raw-lat').innerText = rawLat;
  document.getElementById('edit-raw-lon').innerText = rawLon;
  document.getElementById('edit-raw-angle').innerText = rawAngle;
  document.getElementById('edit-raw-straight').innerText = rawStraight;
  document.getElementById('edit-raw-radius').innerText = rawRadius;
  // ==========================================================

  // Update our global state object
  window.currentViewedTrack.lat = newPos.lat;
  window.currentViewedTrack.lon = newPos.lng;
  window.currentViewedTrack.angle = newAngle;
  window.currentViewedTrack.straightM = newStraight;
  window.currentViewedTrack.radiusM = newRadius;
  window.currentViewedTrack.lengthM = computeTrackLength(newStraight, newRadius);
  window.currentViewedTrack.assumedStraight = false;
  window.currentViewedTrack.assumedRadius = false;

  // Clear previous edit polygons (but keep the draggable marker)
  trackLayer.eachLayer(layer => {
    if (layer !== editMarker) trackLayer.removeLayer(layer);
  });

  // Draw the new shape
  const pts = buildOvalPoints(newPos.lat, newPos.lng, newAngle, newStraight, newRadius, 20);
  L.polyline(pts, { color: '#00ff00', weight: 3, opacity: 0.9, dashArray: '5, 5' }).addTo(trackLayer);

  // Update the original Telemetry Card so you can copy the final numbers
  const card = document.getElementById('interactive-telemetry-card');
  if (card) {
    showInteractiveTelemetryCard(window.currentViewedTrack);
  }
};

window.deactivateEditMode = function() {
  editModeActive = false;
  if (editMarker) {
    editMarker.off('drag');
    editMarker = null;
  }
  const panel = document.getElementById('track-editor-panel');
  if (panel) panel.remove();
  
  // 1. Sync the edited track back into the global tracking array
  if (window.currentViewedTrack) {
    const trackIndex = allTracks.findIndex(tr => tr.id === window.currentViewedTrack.id);
    if (trackIndex !== -1) {
      allTracks[trackIndex] = window.currentViewedTrack;
    }
  }

  // 2. Force the map engine to recalculate and draw ALL tracks in the current view
  renderByZoom();
};

// Safety catch: Close editor if the user manually closes the telemetry card
const originalCloseCard = window.closeInteractiveTelemetryCard;
window.closeInteractiveTelemetryCard = function(isAutoTransition = false) {
  if (editModeActive && !isAutoTransition) deactivateEditMode();
  originalCloseCard(isAutoTransition);
};