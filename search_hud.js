import * as THREE from "three";
import { FEATURED_PLACES } from "./featured.js";

const PLACES_AUTOCOMPLETE_URL =
  "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS_BASE = "https://places.googleapis.com/v1/places/";
const TILE_BASE = "https://tile.googleapis.com/v1";

function latLonToTileXY(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * n;
  const latRad = THREE.MathUtils.degToRad(lat);
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function tileXYToLatLon(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(latRad), -85, 85);
  return { lat, lon: ((lon + 540) % 360) - 180 };
}

export function createSearchHUD({
  apiKey,
  scene,
  camera,
  renderer,
  settings,
  games,
  audio,
  getPlayerLocation,
  getMap2DSession,
  keyManager,
  onSettingsChange,
  onFlyTo,
  onJumpStreetView,
  onFeelingLucky
}) {
  let isOpen = false;
  let activeTab = "map";
  let queryText = "";
  let suggestions = [];
  let selectedPlace = null;
  let statusMsg = "Type a city, landmark, or address";
  let debounceTimer = null;
  let hoveredHitId = null;
  let copyFeedback = "";
  let vrKeyFeedback = "";
  let vrBookmarksPage = 0;
  let vrFeaturedPage = 0;
  let editingKeySlot = keyManager ? Math.max(0, keyManager.getState().activeSlot) : 0;
  let lastVrMapCursor = null;
  let mapPanRafScheduled = false;

  function getCurrentApiKey() {
    return keyManager ? keyManager.getActiveKey() : apiKey;
  }

  const BOOKMARKS_KEY = "zinthorr_world_bookmarks_v1";
  let bookmarks = [];
  try {
    const raw = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
    if (Array.isArray(raw)) bookmarks = raw;
  } catch (_) {
    bookmarks = [];
  }

  function saveBookmarksToStorage() {
    try {
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
    } catch (_) {}
  }

  async function reverseGeocodeOSM(lat, lon) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
        lat.toFixed(6)
      )}&lon=${encodeURIComponent(lon.toFixed(6))}&zoom=18&addressdetails=1`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" }
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data) return null;
      const addr = data.address || {};
      const street = [addr.house_number, addr.road].filter(Boolean).join(" ");
      const locality = addr.city || addr.town || addr.village || addr.county || "";
      const stateOrCountry = addr.state || addr.country || "";
      const parts = [street, locality, stateOrCountry].filter(Boolean);
      if (parts.length > 0) return parts.join(", ");
      if (data.display_name) return data.display_name.split(",").slice(0, 3).join(",").trim();
    } catch (_) {}
    return null;
  }

  function addBookmark(lat, lon, customName = null) {
    const id = `bm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const coordStr = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const entry = {
      id,
      name: customName || `Saved Spot (${coordStr})`,
      address: customName ? coordStr : "Looking up street address...",
      lat,
      lon
    };
    bookmarks.unshift(entry);
    if (bookmarks.length > 60) bookmarks.pop();
    saveBookmarksToStorage();
    if (audio) audio.playPin();
    renderDesktopUI();
    renderVRTablet();

    reverseGeocodeOSM(lat, lon).then((addr) => {
      const target = bookmarks.find((b) => b.id === id);
      if (!target) return;
      if (addr) {
        if (!customName) target.name = addr.split(",")[0].trim() || target.name;
        target.address = addr;
      } else {
        target.address = `Coords: ${coordStr}`;
      }
      saveBookmarksToStorage();
      renderDesktopUI();
      renderVRTablet();
    });
    return entry;
  }

  function deleteBookmark(id) {
    bookmarks = bookmarks.filter((b) => b.id !== id);
    saveBookmarksToStorage();
    if (audio) audio.playClick();
    renderDesktopUI();
    renderVRTablet();
  }

  function triggerLucky() {
    if (audio) audio.playLucky();
    if (onFeelingLucky) onFeelingLucky();
    close();
  }

  const mapState = {
    lat: 20,
    lon: 0,
    zoom: 2
  };
  const mapTileCache = new Map();

  function loadMapTile(z, x, y) {
    const session = getMap2DSession ? getMap2DSession() : null;
    if (!session) return Promise.resolve(null);
    const key = `${z}/${x}/${y}`;
    if (mapTileCache.has(key)) return mapTileCache.get(key);

    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `${TILE_BASE}/2dtiles/${z}/${x}/${y}?session=${session}&key=${getCurrentApiKey()}`;
    });
    mapTileCache.set(key, p);
    if (mapTileCache.size > 180) {
      const firstKey = mapTileCache.keys().next().value;
      mapTileCache.delete(firstKey);
    }
    return p;
  }

  const mapBufferCanvas = document.createElement("canvas");
  mapBufferCanvas.width = 952;
  mapBufferCanvas.height = 500;
  const mapBufferCtx = mapBufferCanvas.getContext("2d");
  mapBufferCtx.fillStyle = "#0f172a";
  mapBufferCtx.fillRect(0, 0, mapBufferCanvas.width, mapBufferCanvas.height);

  const vrMapTex = new THREE.CanvasTexture(mapBufferCanvas);
  vrMapTex.colorSpace = THREE.SRGBColorSpace;
  vrMapTex.minFilter = THREE.LinearFilter;
  vrMapTex.magFilter = THREE.LinearFilter;
  vrMapTex.generateMipmaps = false;

  const desktopMapCanvas = document.getElementById("expanded-map-canvas");
  const desktopMapCtx = desktopMapCanvas ? desktopMapCanvas.getContext("2d") : null;

  let mapRenderToken = 0;

  function isGeoGuessrActive() {
    return (
      games &&
      games.session.mode === "geoguessr" &&
      (games.session.phase === "playing" || games.session.phase === "reveal")
    );
  }

  async function renderInteractiveMap() {
    const token = ++mapRenderToken;
    const w = mapBufferCanvas.width;
    const h = mapBufferCanvas.height;
    const tileSize = 512;
    const center = latLonToTileXY(mapState.lat, mapState.lon, mapState.zoom);
    const tileX = Math.floor(center.x);
    const tileY = Math.floor(center.y);
    const fracX = center.x - tileX;
    const fracY = center.y - tileY;
    const maxTile = Math.pow(2, mapState.zoom);

    const promises = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tx = ((tileX + dx) % maxTile + maxTile) % maxTile;
        const ty = tileY + dy;
        if (ty < 0 || ty >= maxTile) continue;
        promises.push(
          loadMapTile(mapState.zoom, tx, ty).then((img) => ({ img, dx, dy }))
        );
      }
    }

    const loaded = await Promise.all(promises);
    if (token !== mapRenderToken) return;

    mapBufferCtx.fillStyle = "#0f172a";
    mapBufferCtx.fillRect(0, 0, w, h);

    const originX = w / 2 - fracX * tileSize;
    const originY = h / 2 - fracY * tileSize;

    for (const item of loaded) {
      if (item.img) {
        mapBufferCtx.drawImage(
          item.img,
          originX + item.dx * tileSize,
          originY + item.dy * tileSize,
          tileSize,
          tileSize
        );
      }
    }

    const ggActive = isGeoGuessrActive();

    if (getPlayerLocation && !ggActive) {
      const pLoc = getPlayerLocation();
      const pt = latLonToTileXY(pLoc.lat, pLoc.lon, mapState.zoom);
      const px = w / 2 + (pt.x - center.x) * tileSize;
      const py = h / 2 + (pt.y - center.y) * tileSize;
      if (px >= -20 && px <= w + 20 && py >= -20 && py <= h + 20) {
        mapBufferCtx.beginPath();
        mapBufferCtx.arc(px, py, 10, 0, Math.PI * 2);
        mapBufferCtx.fillStyle = "#2563eb";
        mapBufferCtx.fill();
        mapBufferCtx.lineWidth = 4;
        mapBufferCtx.strokeStyle = "#ffffff";
        mapBufferCtx.stroke();
      }
    }

    if (ggActive && games.session.phase === "reveal") {
      const res = games.session.results[games.session.roundIndex];
      if (res) {
        const tTile = latLonToTileXY(res.targetLat, res.targetLon, mapState.zoom);
        const tx = w / 2 + (tTile.x - center.x) * tileSize;
        const ty = h / 2 + (tTile.y - center.y) * tileSize;

        if (res.guessLat !== null && res.guessLon !== null) {
          const gTile = latLonToTileXY(res.guessLat, res.guessLon, mapState.zoom);
          const gx = w / 2 + (gTile.x - center.x) * tileSize;
          const gy = h / 2 + (gTile.y - center.y) * tileSize;

          mapBufferCtx.beginPath();
          mapBufferCtx.moveTo(gx, gy);
          mapBufferCtx.lineTo(tx, ty);
          mapBufferCtx.strokeStyle = "#fbbf24";
          mapBufferCtx.lineWidth = 5;
          mapBufferCtx.setLineDash([12, 8]);
          mapBufferCtx.stroke();
          mapBufferCtx.setLineDash([]);

          mapBufferCtx.beginPath();
          mapBufferCtx.arc(gx, gy, 13, 0, Math.PI * 2);
          mapBufferCtx.fillStyle = "#ef4444";
          mapBufferCtx.fill();
          mapBufferCtx.lineWidth = 4;
          mapBufferCtx.strokeStyle = "#ffffff";
          mapBufferCtx.stroke();
        }

        mapBufferCtx.beginPath();
        mapBufferCtx.arc(tx, ty, 15, 0, Math.PI * 2);
        mapBufferCtx.fillStyle = "#22c55e";
        mapBufferCtx.fill();
        mapBufferCtx.lineWidth = 5;
        mapBufferCtx.strokeStyle = "#ffffff";
        mapBufferCtx.stroke();
      }
    } else if (selectedPlace) {
      const st = latLonToTileXY(selectedPlace.lat, selectedPlace.lon, mapState.zoom);
      const sx = w / 2 + (st.x - center.x) * tileSize;
      const sy = h / 2 + (st.y - center.y) * tileSize;
      if (sx >= -30 && sx <= w + 30 && sy >= -30 && sy <= h + 30) {
        mapBufferCtx.beginPath();
        mapBufferCtx.arc(sx, sy, 14, 0, Math.PI * 2);
        mapBufferCtx.fillStyle = "#ef4444";
        mapBufferCtx.fill();
        mapBufferCtx.lineWidth = 5;
        mapBufferCtx.strokeStyle = "#ffffff";
        mapBufferCtx.stroke();
      }
    }

    if (!renderer.xr.isPresenting && desktopMapCtx && desktopMapCanvas) {
      desktopMapCtx.drawImage(
        mapBufferCanvas,
        0,
        0,
        desktopMapCanvas.width,
        desktopMapCanvas.height
      );
    }

    if (isOpen && activeTab === "map" && renderer.xr.isPresenting) {
      vrMapTex.needsUpdate = true;
    }
  }

  function scheduleMapRender() {
    if (mapPanRafScheduled) return;
    mapPanRafScheduled = true;
    const run = () => {
      mapPanRafScheduled = false;
      renderInteractiveMap();
    };
    const xrSession = renderer && renderer.xr ? renderer.xr.getSession() : null;
    if (xrSession) {
      xrSession.requestAnimationFrame(run);
    } else {
      window.requestAnimationFrame(run);
    }
  }

  function panMapByPixels(dxPx, dyPx) {
    const tileSize = 512;
    const center = latLonToTileXY(mapState.lat, mapState.lon, mapState.zoom);
    const next = tileXYToLatLon(
      center.x - dxPx / tileSize,
      center.y - dyPx / tileSize,
      mapState.zoom
    );
    mapState.lat = next.lat;
    mapState.lon = next.lon;
    scheduleMapRender();
  }

  function selectMapPointAtCanvasXY(xPx, yPx, canvasW, canvasH) {
    if (isGeoGuessrActive() && games.session.phase === "reveal") return;

    const tileSize = 512;
    const scaleX = mapBufferCanvas.width / canvasW;
    const scaleY = mapBufferCanvas.height / canvasH;
    const bx = xPx * scaleX;
    const by = yPx * scaleY;

    const center = latLonToTileXY(mapState.lat, mapState.lon, mapState.zoom);
    const target = tileXYToLatLon(
      center.x + (bx - mapBufferCanvas.width / 2) / tileSize,
      center.y + (by - mapBufferCanvas.height / 2) / tileSize,
      mapState.zoom
    );

    selectedPlace = {
      name: `Pinned (${target.lat.toFixed(4)}, ${target.lon.toFixed(4)})`,
      lat: target.lat,
      lon: target.lon
    };
    if (isGeoGuessrActive()) {
      games.session.pendingGuess = { lat: target.lat, lon: target.lon };
    }
    if (audio) audio.playPin();
    renderInteractiveMap();
    renderDesktopUI();
    renderVRTablet();
  }

  // Zoom around optional buffer-pixel anchor (keeps point under mouse cursor fixed)
  function zoomMap(delta, anchorBx = null, anchorBy = null) {
    const oldZoom = mapState.zoom;
    const newZoom = THREE.MathUtils.clamp(oldZoom + delta, 2, 18);
    if (newZoom === oldZoom) return;

    if (anchorBx !== null && anchorBy !== null) {
      const tileSize = 512;
      const w = mapBufferCanvas.width;
      const h = mapBufferCanvas.height;
      const oldCenter = latLonToTileXY(mapState.lat, mapState.lon, oldZoom);
      const cursorGeo = tileXYToLatLon(
        oldCenter.x + (anchorBx - w / 2) / tileSize,
        oldCenter.y + (anchorBy - h / 2) / tileSize,
        oldZoom
      );
      const cursorTileNew = latLonToTileXY(cursorGeo.lat, cursorGeo.lon, newZoom);
      const newCenterGeo = tileXYToLatLon(
        cursorTileNew.x - (anchorBx - w / 2) / tileSize,
        cursorTileNew.y - (anchorBy - h / 2) / tileSize,
        newZoom
      );
      mapState.lat = newCenterGeo.lat;
      mapState.lon = newCenterGeo.lon;
    }

    mapState.zoom = newZoom;
    if (audio) audio.playZoom(delta > 0);
    renderInteractiveMap();
  }

  function centerMapOnPlayer() {
    if (isGeoGuessrActive() || !getPlayerLocation) return;
    if (audio) audio.playClick();
    const p = getPlayerLocation();
    mapState.lat = p.lat;
    mapState.lon = p.lon;
    renderInteractiveMap();
  }

  // =========================================================================
  // 2. Google Places API (New)
  // =========================================================================
  async function fetchSuggestions(input) {
    const trimmed = input.trim();
    if (trimmed.length < 2) {
      suggestions = [];
      statusMsg = "Type a city, landmark, or address";
      renderVRTablet();
      renderDesktopUI();
      return;
    }

    statusMsg = "Searching...";
    renderVRTablet();
    renderDesktopUI();

    try {
      const res = await fetch(PLACES_AUTOCOMPLETE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": getCurrentApiKey()
        },
        body: JSON.stringify({ input: trimmed })
      });

      if (!res.ok) {
        statusMsg = "Search error (check Places API)";
        suggestions = [];
      } else {
        const data = await res.json();
        suggestions = (data.suggestions || [])
          .filter((s) => s.placePrediction)
          .slice(0, 4)
          .map((s) => ({
            placeId: s.placePrediction.placeId,
            mainText:
              s.placePrediction.structuredFormat?.mainText?.text ||
              s.placePrediction.text?.text ||
              "Unknown",
            secondaryText:
              s.placePrediction.structuredFormat?.secondaryText?.text || ""
          }));
        statusMsg =
          suggestions.length > 0
            ? "Select a location below"
            : "No matching places found";
      }
    } catch (err) {
      statusMsg = "Network error searching places";
      suggestions = [];
    }

    renderVRTablet();
    renderDesktopUI();
  }

  function scheduleAutocomplete() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchSuggestions(queryText), 320);
  }

  async function selectSuggestion(item) {
    statusMsg = `Loading ${item.mainText}...`;
    renderVRTablet();
    renderDesktopUI();

    try {
      const res = await fetch(
        `${PLACES_DETAILS_BASE}${encodeURIComponent(item.placeId)}`,
        {
          headers: {
            "X-Goog-Api-Key": getCurrentApiKey(),
            "X-Goog-FieldMask": "location,displayName,formattedAddress"
          }
        }
      );

      if (res.ok) {
        const data = await res.json();
        if (data.location) {
          selectedPlace = {
            name: data.displayName?.text || item.mainText,
            lat: data.location.latitude,
            lon: data.location.longitude
          };
          mapState.lat = selectedPlace.lat;
          mapState.lon = selectedPlace.lon;
          mapState.zoom = 14;
          statusMsg = `Ready: ${selectedPlace.name}`;
          renderInteractiveMap();
        }
      } else {
        statusMsg = "Could not load coordinates";
      }
    } catch (err) {
      statusMsg = "Error loading place details";
    }

    renderVRTablet();
    renderDesktopUI();
  }

  // =========================================================================
  // 3. Controls Cheat Sheet Helper (Adapts Dynamically to Lefty Mode)
  // =========================================================================
  function getControlsList() {
    const isLefty = settings.handedness === "left";
    const dom = isLefty ? "Left" : "Right";
    const off = isLefty ? "Right" : "Left";
    const menuBtn = isLefty ? "Left Y (Upper)" : "Right B (Upper)";
    const wristBtn = isLefty ? "Right B (Upper)" : "Left Y (Upper)";
    const flyBtn = isLefty ? "Right A (Lower)" : "Left X (Lower)";

    return [
      [`${menuBtn}`, "Open / Close Main Menu (Map, Search, Games, Settings)"],
      [`${wristBtn}`, `Toggle ${off}-Wrist Map (Drag Pan, A/X Pin, FLY/SV/CTR)`],
      ["Either Thumbstick Up/Down", "Zoom 3D Earth In / Out toward laser (All Altitudes)"],
      ["Hold Either Grip + Move L/R", "Rotate Globe North Orientation (L3 Click: North-Up)"],
      ["Hold A or X (Either Hand)", "Ambidextrous Superman Flight (+ Trigger Boost & Opp. Turn)"],
      ["1 Trigger / 2 Triggers", "Grab & Pan 3D Earth / Steering-Wheel Rotate"],
      ["Street View (Either Stick L/R)", "Turn 360° • Tap Trigger: Step • Hold: 100m Big Step"],
      ["Map Tap", `Point ${dom.toLowerCase()} laser + Trigger to pin • Tap A/X to lock`],
      ["Left Menu Button", "Exit VR Mode"]
    ];
  }

  // =========================================================================
  // 4. Desktop Modal Wiring
  // =========================================================================
  const modalEl = document.getElementById("search-modal");
  const inputEl = document.getElementById("search-input");
  const resultsEl = document.getElementById("search-results");
  const selectedEl = document.getElementById("search-selected");
  const sharedActionsEl = document.getElementById("shared-actions");
  const flyBtnEl = document.getElementById("search-fly-btn");
  const svBtnEl = document.getElementById("search-sv-btn");
  const ggSubmitBtn = document.getElementById("gg-submit-btn");
  const ggNextBtn = document.getElementById("gg-next-btn");
  const mapRoundResultEl = document.getElementById("map-round-result");
  const closeBtnEl = document.getElementById("search-close-btn");

  const tabBtns = document.querySelectorAll(".menu-tab-btn");
  const tabPanels = document.querySelectorAll(".menu-tab-panel");

  const mapZoomInBtn = document.getElementById("map-zoom-in");
  const mapZoomOutBtn = document.getElementById("map-zoom-out");
  const mapCenterBtn = document.getElementById("map-center-me");
  const mapSaveBtn = document.getElementById("map-save-btn");
  const mapLuckyBtn = document.getElementById("map-lucky-btn");

  const bmSaveCurrentBtn = document.getElementById("bm-save-current-btn");
  const bookmarksListEl = document.getElementById("bookmarks-list");
  const featLuckyBtn = document.getElementById("feat-lucky-btn");
  const featuredListEl = document.getElementById("featured-list");

  const set3dSnapBtn = document.getElementById("set-3d-snap");
  const set3dSmoothBtn = document.getElementById("set-3d-smooth");
  const setSvSnapBtn = document.getElementById("set-sv-snap");
  const setSvSmoothBtn = document.getElementById("set-sv-smooth");
  const setVigOffBtn = document.getElementById("set-vig-off");
  const setVigOnBtn = document.getElementById("set-vig-on");
  const setHandRightBtn = document.getElementById("set-hand-right");
  const setHandLeftBtn = document.getElementById("set-hand-left");
  const setTodDayBtn = document.getElementById("set-tod-day");
  const setTodSunsetBtn = document.getElementById("set-tod-sunset");
  const setTodNightBtn = document.getElementById("set-tod-night");
  const setSfxOnBtn = document.getElementById("set-sfx-on");
  const setSfxOffBtn = document.getElementById("set-sfx-off");
  const setHdBoostOffBtn = document.getElementById("set-hdboost-off");
  const setHdBoostOnBtn = document.getElementById("set-hdboost-on");
  const keySlotBtns = document.querySelectorAll(".key-slot-btn");
  const customKeyInputEl = document.getElementById("custom-key-input");
  const customKeyPasteBtn = document.getElementById("custom-key-paste");
  const customKeySaveBtn = document.getElementById("custom-key-save");
  const customKeyUseBtn = document.getElementById("custom-key-use");
  const customKeyResetBtn = document.getElementById("custom-key-reset");
  const customKeyPillEl = document.getElementById("custom-key-status-pill");
  const customKeyFeedbackEl = document.getElementById("custom-key-feedback");
  const controlsListEl = document.getElementById("controls-list");

  const ggBestBadgeEl = document.getElementById("gg-best-badge");
  const ggOptMove = document.getElementById("gg-opt-move");
  const ggOptNoMove = document.getElementById("gg-opt-nomove");
  const ggOptUntimed = document.getElementById("gg-opt-untimed");
  const ggOptTimed = document.getElementById("gg-opt-timed");
  const ggStartBtn = document.getElementById("gg-start-btn");
  const ggQuitBtn = document.getElementById("gg-quit-btn");
  const ggCopyBtn = document.getElementById("gg-copy-link-btn");
  const ggSummaryEl = document.getElementById("gg-summary");
  const ggNoticeEl = document.getElementById("gg-challenge-notice");

  const mtBestBadgeEl = document.getElementById("mt-best-badge");
  const mtOptUntimed = document.getElementById("mt-opt-untimed");
  const mtOptTimed = document.getElementById("mt-opt-timed");
  const mtOptMajor = document.getElementById("mt-opt-major");
  const mtOptAll = document.getElementById("mt-opt-all");
  const mtOptHard = document.getElementById("mt-opt-hard");
  const mtRegWorld = document.getElementById("mt-reg-world");
  const mtRegNA = document.getElementById("mt-reg-na");
  const mtRegEU = document.getElementById("mt-reg-eu");
  const mtRegAsia = document.getElementById("mt-reg-asia");
  const mtStartBtn = document.getElementById("mt-start-btn");
  const mtQuitBtn = document.getElementById("mt-quit-btn");
  const mtCopyBtn = document.getElementById("mt-copy-link-btn");
  const mtSummaryEl = document.getElementById("mt-summary");
  const mtNoticeEl = document.getElementById("mt-challenge-notice");

  function setTab(tab) {
    activeTab = tab;
    if (audio) audio.playClick();
    renderDesktopUI();
    renderVRTablet();
    if (tab === "map") renderInteractiveMap();
  }

  tabBtns.forEach((btn) => btn.addEventListener("click", () => setTab(btn.dataset.tab)));
  if (mapZoomInBtn) mapZoomInBtn.addEventListener("click", () => zoomMap(1));
  if (mapZoomOutBtn) mapZoomOutBtn.addEventListener("click", () => zoomMap(-1));
  if (mapCenterBtn) mapCenterBtn.addEventListener("click", centerMapOnPlayer);

  function updateSetting(key, val) {
    settings[key] = val;
    if (audio && key !== "muted") audio.playClick();
    if (onSettingsChange) onSettingsChange(settings);
    renderDesktopUI();
    renderVRTablet();
  }

  if (set3dSnapBtn) set3dSnapBtn.addEventListener("click", () => updateSetting("turn3D", "snap"));
  if (set3dSmoothBtn) set3dSmoothBtn.addEventListener("click", () => updateSetting("turn3D", "smooth"));
  if (setSvSnapBtn) setSvSnapBtn.addEventListener("click", () => updateSetting("turnSV", "snap"));
  if (setSvSmoothBtn) setSvSmoothBtn.addEventListener("click", () => updateSetting("turnSV", "smooth"));
  if (setVigOffBtn) setVigOffBtn.addEventListener("click", () => updateSetting("vignette", false));
  if (setVigOnBtn) setVigOnBtn.addEventListener("click", () => updateSetting("vignette", true));
  if (setHandRightBtn) setHandRightBtn.addEventListener("click", () => updateSetting("handedness", "right"));
  if (setHandLeftBtn) setHandLeftBtn.addEventListener("click", () => updateSetting("handedness", "left"));
  if (setTodDayBtn) setTodDayBtn.addEventListener("click", () => updateSetting("timeOfDay", "day"));
  if (setTodSunsetBtn) setTodSunsetBtn.addEventListener("click", () => updateSetting("timeOfDay", "sunset"));
  if (setTodNightBtn) setTodNightBtn.addEventListener("click", () => updateSetting("timeOfDay", "night"));
  if (setSfxOnBtn) setSfxOnBtn.addEventListener("click", () => updateSetting("muted", false));
  if (setSfxOffBtn) setSfxOffBtn.addEventListener("click", () => updateSetting("muted", true));
  if (setHdBoostOffBtn) setHdBoostOffBtn.addEventListener("click", () => updateSetting("hdBoost", false));
  if (setHdBoostOnBtn) setHdBoostOnBtn.addEventListener("click", () => updateSetting("hdBoost", true));

  function setKeyFeedback(msg) {
    if (!customKeyFeedbackEl) return;
    customKeyFeedbackEl.textContent = msg;
    customKeyFeedbackEl.classList.toggle("hidden", !msg);
  }

  if (customKeyPasteBtn && customKeyInputEl) {
    customKeyPasteBtn.addEventListener("click", async () => {
      customKeyInputEl.focus();
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = (await navigator.clipboard.readText() || "").trim();
          if (text) {
            customKeyInputEl.value = text;
            if (audio) audio.playClick();
            setKeyFeedback("Pasted from clipboard! Click Save & Reload.");
            return;
          }
        }
      } catch (_) {}
      customKeyInputEl.select();
      try {
        const ok = document.execCommand("paste");
        if (ok && customKeyInputEl.value.trim()) {
          if (audio) audio.playClick();
          setKeyFeedback("Pasted! Click Save & Reload.");
          return;
        }
      } catch (_) {}
      setKeyFeedback("Browser blocked clipboard read — tap the input box and use your system paste menu.");
    });
  }

  if (keySlotBtns && keyManager) {
    keySlotBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.slot, 10);
        editingKeySlot = idx;
        if (audio) audio.playClick();
        const st = keyManager.getState();
        if (customKeyInputEl) customKeyInputEl.value = st.slots[idx] || "";
        if (st.slots[idx]) {
          keyManager.selectSlot(idx);
          setKeyFeedback(`Switched to Key ${idx + 1}.`);
        } else {
          setKeyFeedback(`Selected empty Slot ${idx + 1}. Paste a key and click Save Slot.`);
        }
        renderDesktopUI();
        renderVRTablet();
      });
    });
  }

  if (customKeySaveBtn && customKeyInputEl && keyManager) {
    customKeySaveBtn.addEventListener("click", () => {
      const val = customKeyInputEl.value.trim();
      if (!val) {
        setKeyFeedback("Paste an API key first.");
        return;
      }
      keyManager.saveSlot(editingKeySlot, val, true);
      if (audio) audio.playPin();
      setKeyFeedback(`Saved & activated Key ${editingKeySlot + 1}!`);
      renderDesktopUI();
      renderVRTablet();
    });
  }

  if (customKeyUseBtn && keyManager) {
    customKeyUseBtn.addEventListener("click", () => {
      const st = keyManager.getState();
      if (!st.slots[editingKeySlot]) {
        setKeyFeedback(`Slot ${editingKeySlot + 1} is empty.`);
        return;
      }
      keyManager.selectSlot(editingKeySlot);
      if (audio) audio.playClick();
      setKeyFeedback(`Switched to Key ${editingKeySlot + 1}!`);
      renderDesktopUI();
      renderVRTablet();
    });
  }

  if (customKeyResetBtn && keyManager) {
    customKeyResetBtn.addEventListener("click", () => {
      keyManager.clearSlot(editingKeySlot);
      if (customKeyInputEl) customKeyInputEl.value = "";
      if (audio) audio.playClick();
      setKeyFeedback(`Cleared Slot ${editingKeySlot + 1}.`);
      renderDesktopUI();
      renderVRTablet();
    });
  }

  if (mapSaveBtn) {
    mapSaveBtn.addEventListener("click", () => {
      if (selectedPlace) {
        addBookmark(selectedPlace.lat, selectedPlace.lon);
      } else if (getPlayerLocation) {
        const p = getPlayerLocation();
        addBookmark(p.lat, p.lon);
      }
    });
  }
  if (mapLuckyBtn) mapLuckyBtn.addEventListener("click", triggerLucky);
  if (bmSaveCurrentBtn) {
    bmSaveCurrentBtn.addEventListener("click", () => {
      if (getPlayerLocation) {
        const p = getPlayerLocation();
        addBookmark(p.lat, p.lon);
      }
    });
  }
  if (featLuckyBtn) featLuckyBtn.addEventListener("click", triggerLucky);

  if (mtRegWorld) mtRegWorld.addEventListener("click", () => { games.options.mtRegion = "world"; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (mtRegNA) mtRegNA.addEventListener("click", () => { games.options.mtRegion = "na"; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (mtRegEU) mtRegEU.addEventListener("click", () => { games.options.mtRegion = "eu"; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (mtRegAsia) mtRegAsia.addEventListener("click", () => { games.options.mtRegion = "asia"; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });

  if (ggOptMove) ggOptMove.addEventListener("click", () => { games.options.ggMove = true; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (ggOptNoMove) ggOptNoMove.addEventListener("click", () => { games.options.ggMove = false; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (ggOptUntimed) ggOptUntimed.addEventListener("click", () => { games.options.ggTimed = false; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (ggOptTimed) ggOptTimed.addEventListener("click", () => { games.options.ggTimed = true; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (ggStartBtn) {
    ggStartBtn.addEventListener("click", () => {
      const inc = games.getIncomingChallenge();
      games.startGeoGuessr(inc && inc.mode === "geoguessr" ? inc.data : null);
    });
  }
  if (ggCopyBtn) {
    ggCopyBtn.addEventListener("click", () => {
      games.copyShareLink();
      copyFeedback = "Challenge link copied!";
      renderDesktopUI();
      renderVRTablet();
    });
  }

  if (mtOptUntimed) mtOptUntimed.addEventListener("click", () => { games.options.mtTimed = false; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (mtOptTimed) mtOptTimed.addEventListener("click", () => { games.options.mtTimed = true; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (ggQuitBtn) ggQuitBtn.addEventListener("click", () => { games.quitGame(); renderDesktopUI(); renderVRTablet(); });
  if (mtOptMajor) mtOptMajor.addEventListener("click", () => { games.options.mtPool = "major"; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (mtOptAll) mtOptAll.addEventListener("click", () => { games.options.mtPool = "all"; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (mtOptHard) mtOptHard.addEventListener("click", () => { games.options.mtPool = "hard"; if (audio) audio.playClick(); renderDesktopUI(); renderVRTablet(); });
  if (mtQuitBtn) mtQuitBtn.addEventListener("click", () => { games.quitGame(); renderDesktopUI(); renderVRTablet(); });
  if (mtStartBtn) {
    mtStartBtn.addEventListener("click", () => {
      const inc = games.getIncomingChallenge();
      games.startMapTap(inc && inc.mode === "maptap" ? inc.data : null);
    });
  }
  if (mtCopyBtn) {
    mtCopyBtn.addEventListener("click", () => {
      games.copyShareLink();
      copyFeedback = "Challenge link copied!";
      renderDesktopUI();
      renderVRTablet();
    });
  }

  if (ggSubmitBtn) {
    ggSubmitBtn.addEventListener("click", () => {
      if (!selectedPlace) return;
      games.submitGuess(selectedPlace.lat, selectedPlace.lon);
      const res = games.session.results[games.session.roundIndex];
      if (res) {
        mapState.lat = res.targetLat;
        mapState.lon = res.targetLon;
        mapState.zoom = Math.max(2, Math.min(10, Math.round(11 - Math.log2(Math.max(1, res.distKm) / 4))));
      }
      renderInteractiveMap();
      renderDesktopUI();
      renderVRTablet();
    });
  }
  if (ggNextBtn) {
    ggNextBtn.addEventListener("click", () => {
      selectedPlace = null;
      games.nextRound();
      renderDesktopUI();
      renderVRTablet();
    });
  }

  // Desktop Map Mouse Pan / Click-Pin / Cursor-Centered Wheel Zoom
  if (desktopMapCanvas) {
    let dragging = false;
    let startX = 0, startY = 0, lastX = 0, lastY = 0;

    desktopMapCanvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
    });

    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const rect = desktopMapCanvas.getBoundingClientRect();
      panMapByPixels(
        dx * (mapBufferCanvas.width / rect.width),
        dy * (mapBufferCanvas.height / rect.height)
      );
    });

    window.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) {
        const rect = desktopMapCanvas.getBoundingClientRect();
        selectMapPointAtCanvasXY(
          e.clientX - rect.left,
          e.clientY - rect.top,
          rect.width,
          rect.height
        );
      }
    });

    desktopMapCanvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = desktopMapCanvas.getBoundingClientRect();
        const bx = (e.clientX - rect.left) * (mapBufferCanvas.width / rect.width);
        const by = (e.clientY - rect.top) * (mapBufferCanvas.height / rect.height);
        zoomMap(e.deltaY < 0 ? 1 : -1, bx, by);
      },
      { passive: false }
    );
  }

  function renderDesktopUI() {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));
    tabPanels.forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${activeTab}`));

    if (resultsEl) {
      resultsEl.innerHTML = "";
      for (const item of suggestions) {
        const div = document.createElement("div");
        div.className = "search-result-item";
        div.innerHTML = `<strong>${item.mainText}</strong><span>${item.secondaryText}</span>`;
        div.addEventListener("click", () => selectSuggestion(item));
        resultsEl.appendChild(div);
      }
    }

    const ggActive = isGeoGuessrActive();
    const ggReveal = ggActive && games.session.phase === "reveal";
    const showShared = activeTab === "map" || activeTab === "search";

    if (mapRoundResultEl) {
      if (ggReveal) {
        const res = games.session.results[games.session.roundIndex];
        mapRoundResultEl.classList.remove("hidden");
        mapRoundResultEl.textContent = `Round ${games.session.roundIndex + 1}/5 Result: ${res.distKm.toFixed(1)} km away • +${res.score.toLocaleString()} pts (Total: ${games.session.totalScore.toLocaleString()})`;
      } else {
        mapRoundResultEl.classList.add("hidden");
      }
    }

    // Hide shared status text & action buttons on GeoGuessr, Map Tap, Settings, Controls tabs
    if (selectedEl) {
      selectedEl.classList.toggle("hidden", !showShared);
      if (showShared) {
        if (ggActive) {
          selectedEl.textContent = ggReveal
            ? "Green = Actual Location • Red = Your Guess"
            : selectedPlace
            ? `Guess Pin: ${selectedPlace.name}`
            : "Click anywhere on the 2D map to drop your GeoGuessr guess";
        } else if (activeTab === "map") {
          selectedEl.textContent = selectedPlace
            ? `Selected: ${selectedPlace.name}`
            : "Click the map to drop a pin • Scroll to zoom at cursor";
        } else {
          selectedEl.textContent = selectedPlace
            ? `Selected: ${selectedPlace.name}`
            : statusMsg;
        }
      }
    }

    if (sharedActionsEl) {
      sharedActionsEl.classList.toggle("hidden", !showShared);
    }

    if (flyBtnEl) {
      flyBtnEl.classList.toggle("hidden", !showShared || ggActive);
      flyBtnEl.disabled = !selectedPlace;
    }
    if (svBtnEl) {
      svBtnEl.classList.toggle("hidden", !showShared || ggActive);
      svBtnEl.disabled = !selectedPlace;
    }
    if (ggSubmitBtn) {
      ggSubmitBtn.classList.toggle("hidden", !(showShared && ggActive && !ggReveal));
      ggSubmitBtn.disabled = !selectedPlace;
    }
    if (ggNextBtn) {
      ggNextBtn.classList.toggle("hidden", !(showShared && ggReveal));
      ggNextBtn.textContent = games.session.roundIndex < 4 ? "NEXT ROUND" : "VIEW FINAL SCORE";
    }

    if (set3dSnapBtn) set3dSnapBtn.classList.toggle("active", settings.turn3D === "snap");
    if (set3dSmoothBtn) set3dSmoothBtn.classList.toggle("active", settings.turn3D === "smooth");
    if (setSvSnapBtn) setSvSnapBtn.classList.toggle("active", settings.turnSV === "snap");
    if (setSvSmoothBtn) setSvSmoothBtn.classList.toggle("active", settings.turnSV === "smooth");
    if (setVigOffBtn) setVigOffBtn.classList.toggle("active", !settings.vignette);
    if (setVigOnBtn) setVigOnBtn.classList.toggle("active", Boolean(settings.vignette));
    if (setHandRightBtn) setHandRightBtn.classList.toggle("active", settings.handedness !== "left");
    if (setHandLeftBtn) setHandLeftBtn.classList.toggle("active", settings.handedness === "left");
    const tod = settings.timeOfDay || "day";
    if (setTodDayBtn) setTodDayBtn.classList.toggle("active", tod === "day");
    if (setTodSunsetBtn) setTodSunsetBtn.classList.toggle("active", tod === "sunset");
    if (setTodNightBtn) setTodNightBtn.classList.toggle("active", tod === "night");
    if (setSfxOnBtn) setSfxOnBtn.classList.toggle("active", !settings.muted);
    if (setSfxOffBtn) setSfxOffBtn.classList.toggle("active", Boolean(settings.muted));
    if (setHdBoostOffBtn) setHdBoostOffBtn.classList.toggle("active", !settings.hdBoost);
    if (setHdBoostOnBtn) setHdBoostOnBtn.classList.toggle("active", Boolean(settings.hdBoost));
    if (customKeyPillEl && keyManager) {
      const st = keyManager.getState();
      const hasCustom = st.activeSlot >= 0 && Boolean(st.slots[st.activeSlot]);
      customKeyPillEl.textContent = hasCustom
        ? `Key ${st.activeSlot + 1} Active (${st.loadedCount}/5 saved)`
        : "API Key Required";
      customKeyPillEl.classList.toggle("custom", hasCustom);
      if (keySlotBtns) {
        keySlotBtns.forEach((btn) => {
          const idx = parseInt(btn.dataset.slot, 10);
          const filled = Boolean(st.slots[idx]);
          const isAct = st.activeSlot === idx && filled;
          btn.textContent = isAct ? `★ Key ${idx + 1}` : filled ? `Key ${idx + 1} ✓` : `Key ${idx + 1}`;
          btn.classList.toggle("has-key", filled);
          btn.classList.toggle("active-key", isAct);
          btn.classList.toggle("editing", editingKeySlot === idx);
        });
      }
    }

    if (ggOptMove) ggOptMove.classList.toggle("active", games.options.ggMove);
    if (ggOptNoMove) ggOptNoMove.classList.toggle("active", !games.options.ggMove);
    if (ggOptUntimed) ggOptUntimed.classList.toggle("active", !games.options.ggTimed);
    if (ggOptTimed) ggOptTimed.classList.toggle("active", games.options.ggTimed);

    if (mtOptUntimed) mtOptUntimed.classList.toggle("active", !games.options.mtTimed);
    if (mtOptTimed) mtOptTimed.classList.toggle("active", games.options.mtTimed);
    if (mtOptMajor) mtOptMajor.classList.toggle("active", games.options.mtPool === "major");
    if (mtOptAll) mtOptAll.classList.toggle("active", games.options.mtPool === "all");
    if (mtOptHard) mtOptHard.classList.toggle("active", games.options.mtPool === "hard");
    if (mtRegWorld) mtRegWorld.classList.toggle("active", games.options.mtRegion === "world");
    if (mtRegNA) mtRegNA.classList.toggle("active", games.options.mtRegion === "na");
    if (mtRegEU) mtRegEU.classList.toggle("active", games.options.mtRegion === "eu");
    if (mtRegAsia) mtRegAsia.classList.toggle("active", games.options.mtRegion === "asia");

    if (ggBestBadgeEl && games.getOverallBest) {
      const b = games.getOverallBest("geoguessr");
      ggBestBadgeEl.textContent = b
        ? `Top Score: ${b.score.toLocaleString()} / 25,000 (${b.label})`
        : "Top Score: -- / 25,000";
    }
    if (mtBestBadgeEl && games.getOverallBest) {
      const b = games.getOverallBest("maptap");
      mtBestBadgeEl.textContent = b
        ? `Top Score: ${b.score.toLocaleString()} / 25,000 (${b.label})`
        : "Top Score: -- / 25,000";
    }

    if (bookmarksListEl) {
      bookmarksListEl.innerHTML = "";
      if (bookmarks.length === 0) {
        bookmarksListEl.innerHTML = '<div class="panel-hint" style="padding:18px;text-align:center;">No saved spots yet. Click "★ Save Spot" on the Map or Wrist Minimap!</div>';
      } else {
        for (const bm of bookmarks) {
          const card = document.createElement("div");
          card.className = "place-card";
          card.innerHTML = `
            <div class="place-card-info">
              <strong>${bm.name}</strong>
              <span>${bm.address} • (${bm.lat.toFixed(4)}, ${bm.lon.toFixed(4)})</span>
            </div>
            <div class="place-card-actions">
              <button class="btn-3d">3D</button>
              <button class="btn-sv">SV</button>
              <button class="btn-del">✕</button>
            </div>
          `;
          card.querySelector(".btn-3d").addEventListener("click", () => { if (audio) audio.playClick(); onFlyTo(bm.lat, bm.lon); close(); });
          card.querySelector(".btn-sv").addEventListener("click", () => { if (audio) audio.playClick(); onJumpStreetView(bm.lat, bm.lon); close(); });
          card.querySelector(".btn-del").addEventListener("click", () => deleteBookmark(bm.id));
          bookmarksListEl.appendChild(card);
        }
      }
    }

    if (featuredListEl && featuredListEl.childElementCount === 0) {
      for (const fp of FEATURED_PLACES) {
        const card = document.createElement("div");
        card.className = "place-card";
        card.innerHTML = `
          <div class="place-card-info">
            <strong>${fp.name}</strong>
            <span>${fp.category} • ${fp.blurb}</span>
          </div>
          <div class="place-card-actions">
            <button class="btn-3d">3D</button>
            <button class="btn-sv">SV</button>
          </div>
        `;
        card.querySelector(".btn-3d").addEventListener("click", () => { if (audio) audio.playClick(); onFlyTo(fp.lat, fp.lon, fp.alt); close(); });
        card.querySelector(".btn-sv").addEventListener("click", () => { if (audio) audio.playClick(); onJumpStreetView(fp.lat, fp.lon); close(); });
        featuredListEl.appendChild(card);
      }
    }

    const ggRunning = games.session.mode === "geoguessr" && games.session.phase !== "idle" && games.session.phase !== "finished";
    const mtRunning = games.session.mode === "maptap" && games.session.phase !== "idle" && games.session.phase !== "finished";
    if (ggQuitBtn) ggQuitBtn.classList.toggle("hidden", !ggRunning);
    if (mtQuitBtn) mtQuitBtn.classList.toggle("hidden", !mtRunning);

    const inc = games.getIncomingChallenge();
    if (ggNoticeEl) {
      if (games.session.lastError) {
        ggNoticeEl.classList.remove("hidden");
        ggNoticeEl.textContent = games.session.lastError;
      } else if (inc && inc.mode === "geoguessr") {
        ggNoticeEl.classList.remove("hidden");
        ggNoticeEl.textContent = `Friend Challenge Loaded! Beat ${inc.data.score.toLocaleString()} / 25,000 pts (${inc.data.move ? "Move" : "No Move"} • ${inc.data.timed ? "3 Min" : "Untimed"})`;
      } else {
        ggNoticeEl.classList.add("hidden");
      }
    }
    if (mtNoticeEl) {
      if (inc && inc.mode === "maptap") {
        mtNoticeEl.classList.remove("hidden");
        mtNoticeEl.textContent = `Friend Challenge Loaded! Beat ${inc.data.score.toLocaleString()} / 25,000 pts (${inc.data.timed ? "30 Sec" : "Untimed"})`;
      } else {
        mtNoticeEl.classList.add("hidden");
      }
    }

    const ggDone = games.session.mode === "geoguessr" && games.session.phase === "finished";
    if (ggSummaryEl) {
      ggSummaryEl.classList.toggle("hidden", !ggDone);
      if (ggDone) {
        const beat = games.session.challengeTargetScore !== null
          ? ` (Target to beat: ${games.session.challengeTargetScore.toLocaleString()})`
          : "";
        ggSummaryEl.textContent = `Final Score: ${games.session.totalScore.toLocaleString()} / 25,000${beat}. ${copyFeedback}`;
      }
    }
    if (ggCopyBtn) ggCopyBtn.classList.toggle("hidden", !ggDone);

    const mtDone = games.session.mode === "maptap" && games.session.phase === "finished";
    if (mtSummaryEl) {
      mtSummaryEl.classList.toggle("hidden", !mtDone);
      if (mtDone) {
        const beat = games.session.challengeTargetScore !== null
          ? ` (Target to beat: ${games.session.challengeTargetScore.toLocaleString()})`
          : "";
        mtSummaryEl.textContent = `Final Score: ${games.session.totalScore.toLocaleString()} / 25,000${beat}. ${copyFeedback}`;
      }
    }
    if (mtCopyBtn) mtCopyBtn.classList.toggle("hidden", !mtDone);

    if (controlsListEl) {
      controlsListEl.innerHTML = getControlsList()
        .map(([k, v]) => `<li><strong>${k}:</strong> ${v}</li>`)
        .join("");
    }
  }

  if (inputEl) {
    inputEl.addEventListener("input", () => {
      queryText = inputEl.value;
      scheduleAutocomplete();
      renderVRTablet();
    });
  }
  if (flyBtnEl) {
    flyBtnEl.addEventListener("click", () => {
      if (!selectedPlace) return;
      onFlyTo(selectedPlace.lat, selectedPlace.lon);
      close();
    });
  }
  if (svBtnEl) {
    svBtnEl.addEventListener("click", () => {
      if (!selectedPlace) return;
      onJumpStreetView(selectedPlace.lat, selectedPlace.lon);
      close();
    });
  }
  if (closeBtnEl) closeBtnEl.addEventListener("click", () => close());

  // =========================================================================
  // 5. VR Floating 6-Tab 3D Main Menu Tablet (2x Retina + Topmost Layer)
  // =========================================================================
  const W = 1024;
  const H = 840;
  const DPR = 2; // 2048x1680 crisp VR resolution
  const canvas = document.createElement("canvas");
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext("2d");

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const tabletMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.18, 0.96),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    })
  );
  // Always draws on top of 3D tiles, borders (5), and city/state labels (20)
  tabletMesh.renderOrder = 100;
  tabletMesh.visible = false;
  scene.add(tabletMesh);

  // Dedicated child plane for the 952x500 interactive map (avoids re-uploading 2048x1680 tablet while panning)
  const vrMapMesh = new THREE.Mesh(
    new THREE.PlaneGeometry((952 / 1024) * 1.18, (500 / 840) * 0.96),
    new THREE.MeshBasicMaterial({
      map: vrMapTex,
      transparent: true,
      depthTest: false,
      depthWrite: false
    })
  );
  vrMapMesh.position.set(0, (0.5 - 362 / 840) * 0.96, -0.0008);
  vrMapMesh.renderOrder = 99;
  vrMapMesh.visible = false;
  tabletMesh.add(vrMapMesh);

  // Lightweight hover highlight plane so sweeping the laser never redraws the 2048x1680 menu canvas
  const hoverHighlightMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.24,
      depthTest: false,
      depthWrite: false
    })
  );
  hoverHighlightMesh.renderOrder = 101;
  hoverHighlightMesh.visible = false;
  tabletMesh.add(hoverHighlightMesh);

  // High-contrast layered laser cursor dot (transparent: true ensures it renders AFTER tabletMesh)
  const cursorDotMesh = new THREE.Group();
  const cursorOuter = new THREE.Mesh(
    new THREE.CircleGeometry(0.018, 24),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    })
  );
  cursorOuter.renderOrder = 111;
  cursorDotMesh.add(cursorOuter);

  const cursorRing = new THREE.Mesh(
    new THREE.CircleGeometry(0.0145, 24),
    new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      depthWrite: false
    })
  );
  cursorRing.renderOrder = 112;
  cursorDotMesh.add(cursorRing);

  const cursorCore = new THREE.Mesh(
    new THREE.CircleGeometry(0.0085, 20),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      depthWrite: false
    })
  );
  cursorCore.renderOrder = 113;
  cursorDotMesh.add(cursorCore);

  cursorDotMesh.visible = false;
  scene.add(cursorDotMesh);

  const MAP_RECT = { x: 36, y: 112, w: 952, h: 500 };
  let hitZones = [];

  function drawRoundedRect(x, y, w, h, r, fill, stroke = null, lineW = 3) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.lineWidth = lineW;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  function addZone(id, x, y, w, h, onClick) {
    hitZones.push({ id, x, y, w, h, onClick });
  }

  function renderVRTablet() {
    hitZones = [];
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawRoundedRect(8, 8, W - 16, H - 16, 28, "rgba(10, 15, 30, 0.97)", "#38bdf8", 4);

    // 8 Top Tabs + Compact Close Button
    const tabs = [
      { id: "map", label: "MAP" },
      { id: "search", label: "SEARCH" },
      { id: "bookmarks", label: "SAVED" },
      { id: "featured", label: "FEATURED" },
      { id: "geoguessr", label: "GEOGUESSR" },
      { id: "maptap", label: "MAP TAP" },
      { id: "settings", label: "SETTINGS" },
      { id: "controls", label: "CONTROLS" }
    ];

    let tx = 26;
    const tabW = 108;
    const tabGap = 6;
    for (const t of tabs) {
      const isAct = activeTab === t.id;
      const isHov = hoveredHitId === `tab_${t.id}`;
      drawRoundedRect(
        tx, 26, tabW, 54, 10,
        isAct ? "#2563eb" : isHov ? "#334155" : "#1e293b",
        isAct ? "#93c5fd" : "#475569", 2
      );
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 15px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t.label, tx + tabW / 2, 54);
      addZone(`tab_${t.id}`, tx, 26, tabW, 54, () => setTab(t.id));
      tx += tabW + tabGap;
    }

    const closeHov = hoveredHitId === "close";
    drawRoundedRect(938, 26, 60, 54, 10, closeHov ? "#dc2626" : "#991b1b", "#fca5a5", 2);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px system-ui, sans-serif";
    ctx.fillText("✕", 968, 54);
    addZone("close", 938, 26, 60, 54, () => close());

    vrMapMesh.visible = activeTab === "map";

    // ---------------- TAB 1: MAP ----------------
    if (activeTab === "map") {
      // Clear window so dedicated opaque-backed vrMapMesh (renderOrder 99) shows through with 0ms pan cost
      ctx.clearRect(MAP_RECT.x, MAP_RECT.y, MAP_RECT.w, MAP_RECT.h);
      vrMapTex.needsUpdate = true;
      drawRoundedRect(MAP_RECT.x, MAP_RECT.y, MAP_RECT.w, MAP_RECT.h, 14, null, "#475569", 3);

      drawRoundedRect(916, 126, 56, 56, 12, hoveredHitId === "map_zin" ? "#2563eb" : "rgba(15,23,42,0.9)", "#94a3b8", 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 34px system-ui, sans-serif";
      ctx.fillText("+", 944, 156);
      addZone("map_zin", 916, 126, 56, 56, () => zoomMap(1));

      drawRoundedRect(916, 192, 56, 56, 12, hoveredHitId === "map_zout" ? "#2563eb" : "rgba(15,23,42,0.9)", "#94a3b8", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("−", 944, 220);
      addZone("map_zout", 916, 192, 56, 56, () => zoomMap(-1));

      const ggActive = isGeoGuessrActive();
      const ggReveal = ggActive && games.session.phase === "reveal";

      if (!ggActive) {
        drawRoundedRect(512, 544, 146, 52, 12, hoveredHitId === "map_save" ? "#f59e0b" : "rgba(217,119,6,0.92)", "#fcd34d", 2);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 18px system-ui, sans-serif";
        ctx.fillText("★ SAVE SPOT", 585, 571);
        addZone("map_save", 512, 544, 146, 52, () => {
          if (selectedPlace) addBookmark(selectedPlace.lat, selectedPlace.lon);
          else if (getPlayerLocation) { const p = getPlayerLocation(); addBookmark(p.lat, p.lon); }
        });

        drawRoundedRect(668, 544, 146, 52, 12, hoveredHitId === "map_lucky" ? "#8b5cf6" : "rgba(124,58,237,0.92)", "#c4b5fd", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText("🎲 LUCKY", 741, 571);
        addZone("map_lucky", 668, 544, 146, 52, triggerLucky);

        drawRoundedRect(824, 544, 148, 52, 12, hoveredHitId === "map_center" ? "#2563eb" : "rgba(15,23,42,0.9)", "#94a3b8", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText("CENTER ME", 898, 571);
        addZone("map_center", 824, 544, 148, 52, centerMapOnPlayer);
      }

      ctx.textAlign = "left";
      ctx.font = "22px system-ui, sans-serif";
      if (ggReveal) {
        const res = games.session.results[games.session.roundIndex];
        ctx.fillStyle = "#4ade80";
        ctx.fillText(`Round ${games.session.roundIndex + 1}/5: ${res.distKm.toFixed(1)} km away • +${res.score.toLocaleString()} pts`, 36, 654);
      } else {
        ctx.fillStyle = selectedPlace ? "#4ade80" : "#94a3b8";
        ctx.fillText(
          selectedPlace
            ? `Pinned: ${selectedPlace.name}`
            : "Click map to drop pin • Sticks: Zoom & Pan",
          36,
          654
        );
      }

      ctx.textAlign = "center";
      ctx.font = "bold 26px system-ui, sans-serif";
      if (ggActive) {
        if (!ggReveal) {
          const canSub = Boolean(selectedPlace);
          drawRoundedRect(36, 696, 952, 82, 14, canSub ? "#16a34a" : "#334155", canSub ? "#86efac" : "#475569", 2);
          ctx.fillStyle = canSub ? "#ffffff" : "#94a3b8";
          ctx.fillText("SUBMIT GEOGUESSR GUESS", 512, 738);
          if (canSub) {
            addZone("vr_gg_submit", 36, 696, 952, 82, () => {
              games.submitGuess(selectedPlace.lat, selectedPlace.lon);
              const res = games.session.results[games.session.roundIndex];
              if (res) {
                mapState.lat = res.targetLat;
                mapState.lon = res.targetLon;
                mapState.zoom = Math.max(2, Math.min(10, Math.round(11 - Math.log2(Math.max(1, res.distKm) / 4))));
              }
              renderInteractiveMap();
              renderVRTablet();
            });
          }
        } else {
          drawRoundedRect(36, 696, 952, 82, 14, "#2563eb", "#93c5fd", 2);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(games.session.roundIndex < 4 ? "NEXT ROUND" : "VIEW FINAL SCORE", 512, 738);
          addZone("vr_gg_next", 36, 696, 952, 82, () => {
            selectedPlace = null;
            games.nextRound();
            renderVRTablet();
          });
        }
      } else {
        const canAct = Boolean(selectedPlace);
        drawRoundedRect(36, 696, 464, 82, 14, canAct ? "#2563eb" : "#334155");
        ctx.fillStyle = canAct ? "#ffffff" : "#94a3b8";
        ctx.fillText("FLY TO 3D EARTH", 268, 738);
        if (canAct) {
          addZone("map_fly", 36, 696, 464, 82, () => { onFlyTo(selectedPlace.lat, selectedPlace.lon); close(); });
        }

        drawRoundedRect(524, 696, 464, 82, 14, canAct ? "#16a34a" : "#334155");
        ctx.fillStyle = canAct ? "#ffffff" : "#94a3b8";
        ctx.fillText("ENTER STREET VIEW", 756, 738);
        if (canAct) {
          addZone("map_sv", 524, 696, 464, 82, () => { onJumpStreetView(selectedPlace.lat, selectedPlace.lon); close(); });
        }
      }
    }

    // ---------------- TAB 2: SEARCH ----------------
    else if (activeTab === "search") {
      drawRoundedRect(36, 108, 796, 60, 14, "#1e293b", "#64748b", 2);
      ctx.fillStyle = queryText ? "#ffffff" : "#94a3b8";
      ctx.font = "28px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText((queryText ? `${queryText}|` : "Type a city, address, or landmark...").slice(-42), 56, 139);

      drawRoundedRect(848, 108, 140, 60, 14, hoveredHitId === "clear" ? "#475569" : "#334155", "#94a3b8", 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 22px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("CLEAR", 918, 139);
      addZone("clear", 848, 108, 140, 60, () => {
        queryText = ""; suggestions = []; selectedPlace = null;
        statusMsg = "Type a city, landmark, or address";
        if (inputEl) inputEl.value = "";
        renderVRTablet(); renderDesktopUI();
      });

      ctx.fillStyle = "#94a3b8";
      ctx.font = "20px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(statusMsg, 36, 192);

      for (let i = 0; i < 4; i++) {
        const y = 210 + i * 58;
        const item = suggestions[i];
        if (item) {
          const id = `sug_${i}`;
          drawRoundedRect(36, y, 610, 52, 10, hoveredHitId === id ? "#1d4ed8" : "#1e293b", "#38bdf8", 2);
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 22px system-ui, sans-serif";
          ctx.fillText(item.mainText.slice(0, 38), 52, y + 19);
          ctx.fillStyle = "#cbd5e1";
          ctx.font = "16px system-ui, sans-serif";
          ctx.fillText(item.secondaryText.slice(0, 48), 52, y + 39);
          addZone(id, 36, y, 610, 52, () => selectSuggestion(item));
        } else {
          drawRoundedRect(36, y, 610, 52, 10, "rgba(30, 41, 59, 0.35)");
        }
      }

      const canAct = Boolean(selectedPlace);
      drawRoundedRect(666, 210, 322, 226, 14, "#0f172a", "#334155", 2);
      ctx.textAlign = "center";
      ctx.fillStyle = canAct ? "#4ade80" : "#64748b";
      ctx.font = "bold 20px system-ui, sans-serif";
      ctx.fillText(canAct ? selectedPlace.name.slice(0, 24) : "Select a result", 827, 240);

      drawRoundedRect(684, 266, 286, 48, 10, canAct ? "#2563eb" : "#334155");
      ctx.fillStyle = canAct ? "#ffffff" : "#94a3b8";
      ctx.fillText("FLY TO 3D EARTH", 827, 291);
      if (canAct) addZone("srch_fly", 684, 266, 286, 48, () => { onFlyTo(selectedPlace.lat, selectedPlace.lon); close(); });

      drawRoundedRect(684, 322, 286, 48, 10, canAct ? "#16a34a" : "#334155");
      ctx.fillStyle = canAct ? "#ffffff" : "#94a3b8";
      ctx.fillText("ENTER STREET VIEW", 827, 347);
      if (canAct) addZone("srch_sv", 684, 322, 286, 48, () => { onJumpStreetView(selectedPlace.lat, selectedPlace.lon); close(); });

      drawRoundedRect(684, 378, 286, 44, 10, "#1e293b", "#475569", 2);
      ctx.fillStyle = canAct ? "#e2e8f0" : "#64748b";
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.fillText("VIEW ON 2D MAP", 827, 401);
      if (canAct) addZone("srch_map", 684, 378, 286, 44, () => setTab("map"));

      const rows = [
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
        ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
        ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
        ["Z", "X", "C", "V", "B", "N", "M", ",", "."]
      ];
      const keyW = 86, keyH = 62, gap = 10;
      let startY = 468;

      for (const row of rows) {
        const rowWidth = row.length * keyW + (row.length - 1) * gap;
        let startX = (W - rowWidth) / 2;
        for (const ch of row) {
          const id = `key_${ch}`;
          const isHov = hoveredHitId === id;
          drawRoundedRect(startX, startY, keyW, keyH, 10, isHov ? "#38bdf8" : "#1e293b", "#475569", 2);
          ctx.fillStyle = isHov ? "#0f172a" : "#f8fafc";
          ctx.font = "bold 26px system-ui, sans-serif";
          ctx.fillText(ch, startX + keyW / 2, startY + keyH / 2 + 2);
          addZone(id, startX, startY, keyW, keyH, () => {
            if (audio) audio.playKey();
            queryText += ch.toLowerCase();
            if (inputEl) inputEl.value = queryText;
            scheduleAutocomplete();
            renderVRTablet();
          });
          startX += keyW + gap;
        }
        startY += keyH + gap;
      }

      drawRoundedRect(210, startY, 440, 58, 10, hoveredHitId === "space" ? "#38bdf8" : "#1e293b", "#475569", 2);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 22px system-ui, sans-serif";
      ctx.fillText("SPACE", 430, startY + 30);
      addZone("space", 210, startY, 440, 58, () => { if (audio) audio.playKey(); queryText += " "; if (inputEl) inputEl.value = queryText; scheduleAutocomplete(); renderVRTablet(); });

      drawRoundedRect(666, startY, 180, 58, 10, hoveredHitId === "backspace" ? "#f59e0b" : "#334155", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("DELETE", 756, startY + 30);
      addZone("backspace", 666, startY, 180, 58, () => { if (audio) audio.playKey(); queryText = queryText.slice(0, -1); if (inputEl) inputEl.value = queryText; scheduleAutocomplete(); renderVRTablet(); });
    }

    // ---------------- TAB 3: BOOKMARKS ----------------
    else if (activeTab === "bookmarks") {
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`Saved Bookmarks (${bookmarks.length})`, 48, 136);

      drawRoundedRect(710, 108, 266, 54, 12, hoveredHitId === "vr_bm_save" ? "#22c55e" : "#16a34a", "#86efac", 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("★ SAVE CURRENT SPOT", 843, 136);
      addZone("vr_bm_save", 710, 108, 266, 54, () => {
        if (getPlayerLocation) { const p = getPlayerLocation(); addBookmark(p.lat, p.lon); }
      });

      const perPage = 6;
      const totalPages = Math.max(1, Math.ceil(bookmarks.length / perPage));
      vrBookmarksPage = Math.min(vrBookmarksPage, totalPages - 1);
      const slice = bookmarks.slice(vrBookmarksPage * perPage, (vrBookmarksPage + 1) * perPage);

      if (slice.length === 0) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "24px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("No bookmarks yet. Save a spot from the Map or Wrist Minimap!", 512, 420);
      } else {
        let y = 182;
        slice.forEach((bm, i) => {
          drawRoundedRect(48, y, 928, 86, 12, "#1e293b", "#334155", 2);
          ctx.textAlign = "left";
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 22px system-ui, sans-serif";
          ctx.fillText((bm.name || "Saved Spot").slice(0, 38), 68, y + 30);
          ctx.fillStyle = "#94a3b8";
          ctx.font = "17px system-ui, sans-serif";
          ctx.fillText(`${(bm.address || "").slice(0, 44)} • (${bm.lat.toFixed(3)}, ${bm.lon.toFixed(3)})`, 68, y + 60);

          ctx.textAlign = "center";
          ctx.font = "bold 19px system-ui, sans-serif";
          drawRoundedRect(692, y + 17, 94, 52, 10, hoveredHitId === `bm3d_${i}` ? "#3b82f6" : "#2563eb");
          ctx.fillStyle = "#ffffff";
          ctx.fillText("3D", 739, y + 44);
          addZone(`bm3d_${i}`, 692, y + 17, 94, 52, () => { if (audio) audio.playClick(); onFlyTo(bm.lat, bm.lon); close(); });

          drawRoundedRect(796, y + 17, 94, 52, 10, hoveredHitId === `bmsv_${i}` ? "#22c55e" : "#16a34a");
          ctx.fillStyle = "#ffffff";
          ctx.fillText("SV", 843, y + 44);
          addZone(`bmsv_${i}`, 796, y + 17, 94, 52, () => { if (audio) audio.playClick(); onJumpStreetView(bm.lat, bm.lon); close(); });

          drawRoundedRect(900, y + 17, 60, 52, 10, hoveredHitId === `bmdel_${i}` ? "#dc2626" : "#991b1b");
          ctx.fillStyle = "#ffffff";
          ctx.fillText("✕", 930, y + 44);
          addZone(`bmdel_${i}`, 900, y + 17, 60, 52, () => deleteBookmark(bm.id));
          y += 96;
        });
      }

      if (totalPages > 1) {
        drawRoundedRect(340, 766, 120, 46, 10, vrBookmarksPage > 0 ? "#2563eb" : "#334155");
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 19px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("◀ PREV", 400, 790);
        if (vrBookmarksPage > 0) addZone("bm_prev", 340, 766, 120, 46, () => { vrBookmarksPage--; renderVRTablet(); });

        ctx.fillStyle = "#cbd5e1";
        ctx.fillText(`${vrBookmarksPage + 1} / ${totalPages}`, 512, 790);

        drawRoundedRect(564, 766, 120, 46, 10, vrBookmarksPage < totalPages - 1 ? "#2563eb" : "#334155");
        ctx.fillStyle = "#ffffff";
        ctx.fillText("NEXT ▶", 624, 790);
        if (vrBookmarksPage < totalPages - 1) addZone("bm_next", 564, 766, 120, 46, () => { vrBookmarksPage++; renderVRTablet(); });
      }
    }

    // ---------------- TAB 4: FEATURED PLACES ----------------
    else if (activeTab === "featured") {
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Featured Places", 48, 136);

      drawRoundedRect(710, 108, 266, 54, 12, hoveredHitId === "vr_feat_lucky" ? "#8b5cf6" : "#7c3aed", "#c4b5fd", 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("🎲 I'M FEELING LUCKY", 843, 136);
      addZone("vr_feat_lucky", 710, 108, 266, 54, triggerLucky);

      const perPage = 6;
      const totalPages = Math.max(1, Math.ceil(FEATURED_PLACES.length / perPage));
      vrFeaturedPage = Math.min(vrFeaturedPage, totalPages - 1);
      const slice = FEATURED_PLACES.slice(vrFeaturedPage * perPage, (vrFeaturedPage + 1) * perPage);

      let y = 182;
      slice.forEach((fp, i) => {
        drawRoundedRect(48, y, 928, 86, 12, "#1e293b", "#334155", 2);
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 22px system-ui, sans-serif";
        ctx.fillText(fp.name.slice(0, 40), 68, y + 30);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "17px system-ui, sans-serif";
        ctx.fillText(`${fp.category} • ${fp.blurb}`, 68, y + 60);

        ctx.textAlign = "center";
        ctx.font = "bold 19px system-ui, sans-serif";
        drawRoundedRect(722, y + 17, 114, 52, 10, hoveredHitId === `fp3d_${i}` ? "#3b82f6" : "#2563eb");
        ctx.fillStyle = "#ffffff";
        ctx.fillText("3D GLOBE", 779, y + 44);
        addZone(`fp3d_${i}`, 722, y + 17, 114, 52, () => { if (audio) audio.playClick(); onFlyTo(fp.lat, fp.lon, fp.alt); close(); });

        drawRoundedRect(846, y + 17, 114, 52, 10, hoveredHitId === `fpsv_${i}` ? "#22c55e" : "#16a34a");
        ctx.fillStyle = "#ffffff";
        ctx.fillText("STREET", 903, y + 44);
        addZone(`fpsv_${i}`, 846, y + 17, 114, 52, () => { if (audio) audio.playClick(); onJumpStreetView(fp.lat, fp.lon); close(); });
        y += 96;
      });

      drawRoundedRect(340, 766, 120, 46, 10, vrFeaturedPage > 0 ? "#2563eb" : "#334155");
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 19px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("◀ PREV", 400, 790);
      if (vrFeaturedPage > 0) addZone("fp_prev", 340, 766, 120, 46, () => { vrFeaturedPage--; renderVRTablet(); });

      ctx.fillStyle = "#cbd5e1";
      ctx.fillText(`${vrFeaturedPage + 1} / ${totalPages}`, 512, 790);

      drawRoundedRect(564, 766, 120, 46, 10, vrFeaturedPage < totalPages - 1 ? "#2563eb" : "#334155");
      ctx.fillStyle = "#ffffff";
      ctx.fillText("NEXT ▶", 624, 790);
      if (vrFeaturedPage < totalPages - 1) addZone("fp_next", 564, 766, 120, 46, () => { vrFeaturedPage++; renderVRTablet(); });
    }

    // ---------------- TAB 3: GEOGUESSR ----------------
    else if (activeTab === "geoguessr") {
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 34px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("GeoGuessr — 5-Round Challenge", 48, 148);
      if (games.getOverallBest) {
        const b = games.getOverallBest("geoguessr");
        ctx.textAlign = "right";
        ctx.fillStyle = "#4ade80";
        ctx.font = "bold 20px system-ui, sans-serif";
        ctx.fillText(b ? `Top: ${b.score.toLocaleString()} / 25,000` : "Top: -- / 25,000", 976, 136);
        if (b) {
          ctx.fillStyle = "#94a3b8";
          ctx.font = "16px system-ui, sans-serif";
          ctx.fillText(b.label, 976, 162);
        }
        ctx.textAlign = "left";
      }

      drawRoundedRect(48, 194, 928, 120, 16, "#1e293b", "#334155", 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.fillText("Street View Movement", 80, 238);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "20px system-ui, sans-serif";
      ctx.fillText("Walk down roads freely or lock to the starting spot", 80, 276);

      ctx.textAlign = "center";
      ctx.font = "bold 22px system-ui, sans-serif";
      drawRoundedRect(640, 220, 152, 68, 12, games.options.ggMove ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("MOVE", 716, 255);
      addZone("vr_gg_move", 640, 220, 152, 68, () => { games.options.ggMove = true; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      drawRoundedRect(804, 220, 152, 68, 12, !games.options.ggMove ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("NO MOVE", 880, 255);
      addZone("vr_gg_nomove", 804, 220, 152, 68, () => { games.options.ggMove = false; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      drawRoundedRect(48, 336, 928, 120, 16, "#1e293b", "#334155", 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.fillText("Round Timer", 80, 380);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "20px system-ui, sans-serif";
      ctx.fillText("Untimed exploration or 3 minutes per round", 80, 418);

      ctx.textAlign = "center";
      ctx.font = "bold 22px system-ui, sans-serif";
      drawRoundedRect(640, 362, 152, 68, 12, !games.options.ggTimed ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("UNTIMED", 716, 397);
      addZone("vr_gg_untimed", 640, 362, 152, 68, () => { games.options.ggTimed = false; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      drawRoundedRect(804, 362, 152, 68, 12, games.options.ggTimed ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("3 MIN", 880, 397);
      addZone("vr_gg_timed", 804, 362, 152, 68, () => { games.options.ggTimed = true; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      const ggDone = games.session.mode === "geoguessr" && games.session.phase === "finished";
      if (games.session.lastError && !ggDone) {
        drawRoundedRect(48, 486, 928, 110, 14, "#451a03", "#fb923c", 2);
        ctx.fillStyle = "#fdba74";
        ctx.font = "bold 24px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(games.session.lastError.slice(0, 68), 512, 542);
      }
      if (ggDone) {
        drawRoundedRect(48, 486, 928, 110, 14, "#0f172a", "#4ade80", 2);
        ctx.fillStyle = "#4ade80";
        ctx.font = "bold 32px system-ui, sans-serif";
        ctx.fillText(`Final Score: ${games.session.totalScore.toLocaleString()} / 25,000`, 512, 528);
        ctx.fillStyle = "#cbd5e1";
        ctx.font = "22px system-ui, sans-serif";
        ctx.fillText(copyFeedback || "Share your link so a friend plays the exact same 5 spots!", 512, 568);
      }

      const ggRunning = games.session.mode === "geoguessr" && games.session.phase !== "idle" && games.session.phase !== "finished";
      const ggSplit = ggDone || ggRunning;

      drawRoundedRect(48, 636, ggSplit ? 450 : 928, 84, 14, "#16a34a", "#86efac", 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.fillText("START 5-ROUND GEOGUESSR", ggSplit ? 273 : 512, 679);
      addZone("vr_gg_start", 48, 636, ggSplit ? 450 : 928, 84, () => {
        const inc = games.getIncomingChallenge();
        games.startGeoGuessr(inc && inc.mode === "geoguessr" ? inc.data : null);
      });

      if (ggRunning) {
        drawRoundedRect(524, 636, 452, 84, 14, "#b91c1c", "#fca5a5", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText("END CURRENT GAME", 750, 679);
        addZone("vr_gg_quit", 524, 636, 452, 84, () => {
          games.quitGame();
          close();
        });
      } else if (ggDone) {
        drawRoundedRect(524, 636, 452, 84, 14, "#2563eb", "#93c5fd", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText("COPY CHALLENGE LINK", 750, 679);
        addZone("vr_gg_copy", 524, 636, 452, 84, () => {
          games.copyShareLink();
          copyFeedback = "Copied to clipboard!";
          renderVRTablet();
        });
      }
    }

    // ---------------- TAB 4: MAP TAP ----------------
    else if (activeTab === "maptap") {
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 34px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Map Tap — 5-Round Globe Challenge", 48, 148);
      if (games.getOverallBest) {
        const b = games.getOverallBest("maptap");
        ctx.textAlign = "right";
        ctx.fillStyle = "#4ade80";
        ctx.font = "bold 20px system-ui, sans-serif";
        ctx.fillText(b ? `Top: ${b.score.toLocaleString()} / 25,000` : "Top: -- / 25,000", 976, 136);
        if (b) {
          ctx.fillStyle = "#94a3b8";
          ctx.font = "16px system-ui, sans-serif";
          ctx.fillText(b.label, 976, 162);
        }
        ctx.textAlign = "left";
      }

      drawRoundedRect(48, 194, 928, 120, 16, "#1e293b", "#334155", 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.fillText("Round Timer", 80, 238);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "20px system-ui, sans-serif";
      ctx.fillText("Untimed or 30 seconds per city", 80, 276);

      ctx.textAlign = "center";
      ctx.font = "bold 22px system-ui, sans-serif";
      drawRoundedRect(640, 220, 152, 68, 12, !games.options.mtTimed ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("UNTIMED", 716, 255);
      addZone("vr_mt_untimed", 640, 220, 152, 68, () => { games.options.mtTimed = false; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      drawRoundedRect(804, 220, 152, 68, 12, games.options.mtTimed ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("30 SEC", 880, 255);
      addZone("vr_mt_timed", 804, 220, 152, 68, () => { games.options.mtTimed = true; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      drawRoundedRect(48, 336, 928, 120, 16, "#1e293b", "#334155", 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.fillText("City Pool", 80, 380);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "19px system-ui, sans-serif";
      ctx.fillText("Major hubs, 220+ cities, or Hard (100k+ towns)", 80, 418);

      ctx.textAlign = "center";
      ctx.font = "bold 20px system-ui, sans-serif";
      drawRoundedRect(512, 362, 138, 68, 12, games.options.mtPool === "major" ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("MAJOR", 581, 397);
      addZone("vr_mt_major", 512, 362, 138, 68, () => { games.options.mtPool = "major"; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      drawRoundedRect(662, 362, 138, 68, 12, games.options.mtPool === "all" ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("ALL 220+", 731, 397);
      addZone("vr_mt_all", 662, 362, 138, 68, () => { games.options.mtPool = "all"; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      drawRoundedRect(812, 362, 144, 68, 12, games.options.mtPool === "hard" ? "#2563eb" : "#0f172a", "#64748b", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("HARD 100K+", 884, 397);
      addZone("vr_mt_hard", 812, 362, 144, 68, () => { games.options.mtPool = "hard"; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });

      // Region Filter row
      drawRoundedRect(48, 476, 928, 108, 16, "#1e293b", "#334155", 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 24px system-ui, sans-serif";
      ctx.fillText("Region Filter", 80, 518);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "18px system-ui, sans-serif";
      ctx.fillText("Play globally or focus on one continent", 80, 552);

      const regs = [
        { id: "world", label: "WORLD" },
        { id: "na", label: "N. AMER" },
        { id: "eu", label: "EUROPE" },
        { id: "asia", label: "ASIA" }
      ];
      ctx.textAlign = "center";
      ctx.font = "bold 18px system-ui, sans-serif";
      let rx = 468;
      for (const rg of regs) {
        drawRoundedRect(rx, 500, 114, 60, 12, games.options.mtRegion === rg.id ? "#2563eb" : "#0f172a", "#64748b", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(rg.label, rx + 57, 531);
        addZone(`vr_mt_reg_${rg.id}`, rx, 500, 114, 60, () => { games.options.mtRegion = rg.id; if (audio) audio.playClick(); renderVRTablet(); renderDesktopUI(); });
        rx += 124;
      }

      const mtDone = games.session.mode === "maptap" && games.session.phase === "finished";
      const mtRunning = games.session.mode === "maptap" && games.session.phase !== "idle" && games.session.phase !== "finished";
      const mtSplit = mtDone || mtRunning;

      if (mtDone) {
        drawRoundedRect(48, 600, 928, 92, 14, "#0f172a", "#4ade80", 2);
        ctx.fillStyle = "#4ade80";
        ctx.font = "bold 28px system-ui, sans-serif";
        ctx.fillText(`Final Score: ${games.session.totalScore.toLocaleString()} / 25,000${games.session.isNewBest ? " ★ NEW BEST!" : ""}`, 512, 634);
        ctx.fillStyle = "#cbd5e1";
        ctx.font = "19px system-ui, sans-serif";
        ctx.fillText(copyFeedback || "Share your link so a friend plays the exact same 5 cities!", 512, 668);
      }

      drawRoundedRect(48, 708, mtSplit ? 450 : 928, 82, 14, "#16a34a", "#86efac", 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.fillText("START 5-ROUND MAP TAP", mtSplit ? 273 : 512, 750);
      addZone("vr_mt_start", 48, 708, mtSplit ? 450 : 928, 82, () => {
        const inc = games.getIncomingChallenge();
        games.startMapTap(inc && inc.mode === "maptap" ? inc.data : null);
      });

      if (mtRunning) {
        drawRoundedRect(524, 708, 452, 82, 14, "#b91c1c", "#fca5a5", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText("END CURRENT GAME", 750, 750);
        addZone("vr_mt_quit", 524, 708, 452, 82, () => {
          games.quitGame();
          close();
        });
      } else if (mtDone) {
        drawRoundedRect(524, 708, 452, 82, 14, "#2563eb", "#93c5fd", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText("COPY CHALLENGE LINK", 750, 750);
        addZone("vr_mt_copy", 524, 708, 452, 82, () => {
          games.copyShareLink();
          copyFeedback = "Copied to clipboard!";
          renderVRTablet();
        });
      }
    }

    // ---------------- TAB 5: SETTINGS ----------------
    else if (activeTab === "settings") {
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("VR Comfort, Sky, Audio & API Key", 48, 118);

      const rows = [
        {
          title: "3D Earth Turning (Superman Stick)",
          sub: "Instant 45° snap or continuous smooth rotation",
          lLabel: "SNAP 45°", rLabel: "SMOOTH",
          isLeft: settings.turn3D === "snap",
          onL: () => updateSetting("turn3D", "snap"),
          onR: () => updateSetting("turn3D", "smooth")
        },
        {
          title: "Street View Turning (VR Stick)",
          sub: "Rotate 360° panorama while seated",
          lLabel: "SNAP 45°", rLabel: "SMOOTH",
          isLeft: settings.turnSV === "snap",
          onL: () => updateSetting("turnSV", "snap"),
          onR: () => updateSetting("turnSV", "smooth")
        },
        {
          title: "VR Comfort Vignette",
          sub: "Darkens peripheral vision while moving",
          lLabel: "OFF", rLabel: "ON",
          isLeft: !settings.vignette,
          onL: () => updateSetting("vignette", false),
          onR: () => updateSetting("vignette", true)
        },
        {
          title: "VR Handedness (Lefty Mode)",
          sub: "Swaps wrist minimap, pointer & menu hand",
          lLabel: "RIGHTY", rLabel: "LEFTY",
          isLeft: settings.handedness !== "left",
          onL: () => updateSetting("handedness", "right"),
          onR: () => updateSetting("handedness", "left")
        },
        {
          title: "UI & Game Sound Effects",
          sub: "Subtle clicks & chimes (no background noise)",
          lLabel: "ON", rLabel: "MUTED",
          isLeft: !settings.muted,
          onL: () => updateSetting("muted", false),
          onR: () => updateSetting("muted", true)
        },
        {
          title: "HD Cruise Boost (Higher-Res Street View)",
          sub: "Uses 4x tiles (burns 15k cap faster) — best with multiple keys",
          lLabel: "OFF (z=1)", rLabel: "ON (HD)",
          isLeft: !settings.hdBoost,
          onL: () => updateSetting("hdBoost", false),
          onR: () => updateSetting("hdBoost", true)
        }
      ];

      let y = 136;
      rows.forEach((r, i) => {
        drawRoundedRect(48, y, 928, 72, 11, "#1e293b", "#334155", 2);
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 20px system-ui, sans-serif";
        ctx.fillText(r.title, 70, y + 26);
        ctx.fillStyle = i === 5 ? "#fde68a" : "#94a3b8";
        ctx.font = "15px system-ui, sans-serif";
        ctx.fillText(r.sub, 70, y + 51);

        ctx.textAlign = "center";
        ctx.font = "bold 16px system-ui, sans-serif";
        drawRoundedRect(644, y + 12, 148, 48, 10, r.isLeft ? "#2563eb" : "#0f172a", r.isLeft ? "#93c5fd" : "#475569", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(r.lLabel, 718, y + 37);
        addZone(`setL_${i}`, 644, y + 12, 148, 48, r.onL);

        drawRoundedRect(804, y + 12, 148, 48, 10, !r.isLeft ? "#2563eb" : "#0f172a", !r.isLeft ? "#93c5fd" : "#475569", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(r.rLabel, 878, y + 37);
        addZone(`setR_${i}`, 804, y + 12, 148, 48, r.onR);
        y += 80;
      });

      // Row 7: Time of Day (3-way toggle: DAY / SUNSET / NIGHT)
      const tod = settings.timeOfDay || "day";
      drawRoundedRect(48, y, 928, 72, 11, "#1e293b", "#334155", 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px system-ui, sans-serif";
      ctx.fillText("Time of Day (Sky & Lighting)", 70, y + 26);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "15px system-ui, sans-serif";
      ctx.fillText("Daylight, Golden Hour Sunset, or Starry Night", 70, y + 51);

      ctx.textAlign = "center";
      ctx.font = "bold 16px system-ui, sans-serif";
      const tods = [
        { id: "day", label: "DAY" },
        { id: "sunset", label: "SUNSET" },
        { id: "night", label: "NIGHT" }
      ];
      let dx = 568;
      for (const item of tods) {
        drawRoundedRect(dx, y + 12, 122, 48, 10, tod === item.id ? "#2563eb" : "#0f172a", tod === item.id ? "#93c5fd" : "#475569", 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(item.label, dx + 61, y + 37);
        addZone(`set_tod_${item.id}`, dx, y + 12, 122, 48, () => updateSetting("timeOfDay", item.id));
        dx += 132;
      }
      y += 80;

      // Row 7: 5 Local API Key Slots (Manual Switch + Auto-Failover)
      const kst = keyManager ? keyManager.getState() : { slots: ["","","","",""], activeSlot: -1, loadedCount: 0 };
      const hasCustom = kst.activeSlot >= 0 && Boolean(kst.slots[kst.activeSlot]);
      drawRoundedRect(48, y, 928, 106, 12, "#1e293b", hasCustom ? "#4ade80" : "#fbbf24", 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px system-ui, sans-serif";
      ctx.fillText(
        hasCustom
          ? `API Key Slots • Active: Key ${kst.activeSlot + 1} (${kst.loadedCount}/5 saved • Auto-Failover ON)`
          : "API Key Slots • Required (Tap a slot & Paste)",
        68,
        y + 26
      );
      if (vrKeyFeedback) {
        ctx.fillStyle = "#fde68a";
        ctx.font = "15px system-ui, sans-serif";
        ctx.fillText(vrKeyFeedback.slice(0, 74), 68, y + 49);
      }

      ctx.textAlign = "center";
      ctx.font = "bold 17px system-ui, sans-serif";
      for (let s = 0; s < 5; s++) {
        const sx = 68 + s * 116;
        const filled = Boolean(kst.slots[s]);
        const isAct = kst.activeSlot === s && filled;
        const isEd = editingKeySlot === s;
        const bg = isAct ? "#16a34a" : filled ? "#1e3a8a" : "#0f172a";
        const border = isEd ? "#38bdf8" : isAct ? "#86efac" : filled ? "#60a5fa" : "#475569";
        drawRoundedRect(sx, y + 54, 106, 42, 9, bg, border, isEd ? 3 : 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(isAct ? `★ K${s + 1}` : filled ? `K${s + 1} ✓` : `K${s + 1}`, sx + 53, y + 76);
        addZone(`vr_kslot_${s}`, sx, y + 54, 106, 42, () => {
          editingKeySlot = s;
          if (audio) audio.playClick();
          if (keyManager && keyManager.getState().slots[s]) {
            keyManager.selectSlot(s);
            vrKeyFeedback = `Switched to Key ${s + 1}!`;
          } else {
            vrKeyFeedback = `Selected empty Key ${s + 1}. Tap PASTE to save.`;
          }
          renderVRTablet();
        });
      }

      drawRoundedRect(664, y + 54, 166, 42, 9, hoveredHitId === "vr_key_paste" ? "#22c55e" : "#16a34a", "#86efac", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`PASTE -> K${editingKeySlot + 1}`, 747, y + 76);
      addZone("vr_key_paste", 664, y + 54, 166, 42, async () => {
        if (!keyManager) return;
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            const text = ((await navigator.clipboard.readText()) || "").trim();
            if (text && text.length > 10) {
              keyManager.saveSlot(editingKeySlot, text, true);
              if (audio) audio.playPin();
              vrKeyFeedback = `Saved & activated Key ${editingKeySlot + 1}!`;
              renderVRTablet();
              return;
            }
            vrKeyFeedback = "Clipboard is empty — copy your AIza... key first.";
            renderVRTablet();
            return;
          }
        } catch (_) {}
        vrKeyFeedback = "VR browser blocked clipboard — paste in 2D browser Settings.";
        renderVRTablet();
      });

      drawRoundedRect(840, y + 54, 118, 42, 9, hoveredHitId === "vr_key_reset" ? "#dc2626" : "#991b1b", "#fca5a5", 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`CLR K${editingKeySlot + 1}`, 899, y + 76);
      addZone("vr_key_reset", 840, y + 54, 118, 42, () => {
        if (!keyManager) return;
        keyManager.clearSlot(editingKeySlot);
        if (audio) audio.playClick();
        vrKeyFeedback = `Cleared Key ${editingKeySlot + 1}.`;
        renderVRTablet();
      });
    }

    // ---------------- TAB 6: CONTROLS ----------------
    else if (activeTab === "controls") {
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(
        `Galaxy XR Controls (${settings.handedness === "left" ? "Left-Handed" : "Right-Handed"})`,
        48,
        142
      );

      const items = getControlsList();
      let y = 196;
      for (const [btn, desc] of items) {
        drawRoundedRect(48, y - 22, 928, 52, 10, "#1e293b");
        ctx.fillStyle = "#38bdf8";
        ctx.font = "bold 20px system-ui, sans-serif";
        ctx.fillText(btn, 70, y + 5);
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "19px system-ui, sans-serif";
        ctx.fillText(desc, 355, y + 5);
        y += 62;
      }
    }

    texture.needsUpdate = true;
  }

  // =========================================================================
  // 6. Open / Close, VR Positioning & VR Thumbstick Map Controls
  // =========================================================================
  const forwardVec = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  let vrMapZoomCooldown = 0;

  function handleVRMapStick(zoomStickY, panStickX, panStickY, dt) {
    if (!isOpen || activeTab !== "map") return;

    // Off-hand stick Up/Down flick zooms the 2D map
    vrMapZoomCooldown = Math.max(0, vrMapZoomCooldown - dt);
    if (Math.abs(zoomStickY) > 0.55 && vrMapZoomCooldown <= 0) {
      if (lastVrMapCursor) {
        zoomMap(zoomStickY < 0 ? 1 : -1, lastVrMapCursor.bx, lastVrMapCursor.by);
      } else {
        zoomMap(zoomStickY < 0 ? 1 : -1);
      }
      vrMapZoomCooldown = 0.28;
    } else if (Math.abs(zoomStickY) < 0.25) {
      vrMapZoomCooldown = 0;
    }

    // Dominant-hand stick smoothly pans the 2D map
    if (Math.abs(panStickX) > 0.18 || Math.abs(panStickY) > 0.18) {
      panMapByPixels(-panStickX * 420 * dt, -panStickY * 420 * dt);
    }
  }

  function open(tab = null) {
    if (!isOpen && audio) audio.playMenuOpen();
    isOpen = true;
    copyFeedback = "";
    if (tab) activeTab = tab;
    else if (isGeoGuessrActive()) activeTab = "map";

    if (isGeoGuessrActive() && games.session.phase === "playing") {
      mapState.lat = 20;
      mapState.lon = 0;
      mapState.zoom = 2;
    } else if (!isGeoGuessrActive() && getPlayerLocation) {
      const p = getPlayerLocation();
      mapState.lat = p.lat;
      mapState.lon = p.lon;
    }

    if (renderer.xr.isPresenting) {
      const xrCam = renderer.xr.getCamera();
      xrCam.getWorldPosition(camPos);
      xrCam.getWorldDirection(forwardVec);
      forwardVec.y = 0;
      if (forwardVec.lengthSq() < 0.001) forwardVec.set(0, 0, -1);
      forwardVec.normalize();

      tabletMesh.position.copy(camPos).addScaledVector(forwardVec, 1.25);
      tabletMesh.position.y = Math.max(0.85, camPos.y - 0.05);
      tabletMesh.lookAt(camPos.x, tabletMesh.position.y, camPos.z);
      tabletMesh.visible = true;
      renderVRTablet();
      if (activeTab === "map") renderInteractiveMap();
    } else if (modalEl) {
      modalEl.classList.remove("hidden");
      renderDesktopUI();
      if (activeTab === "map") renderInteractiveMap();
      if (activeTab === "search" && inputEl) {
        inputEl.value = queryText;
        inputEl.focus();
      }
    }
  }

  function close() {
    if (isOpen && audio) audio.playMenuClose();
    isOpen = false;
    tabletMesh.visible = false;
    cursorDotMesh.visible = false;
    hoverHighlightMesh.visible = false;
    hoveredHitId = null;
    vrMapDragging = false;
    mapPanRafScheduled = false;
    if (modalEl) modalEl.classList.add("hidden");
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  // =========================================================================
  // 7. VR Laser Raycasting
  // =========================================================================
  const raycaster = new THREE.Raycaster();
  const tempMatrix = new THREE.Matrix4();
  let vrMapDragging = false;
  let vrMapStartX = 0, vrMapStartY = 0, vrMapLastX = 0, vrMapLastY = 0;

  function getTabletHit(controller) {
    if (!isOpen || !tabletMesh.visible || !controller) return null;
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const hits = raycaster.intersectObject(tabletMesh, false);
    if (hits.length === 0 || !hits[0].uv) return null;
    return {
      px: hits[0].uv.x * W,
      py: (1 - hits[0].uv.y) * H,
      point: hits[0].point
    };
  }

  function getTabletUVPixels(controller) {
    const hit = getTabletHit(controller);
    return hit ? { px: hit.px, py: hit.py } : null;
  }

  function findZoneAt(px, py) {
    for (let i = hitZones.length - 1; i >= 0; i--) {
      const z = hitZones[i];
      if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) return z;
    }
    return null;
  }

  function isInsideMapRect(px, py) {
    return (
      activeTab === "map" &&
      px >= MAP_RECT.x &&
      px <= MAP_RECT.x + MAP_RECT.w &&
      py >= MAP_RECT.y &&
      py <= MAP_RECT.y + MAP_RECT.h
    );
  }

  function updateHover(domController) {
    if (!isOpen || !tabletMesh.visible) {
      cursorDotMesh.visible = false;
      return;
    }
    const hit = getTabletHit(domController);
    if (hit) {
      cursorDotMesh.position.copy(hit.point);
      cursorDotMesh.quaternion.copy(tabletMesh.quaternion);
      cursorDotMesh.visible = true;
    } else {
      cursorDotMesh.visible = false;
    }
    const pt = hit ? { px: hit.px, py: hit.py } : null;
    if (pt && isInsideMapRect(pt.px, pt.py)) {
      lastVrMapCursor = {
        bx: ((pt.px - MAP_RECT.x) / MAP_RECT.w) * mapBufferCanvas.width,
        by: ((pt.py - MAP_RECT.y) / MAP_RECT.h) * mapBufferCanvas.height
      };
    } else {
      lastVrMapCursor = null;
    }

    if (vrMapDragging && pt) {
      const dx = pt.px - vrMapLastX;
      const dy = pt.py - vrMapLastY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        panMapByPixels(dx, dy);
        vrMapLastX = pt.px;
        vrMapLastY = pt.py;
      }
      return;
    }

    const zone = pt ? findZoneAt(pt.px, pt.py) : null;
    const newId = zone ? zone.id : null;
    if (newId !== hoveredHitId) {
      hoveredHitId = newId;
      if (zone) {
        const cx = ((zone.x + zone.w / 2) / W - 0.5) * 1.18;
        const cy = (0.5 - (zone.y + zone.h / 2) / H) * 0.96;
        hoverHighlightMesh.position.set(cx, cy, 0.001);
        hoverHighlightMesh.scale.set((zone.w / W) * 1.18, (zone.h / H) * 0.96, 1);
        hoverHighlightMesh.visible = true;
      } else {
        hoverHighlightMesh.visible = false;
      }
    }
  }

  function handleVRPointerDown(controller) {
    if (!isOpen || !tabletMesh.visible) return false;
    const pt = getTabletUVPixels(controller);
    if (!pt) return false;

    const zone = findZoneAt(pt.px, pt.py);
    if (zone && zone.onClick) {
      zone.onClick();
      return true;
    }

    if (isInsideMapRect(pt.px, pt.py)) {
      vrMapDragging = true;
      vrMapStartX = vrMapLastX = pt.px;
      vrMapStartY = vrMapLastY = pt.py;
      return true;
    }
    return false;
  }

  function handleVRPointerUp(controller) {
    if (!vrMapDragging) return;
    vrMapDragging = false;
    const pt = getTabletUVPixels(controller);
    if (
      pt &&
      Math.hypot(pt.px - vrMapStartX, pt.py - vrMapStartY) < 16 &&
      isInsideMapRect(pt.px, pt.py)
    ) {
      selectMapPointAtCanvasXY(
        pt.px - MAP_RECT.x,
        pt.py - MAP_RECT.y,
        MAP_RECT.w,
        MAP_RECT.h
      );
    }
  }

  function handleVRMapPinDrop(controller) {
    if (!isOpen || !tabletMesh.visible || activeTab !== "map") return false;
    const pt = getTabletUVPixels(controller);
    if (!pt || !isInsideMapRect(pt.px, pt.py)) return false;
    if (findZoneAt(pt.px, pt.py)) return false;
    selectMapPointAtCanvasXY(
      pt.px - MAP_RECT.x,
      pt.py - MAP_RECT.y,
      MAP_RECT.w,
      MAP_RECT.h
    );
    return true;
  }

  renderVRTablet();

  return {
    isOpen: () => isOpen,
    addBookmark,
    open,
    close,
    toggle,
    refreshUI: () => { if (renderer.xr.isPresenting) renderVRTablet(); else renderDesktopUI(); },
    handleVRMapStick,
    updateHover,
    handleVRPointerDown,
    handleVRPointerUp,
    handleVRMapPinDrop
  };
}
