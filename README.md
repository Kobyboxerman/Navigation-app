# 🚶 FootNav — Interactive Walking Navigation (example)

A small, self-contained example of a **Waze/Google-Maps-style walking
navigator**, built to demonstrate the moving parts you'd need for your own app.
It uses the **Google Maps Platform**.

> This is an *example*, not a finished product — it shows the core mechanics so
> you can lift the pieces you want into your real app.

## What it does

- **Live map** with your current position (Maps JavaScript API).
- **Pick a destination** three ways — this stands in for "choosing a point from
  my dashboard":
  - Google **Places** search box (autocomplete)
  - **Saved places** chips (presets)
  - **Tap anywhere** on the map to drop a pin
- **Walking route** with turn-by-turn steps (Directions API, `WALKING` mode).
- **Interactive navigation** like Google Maps / Waze:
  - Big maneuver banner ("In 40 m, turn left") with a *then* preview
  - ETA + remaining distance, updated as you move
  - Auto-recenter / follow, traveled-vs-remaining route shading
  - **Off-route detection → automatic re-routing**
  - **Spoken guidance** (Web Speech API)
- **Simulate walk** button so you can experience navigation on a desktop
  without actually walking; toggle back to **Real GPS** anytime.

## Setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable:
   - **Maps JavaScript API**
   - **Directions API**
   - **Places API**
2. Create an **API key** (APIs & Services → Credentials).
3. Put the key in **`config.js`**:
   ```js
   window.FOOTNAV_CONFIG = { googleMapsApiKey: "YOUR_KEY_HERE" };
   ```
4. Serve the folder (geolocation requires `https://` or `localhost`):
   ```bash
   python3 -m http.server 8000
   # then open http://localhost:8000
   ```

## Files

| File          | Purpose                                                        |
| ------------- | ------------------------------------------------------------- |
| `index.html`  | Layout: map, dashboard, navigation HUD, demo controls.        |
| `styles.css`  | All styling.                                                  |
| `app.js`      | Map, routing, live tracking, turn-by-turn, voice, simulation. |
| `config.js`   | Your Google Maps API key.                                      |

## Notes for going to production

- **Protect your key**: restrict it to your domains in Cloud Console, and
  ideally proxy **Directions/Places** calls through your own backend so the key
  isn't exposed in the browser.
- Mobile sensor heading (compass) is approximated from movement here; for true
  device orientation you'd use the Device Orientation API.
- Google's Directions API gives rich step data; the HUD glyphs map a subset of
  Google's `maneuver` values — extend `maneuverIcon()` as needed.
