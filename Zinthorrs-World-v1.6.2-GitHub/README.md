# Zinthorr's World - Google Earth & Street View WebXR (v1.6.2 - GitHub Edition)

A free, browser-based WebXR 3D Earth and 360° Street View explorer built for **Samsung Galaxy XR** (and desktop browsers).

> **Important (No API Key Included):** This GitHub version has all personal API keys stripped out. **You must add your own Google Maps Platform API key before the app will load 3D Earth, 2D Maps, Search, Street View, or games.** Once you add your key (either in the in-app Settings menu or on line 4 of `app.js`), everything starts working immediately.

> **Disclaimer:** This is an experimental, AI-assisted ("vibe-coded") hobby project built by an independent developer primarily for personal use. It is provided as-is with no guarantees. If you create a Google Maps Platform API key, be sure to restrict it by HTTP referrer. On an unupgraded Google Cloud free-trial account, Google will not charge you; it simply shuts off API requests for the day once you hit the daily cap. Just be careful not to click "Upgrade" to a paid pay-as-you-go billing account unless you are comfortable paying for usage beyond the free tier.

---

## Features
* **Photorealistic 3D Earth** with smooth horizon tilt, live terrain elevation, Day / Sunset / Night skies, and toggleable country/state/city labels.
* **360° Google Street View** with directional ground arrows and **Hold-Trigger Low-Res Cruise Boost** fast travel (also works on PC by holding Left-Click or holding `W` / `Up Arrow`).
* **Interactive Wrist Minimap & Compass** (drag to pan, point + stick to zoom, drop pins, jump directly to 3D or Street View even while already inside Street View).
* **Built-In Games:** 5-round **GeoGuessr** (Move / No Move, Timed / Untimed, official Google Street View only) and **Map Tap** (Major / All 220+ / Hard 100k+ cities, region filters, 10-second auto-advance reveal, shareable challenge links).
* **Bookmarks, Featured Places & `🎲 LUCKY`** random world explorer.
* **Full Lefty Mode**, Snap/Smooth turning, and optional Comfort Vignette.

---

## Setup: Add Your Own Google Maps API Key

### Step 1: Create a Google Maps API Key
1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project.
2. Link a billing account (required by Google to activate the free tier; do **not** click "Upgrade" to a paid account if you want Google's automatic $0 shutoff limits).
3. Go to **APIs & Services -> Library** and enable these two APIs:
   * **Map Tiles API** (powers 3D Earth, 2D Maps, and Street View)
   * **Places API (New)** (powers address/landmark search)
4. Go to **APIs & Services -> Credentials -> Create Credentials -> API Key**.
5. Click your new key to restrict it:
   * **Application restrictions:** Websites (HTTP referrers) -> add the URL where you host or open the app (for example, `https://your-site.netlify.app/*`, `https://your-username.github.io/*`, or `http://localhost:*`). If you are using the hosted demo instead, add `https://zinthorrsworld.netlify.app/*`.
   * **API restrictions:** Restrict key to **Map Tiles API** and **Places API (New)**.

### Step 2: Plug Your Key Into the App (2 Options)
* **Option A (In-Browser Settings, Recommended for Public Repos):**
  1. Host the files on Netlify Drop, GitHub Pages, or a local server and open the site.
  2. Press **`M`** (or click **Main Menu**) and open the **Settings** tab.
  3. Paste your `AIza...` key into the **Google Maps API Key** box and click **Save & Reload**.
  4. Your key is stored locally in your browser only (`localStorage`) and is never committed to GitHub or sent to any third-party server.
* **Option B (Hardcode for Private Self-Hosting):**
  1. Open `app.js` and replace `"PASTE_YOUR_API_KEY_HERE"` on line 4 with your `AIza...` key.
  2. Only do this if your repo is private or your key is strictly locked down by HTTP referrer.

### How Free-Tier Limits Work ($0 Auto-Shutoff)
On an unupgraded Google Cloud free-trial account, quota editing is locked (greyed out) and Google automatically enforces hard daily limits, simply shutting off requests with a `429` error for the rest of the day rather than charging your card:

| Service | Quota (`per day`) | Locked Free-Tier Cap | Free Monthly Tier |
| :--- | :--- | :--- | :--- |
| **Map Tiles API** | `Street View Tiles requests per day` | `15,000` (~1.5 hrs of active SV) | 100,000 tiles/mo |
| **Map Tiles API** | `2D Tiles requests per day` | `100,000` | 100,000 tiles/mo |
| **Map Tiles API** | `3D Tiles root requests per day` | `10,000` | 1,000 root sessions/mo |

*(Note: If you ever manually upgrade your Google Cloud billing account to full pay-as-you-go, Google unlocks quota editing and removes the automatic $0 shutoff.)*

---

## Controls

### Galaxy XR / WebXR
* **Right B (or Left Y in Lefty Mode):** Open / Close Main Menu
* **Left Y (or Right B in Lefty Mode):** Toggle Interactive Wrist Minimap & Compass
* **Hold A or X (Either Hand):** Ambidextrous Superman Flight (+ Trigger to Boost, opposite stick turns)
* **Either Thumbstick Up/Down:** Zoom 3D Earth toward laser (or zoom Wrist Minimap when pointing at it)
* **Either Thumbstick Left/Right:** Look around in Street View or low-altitude 3D Earth (< 40 km)
* **Hold Grip + Move Left/Right:** Rotate globe North orientation (**L3 Click:** snap North-Up)
* **1 Trigger / 2 Triggers:** Grab & Pan 3D Earth / Steering-Wheel Rotate
* **Street View Trigger:** Quick tap steps 1 panorama forward; hold (`>= 0.4s`) activates **Low-Res Cruise Boost** (red arrow, sharpens on release)

### Desktop (PC / Mac)
* **WASD (+ Shift Boost):** Fly around 3D Earth
* **Left-Drag / Right-Drag / Scroll:** Pan / Rotate / Zoom toward cursor
* **Street View:** Click an arrow to step forward; hold Left-Click (`>= 0.4s`) or hold **`W` / `Up Arrow`** for **Low-Res Cruise Boost**
* **M:** Open Main Menu • **L:** Toggle Labels • **R:** Reset North-Up • **Esc:** Close Menu / Exit Street View

---

## Self-Hosting
This is a pure static site (no build step required). Drop all files onto **Netlify Drop**, **GitHub Pages**, or any static web host over HTTPS (WebXR requires HTTPS).
