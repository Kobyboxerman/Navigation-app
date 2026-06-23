/* ============================================================================
 * FootNav — Interactive walking navigation (example demo, Google Maps Platform)
 *
 * Building blocks for a Waze/Google-Maps-style *walking* navigator:
 *   • a live Google map (Maps JavaScript API)
 *   • destination selection from a "dashboard" (Places search / presets / tap)
 *   • walking route + turn-by-turn steps (Directions API, mode WALKING)
 *   • live position tracking, auto-recenter, off-route re-routing
 *   • spoken guidance (Web Speech API), ETA, and a desktop "simulate walk" mode
 *
 * The Google Maps script is loaded from index.html and calls initApp() when
 * ready. Your API key lives in config.js.
 *
 * Production notes: restrict your API key, and proxy Directions/Places through
 * your own backend rather than calling them straight from the browser.
 * ==========================================================================*/

"use strict";

/* ----------------------------------------------------------------------------
 * Tunables & state
 * --------------------------------------------------------------------------*/

const CONFIG = {
  walkingSpeedMps: 1.35, // ~4.9 km/h, used for ETA fallbacks
  arriveRadiusM: 20, // consider "arrived" within this distance of destination
  offRouteM: 35, // distance off the polyline that triggers a re-route
  rerouteCooldownMs: 6000,
  announceLeadM: 30, // announce a turn this far ahead
  stepAdvanceM: 12, // mark a maneuver "done" within this distance
  presets: [
    { name: "🗼 Eiffel Tower", lat: 48.8584, lng: 2.2945 },
    { name: "🏛️ Brandenburg Gate", lat: 52.5163, lng: 13.3777 },
    { name: "🗽 Statue of Liberty", lat: 40.6892, lng: -74.0445 },
    { name: "🎡 London Eye", lat: 51.5033, lng: -0.1196 },
  ],
};

const state = {
  map: null,
  directionsService: null,
  renderer: null, // DirectionsRenderer for the "ahead" portion
  geocoder: null,
  me: null, // {lat, lng, heading}
  meMarker: null,
  destination: null, // {lat, lng, name}
  destMarker: null,
  route: null, // normalized route { distance, duration, coords[], steps[] }
  traveledLine: null,
  navigating: false,
  currentStepIndex: 0,
  voiceOn: true,
  lastAnnouncedStep: -1,
  lastRerouteAt: 0,
  geoWatchId: null,
  simTimer: null,
  followMode: true,
  mode: "gps", // "gps" | "sim"
};

/* ----------------------------------------------------------------------------
 * Tiny DOM helpers
 * --------------------------------------------------------------------------*/

const $ = (id) => document.getElementById(id);

function toast(msg, ms = 3200) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

/* ----------------------------------------------------------------------------
 * Geo helpers — we lean on google.maps.geometry when available, with our own
 * fallbacks so the logic is easy to read.
 * --------------------------------------------------------------------------*/

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function distM(a, b) {
  if (window.google?.maps?.geometry) {
    return google.maps.geometry.spherical.computeDistanceBetween(ll(a), ll(b));
  }
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  if (window.google?.maps?.geometry) {
    return (google.maps.geometry.spherical.computeHeading(ll(a), ll(b)) + 360) % 360;
  }
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// {lat,lng} -> google.maps.LatLng
const ll = (p) => new google.maps.LatLng(p.lat, p.lng);
// google.maps.LatLng -> {lat,lng}
const pt = (g) => ({ lat: g.lat(), lng: g.lng() });

// Closest point on segment a-b to p (planar approx; fine for short segments).
function projectOnSegment(p, a, b) {
  const k = Math.cos(toRad(p.lat));
  const ax = a.lng * k, ay = a.lat, bx = b.lng * k, by = b.lat, px = p.lng * k, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const proj = { lat: ay + t * dy, lng: (ax + t * dx) / k };
  return { point: proj, dist: distM(p, proj), t };
}

function nearestOnRoute(p, coords) {
  let best = { dist: Infinity, idx: 0, point: coords[0] };
  for (let i = 0; i < coords.length - 1; i++) {
    const r = projectOnSegment(p, coords[i], coords[i + 1]);
    if (r.dist < best.dist) best = { dist: r.dist, idx: i, point: r.point, t: r.t };
  }
  return best;
}

/* ----------------------------------------------------------------------------
 * Formatting
 * --------------------------------------------------------------------------*/

function fmtDist(m) {
  if (m < 1000) return `${Math.round(m / 5) * 5} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function fmtDuration(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}
function fmtClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ----------------------------------------------------------------------------
 * Bootstrap — called by the Google Maps loader (callback=initApp)
 * --------------------------------------------------------------------------*/

function initApp() {
  state.map = new google.maps.Map($("map"), {
    center: { lat: 48.8566, lng: 2.3522 },
    zoom: 14,
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: "greedy",
    clickableIcons: false,
  });

  state.directionsService = new google.maps.DirectionsService();
  state.geocoder = new google.maps.Geocoder();

  // Renderer draws the *remaining* route; we suppress its markers and draw
  // our own so we control start/end and the "traveled" overlay.
  state.renderer = new google.maps.DirectionsRenderer({
    map: state.map,
    suppressMarkers: true,
    preserveViewport: true,
    polylineOptions: { strokeColor: "#1a73e8", strokeWeight: 7, strokeOpacity: 0.9 },
  });

  state.traveledLine = new google.maps.Polyline({
    map: state.map,
    path: [],
    strokeColor: "#9aa7b4",
    strokeWeight: 7,
    strokeOpacity: 0.9,
  });

  // Tap-to-set-destination.
  state.map.addListener("click", (e) => {
    if (state.navigating) return;
    setDestination({ lat: e.latLng.lat(), lng: e.latLng.lng(), name: "Dropped pin" });
  });

  // Dragging interrupts auto-follow so the user can look around.
  state.map.addListener("dragstart", () => {
    if (state.navigating) state.followMode = false;
  });

  buildPresets();
  initAutocomplete();
  wireEvents();
  startGps();
}
// Expose for the Maps script callback.
window.initApp = initApp;

/* ----------------------------------------------------------------------------
 * "Me" marker
 * --------------------------------------------------------------------------*/

// Waze-style heading arrow: a rounded chevron pointing in the travel
// direction. Defined pointing "up" (north); we rotate it by the heading.
// When no heading is known yet, it simply points up.
const ME_ARROW_PATH = "M 0,-11 L 8,9 Q 0,4 -8,9 Z";

function meSymbol(heading) {
  return {
    path: ME_ARROW_PATH,
    rotation: heading == null || isNaN(heading) ? 0 : heading,
    scale: 1.7,
    fillColor: "#1a73e8",
    fillOpacity: 1,
    strokeColor: "#ffffff",
    strokeWeight: 2.5,
    anchor: new google.maps.Point(0, 0),
  };
}

function updateMeMarker() {
  if (!state.me) return;
  const pos = { lat: state.me.lat, lng: state.me.lng };
  if (!state.meMarker) {
    state.meMarker = new google.maps.Marker({
      map: state.map,
      position: pos,
      icon: meSymbol(state.me.heading),
      zIndex: 9999,
    });
  } else {
    state.meMarker.setPosition(pos);
    state.meMarker.setIcon(meSymbol(state.me.heading));
  }
}

/* ----------------------------------------------------------------------------
 * Position tracking (real GPS)
 * --------------------------------------------------------------------------*/

function startGps() {
  if (!("geolocation" in navigator)) {
    toast("Geolocation not supported — try Simulate walk.");
    return;
  }
  if (state.geoWatchId != null) navigator.geolocation.clearWatch(state.geoWatchId);
  state.geoWatchId = navigator.geolocation.watchPosition(
    (pos) =>
      onPosition({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        heading: pos.coords.heading,
        accuracy: pos.coords.accuracy,
      }),
    (err) => toast(`Location error: ${err.message}. You can use Simulate walk instead.`),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function stopGps() {
  if (state.geoWatchId != null) {
    navigator.geolocation.clearWatch(state.geoWatchId);
    state.geoWatchId = null;
  }
}

// Central handler for every position update, from GPS or simulation.
function onPosition(p) {
  const prev = state.me;
  if ((p.heading == null || isNaN(p.heading)) && prev) {
    p.heading = distM(prev, p) > 1 ? bearing(prev, p) : prev.heading;
  }
  state.me = p;
  updateMeMarker();

  if (state.navigating) {
    updateNavigation();
    if (state.followMode) state.map.panTo({ lat: p.lat, lng: p.lng });
  } else if (!state.destination) {
    state.map.setCenter({ lat: p.lat, lng: p.lng });
  }
}

/* ----------------------------------------------------------------------------
 * Destination & routing (Directions API, WALKING)
 * --------------------------------------------------------------------------*/

function setDestination(dest) {
  state.destination = dest;
  if (state.destMarker) state.destMarker.setMap(null);
  state.destMarker = new google.maps.Marker({
    map: state.map,
    position: { lat: dest.lat, lng: dest.lng },
    title: dest.name,
    label: { text: "📍", fontSize: "20px" },
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 0 }, // hide default pin, show emoji label
  });
  if (!state.me) toast("Finding your location to build a walking route…");
  requestRoute();
}

function requestRoute() {
  if (!state.destination) return Promise.resolve(false);

  const origin = state.me;
  if (!origin) {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          onPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, heading: pos.coords.heading });
          requestRoute();
        },
        () => toast("Couldn't get your location. Tap '📍 Real GPS' or use Simulate walk.")
      );
    }
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    state.directionsService.route(
      {
        origin: { lat: origin.lat, lng: origin.lng },
        destination: { lat: state.destination.lat, lng: state.destination.lng },
        travelMode: google.maps.TravelMode.WALKING,
      },
      (result, status) => {
        if (status !== "OK" || !result.routes.length) {
          toast(`Couldn't get a walking route (${status}).`);
          resolve(false);
          return;
        }
        state.route = parseRoute(result.routes[0]);
        state.renderer.setDirections(result);
        if (!state.navigating) {
          state.map.fitBounds(result.routes[0].bounds, 60);
        }
        showTripSummary();
        resolve(true);
      }
    );
  });
}

// Normalize a Google route into a flat structure for our nav logic.
function parseRoute(route) {
  const leg = route.legs[0];
  const coords = route.overview_path.map(pt);
  const steps = leg.steps.map((s) => {
    const man = s.maneuver || "";
    return {
      location: pt(s.start_location),
      end: pt(s.end_location),
      distance: s.distance ? s.distance.value : 0,
      duration: s.duration ? s.duration.value : 0,
      maneuver: man,
      instruction: stripHtml(s.instructions || ""),
      icon: maneuverIcon(man),
      polyline: (s.path || []).map(pt),
    };
  });
  // Append a synthetic "arrive" step so the HUD has a final target.
  steps.push({
    location: pt(leg.end_location),
    end: pt(leg.end_location),
    distance: 0,
    duration: 0,
    maneuver: "arrive",
    instruction: "Arrive at your destination",
    icon: "🏁",
    polyline: [],
  });
  return { distance: leg.distance.value, duration: leg.duration.value, coords, steps };
}

const stripHtml = (html) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.textContent || "").replace(/\s+/g, " ").trim();
};

// Map Google's maneuver strings to arrow glyphs for the HUD banner.
function maneuverIcon(m) {
  const map = {
    "turn-left": "←",
    "turn-right": "→",
    "turn-slight-left": "↖",
    "turn-slight-right": "↗",
    "turn-sharp-left": "⬅",
    "turn-sharp-right": "➡",
    "uturn-left": "↩",
    "uturn-right": "↪",
    "roundabout-left": "↻",
    "roundabout-right": "↻",
    "fork-left": "↖",
    "fork-right": "↗",
    "ramp-left": "↖",
    "ramp-right": "↗",
    "keep-left": "↖",
    "keep-right": "↗",
    straight: "↑",
    merge: "↱",
    arrive: "🏁",
    depart: "↑",
  };
  return map[m] || "↑";
}

/* ----------------------------------------------------------------------------
 * Trip summary
 * --------------------------------------------------------------------------*/

function showTripSummary() {
  const r = state.route;
  $("tripDistance").textContent = fmtDist(r.distance);
  $("tripDuration").textContent = fmtDuration(r.duration);
  $("tripArrival").textContent = fmtClock(new Date(Date.now() + r.duration * 1000));
  $("tripSummary").hidden = false;
}

/* ----------------------------------------------------------------------------
 * Active navigation
 * --------------------------------------------------------------------------*/

function startNavigation() {
  if (!state.route) return;
  state.navigating = true;
  state.currentStepIndex = 0;
  state.lastAnnouncedStep = -1;
  state.followMode = true;
  $("dashboard").hidden = true;
  $("navHud").hidden = false;
  state.map.setZoom(18);
  state.map.panTo({ lat: state.me.lat, lng: state.me.lng });
  speak("Starting walking navigation. " + (state.route.steps[0]?.instruction || ""));
  updateNavigation();
}

function endNavigation() {
  state.navigating = false;
  stopSimulation();
  $("navHud").hidden = true;
  $("dashboard").hidden = false;
  state.traveledLine.setPath([]);
}

function updateNavigation() {
  const r = state.route;
  if (!r || !state.me) return;

  const snap = nearestOnRoute(state.me, r.coords);

  // Off-route → recalculate (with cooldown).
  if (snap.dist > CONFIG.offRouteM && Date.now() - state.lastRerouteAt > CONFIG.rerouteCooldownMs) {
    state.lastRerouteAt = Date.now();
    toast("Off route — recalculating…");
    speak("Recalculating");
    requestRoute().then((ok) => {
      if (ok && state.navigating) state.currentStepIndex = 0;
    });
    return;
  }

  // Remaining distance from snapped point to the end of the polyline.
  let remaining = 0;
  if (r.coords[snap.idx + 1]) remaining += distM(snap.point, r.coords[snap.idx + 1]);
  for (let i = snap.idx + 1; i < r.coords.length - 1; i++) remaining += distM(r.coords[i], r.coords[i + 1]);

  // Arrival.
  if (distM(state.me, state.destination) < CONFIG.arriveRadiusM || remaining < CONFIG.arriveRadiusM) {
    onArrive();
    return;
  }

  advanceStep();

  const step = r.steps[state.currentStepIndex];
  const distToManeuver = step ? distM(state.me, step.end) : remaining;

  renderHud(step, distToManeuver, remaining);
  paintProgress(snap);
  maybeAnnounce(step, distToManeuver);
}

function advanceStep() {
  const steps = state.route.steps;
  while (
    state.currentStepIndex < steps.length - 1 &&
    distM(state.me, steps[state.currentStepIndex].end) < CONFIG.stepAdvanceM
  ) {
    state.currentStepIndex++;
    state.lastAnnouncedStep = -1;
  }
}

function renderHud(step, distToManeuver, remaining) {
  if (!step) return;
  $("maneuverIcon").textContent = step.icon;
  $("maneuverDistance").textContent = fmtDist(distToManeuver);
  $("maneuverText").textContent = step.instruction;

  const after = state.route.steps[state.currentStepIndex + 1];
  if (after && after.maneuver !== "arrive") {
    $("navThen").hidden = false;
    $("navThenIcon").textContent = after.icon;
    $("navThenText").textContent = after.instruction;
  } else {
    $("navThen").hidden = true;
  }

  const eta = new Date(Date.now() + (remaining / CONFIG.walkingSpeedMps) * 1000);
  $("hudEta").textContent = fmtClock(eta);
  $("hudRemaining").textContent = `${fmtDist(remaining)} left`;
}

// Show traveled vs. remaining: grey the done part, keep blue ahead.
function paintProgress(snap) {
  const coords = state.route.coords;
  const traveled = coords.slice(0, snap.idx + 1).map((c) => ({ lat: c.lat, lng: c.lng }));
  traveled.push({ lat: snap.point.lat, lng: snap.point.lng });
  state.traveledLine.setPath(traveled);

  const ahead = [
    { lat: snap.point.lat, lng: snap.point.lng },
    ...coords.slice(snap.idx + 1).map((c) => ({ lat: c.lat, lng: c.lng })),
  ];
  state.renderer.setMap(null); // hide renderer's full line; draw remaining ourselves
  if (!state._aheadLine) {
    state._aheadLine = new google.maps.Polyline({
      map: state.map,
      strokeColor: "#1a73e8",
      strokeWeight: 7,
      strokeOpacity: 0.9,
    });
  }
  state._aheadLine.setMap(state.map);
  state._aheadLine.setPath(ahead);
}

function maybeAnnounce(step, distToManeuver) {
  if (!step || state.lastAnnouncedStep === state.currentStepIndex) return;
  if (distToManeuver <= CONFIG.announceLeadM) {
    speak(`In ${fmtDist(distToManeuver)}, ${step.instruction}`);
    state.lastAnnouncedStep = state.currentStepIndex;
  }
}

function onArrive() {
  speak("You have arrived at your destination.");
  state.navigating = false;
  stopSimulation();
  $("navHud").hidden = true;
  $("arrivalDest").textContent = `You reached ${state.destination.name}.`;
  $("arrival").hidden = false;
}

/* ----------------------------------------------------------------------------
 * Voice guidance (Web Speech API)
 * --------------------------------------------------------------------------*/

function speak(text) {
  if (!state.voiceOn || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ----------------------------------------------------------------------------
 * Places search (Autocomplete)
 * --------------------------------------------------------------------------*/

function initAutocomplete() {
  const input = $("search");
  const ac = new google.maps.places.Autocomplete(input, {
    fields: ["geometry", "name", "formatted_address"],
  });
  ac.addListener("place_changed", () => {
    const place = ac.getPlace();
    if (!place.geometry || !place.geometry.location) {
      toast("No location for that place — try another.");
      return;
    }
    setDestination({
      lat: place.geometry.location.lat(),
      lng: place.geometry.location.lng(),
      name: place.name || place.formatted_address || "Destination",
    });
  });
}

/* ----------------------------------------------------------------------------
 * Desktop "simulate walk" — animate along the route to demo without walking.
 * --------------------------------------------------------------------------*/

function startSimulation() {
  if (!state.route) {
    toast("Pick a destination first, then simulate the walk.");
    return;
  }
  stopGps();
  stopSimulation();
  state.mode = "sim";
  setModeButtons();

  const path = densify(state.route.coords, 6); // a point roughly every 6 m
  let i = 0;
  onPosition({ ...path[0], heading: bearing(path[0], path[1] || path[0]) });
  if (!state.navigating) startNavigation();

  state.simTimer = setInterval(() => {
    if (i >= path.length - 1) {
      stopSimulation();
      onPosition(path[path.length - 1]);
      return;
    }
    const cur = path[i], nxt = path[i + 1];
    onPosition({ ...nxt, heading: bearing(cur, nxt) });
    i++;
  }, 250);
}

function stopSimulation() {
  if (state.simTimer) {
    clearInterval(state.simTimer);
    state.simTimer = null;
  }
}

function densify(coords, step) {
  const out = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const n = Math.max(1, Math.ceil(distM(a, b) / step));
    for (let j = 0; j < n; j++) {
      out.push({ lat: a.lat + ((b.lat - a.lat) * j) / n, lng: a.lng + ((b.lng - a.lng) * j) / n });
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

function setModeButtons() {
  $("gpsBtn").classList.toggle("chip--active", state.mode === "gps");
  $("simulateBtn").classList.toggle("chip--active", state.mode === "sim");
}

/* ----------------------------------------------------------------------------
 * UI wiring
 * --------------------------------------------------------------------------*/

function buildPresets() {
  const box = $("presets");
  for (const p of CONFIG.presets) {
    const b = document.createElement("button");
    b.className = "preset";
    b.textContent = p.name;
    b.onclick = () => setDestination({ ...p });
    box.appendChild(b);
  }
}

function wireEvents() {
  $("startBtn").onclick = startNavigation;
  $("endBtn").onclick = endNavigation;
  $("recenterBtn").onclick = () => {
    state.followMode = true;
    if (state.me) {
      state.map.panTo({ lat: state.me.lat, lng: state.me.lng });
      state.map.setZoom(18);
    }
  };

  $("voiceBtn").onclick = () => {
    state.voiceOn = !state.voiceOn;
    $("voiceBtn").textContent = state.voiceOn ? "🔊" : "🔇";
    $("voiceBtn").classList.toggle("is-off", !state.voiceOn);
    if (!state.voiceOn) speechSynthesis?.cancel();
  };

  $("arrivalClose").onclick = () => {
    $("arrival").hidden = true;
    $("dashboard").hidden = false;
    state.traveledLine.setPath([]);
    if (state._aheadLine) state._aheadLine.setMap(null);
    if (state.destMarker) state.destMarker.setMap(null);
    state.renderer.set("directions", null);
    state.route = state.destination = null;
    $("tripSummary").hidden = true;
  };

  $("simulateBtn").onclick = startSimulation;
  $("gpsBtn").onclick = () => {
    stopSimulation();
    state.mode = "gps";
    setModeButtons();
    startGps();
  };
}
