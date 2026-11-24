import * as THREE from "three";

const TILE_BASE = "https://tile.googleapis.com/v1";
const EARTH_R = 6371000;

function latLonDistMeters(lat1, lon1, lat2, lon2) {
  const dLat = THREE.MathUtils.degToRad(lat2 - lat1);
  const dLon = THREE.MathUtils.degToRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(THREE.MathUtils.degToRad(lat1)) *
      Math.cos(THREE.MathUtils.degToRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function latLonBearingDeg(lat1, lon1, lat2, lon2) {
  const f1 = THREE.MathUtils.degToRad(lat1);
  const f2 = THREE.MathUtils.degToRad(lat2);
  const dl = THREE.MathUtils.degToRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (THREE.MathUtils.radToDeg(Math.atan2(y, x)) + 360) % 360;
}

function offsetLatLon(lat, lon, distMeters, bearingDeg) {
  const brg = THREE.MathUtils.degToRad(bearingDeg);
  const dLat = (distMeters * Math.cos(brg)) / EARTH_R;
  const cosLat = Math.max(0.15, Math.cos(THREE.MathUtils.degToRad(lat)));
  const dLon = (distMeters * Math.sin(brg)) / (EARTH_R * cosLat);
  return {
    lat: THREE.MathUtils.clamp(lat + THREE.MathUtils.radToDeg(dLat), -85, 85),
    lon: ((lon + THREE.MathUtils.radToDeg(dLon) + 540) % 360) - 180
  };
}

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

export function createStreetViewSystem({
  apiKey,
  streetViewEnabled = false,
  scene,
  camera,
  renderer,
  audio,
  onEnterStreetView,
  onExitStreetView,
  onLocationChange,
  onFlyTo,
  onBookmarkSpot,
  onFeelingLucky,
  onQuotaExceeded
}) {
  let activeApiKey = apiKey;
  let svEnabled = streetViewEnabled;
  let map2DSession = null;
  let svSession = null;
  let isInStreetView = false;
  let wristMapVisible = true;
  let minimapForceHidden = false;
  let movementLocked = false;
  let currentPano = null;
  let nearestPano = null;
  let isCheckingPano = false;
  let lastLookupLat = null;
  let lastLookupLon = null;
  let lastMapRenderLat = null;
  let lastMapRenderLon = null;
  let lastMapRenderZoom = null;
  let lastSvConeHeading = 0;
  let svQuotaExceeded = false;
  const panoCache = new Map();

  // Live player state cache + Interactive Wrist Minimap state
  const livePlayer = { lat: 38.8339, lon: -104.8214, heading: 0, altitude: 8500000 };
  const wristMapState = { lat: 38.8339, lon: -104.8214, zoom: 12 };
  let wristManualMode = false;
  let wristPinnedPlace = null; // { lat, lon }
  let wristDragging = false;
  let wristDragLastPx = { x: 0, y: 0 };
  let hoveredWristControl = null; // "zin" | "zout" | "fly" | "sv" | "center" | "save" | "lucky" | "map" | null
  let saveFlashUntil = 0;
  let noPanoFlashUntil = 0;
  let lastCompassDeg = -999;
  let lastCompassTime = 0;

  async function initSessions() {
    if (!activeApiKey || activeApiKey === "PASTE_YOUR_API_KEY_HERE") return;
    try {
      const reqs = [
        fetch(`${TILE_BASE}/createSession?key=${activeApiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mapType: "roadmap",
            language: "en-US",
            region: "US",
            scale: "scaleFactor2x",
            highDpi: true,
            layerTypes: ["layerStreetview"]
          })
        })
      ];
      if (svEnabled) {
        reqs.push(
          fetch(`${TILE_BASE}/createSession?key=${activeApiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mapType: "streetview",
              language: "en-US",
              region: "US"
            })
          })
        );
      }

      const [res2d, resSv] = await Promise.all(reqs);

      if (res2d && res2d.ok) {
        const d2 = await res2d.json();
        map2DSession = d2.session;
      }
      if (resSv) {
        if (resSv.ok) {
          const dSv = await resSv.json();
          svSession = dSv.session;
        } else if (resSv.status === 429) {
          svQuotaExceeded = true;
        }
      }
    } catch (err) {
      console.warn("Map Tiles session init failed:", err);
    }
  }
  let failoverPromise = null;
  async function handleSvQuotaHit() {
    if (failoverPromise) return failoverPromise;
    if (onQuotaExceeded) {
      const nextKey = onQuotaExceeded();
      if (nextKey) {
        failoverPromise = (async () => {
          activeApiKey = nextKey;
          svEnabled = true;
          svQuotaExceeded = false;
          svSession = null;
          map2DSession = null;
          tileImgCache.clear();
          await initSessions();
          drawWristButtons();
          return true;
        })().finally(() => {
          failoverPromise = null;
        });
        return failoverPromise;
      }
    }
    svQuotaExceeded = true;
    drawWristButtons();
    return false;
  }

  async function switchApiKey(newKey, enabled = true) {
    activeApiKey = newKey;
    svEnabled = enabled;
    svQuotaExceeded = false;
    svSession = null;
    map2DSession = null;
    tileImgCache.clear();
    await initSessions();
    drawWristButtons();
  }

  initSessions();

  const MAP_SIZE = 1024;
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = MAP_SIZE;
  mapCanvas.height = MAP_SIZE;
  const mapCtx = mapCanvas.getContext("2d");

  const mapTexture = new THREE.CanvasTexture(mapCanvas);
  mapTexture.colorSpace = THREE.SRGBColorSpace;
  mapTexture.minFilter = THREE.LinearFilter;
  mapTexture.magFilter = THREE.LinearFilter;
  mapTexture.generateMipmaps = false;
  mapTexture.anisotropy = renderer
    ? Math.min(8, renderer.capabilities.getMaxAnisotropy())
    : 4;

  const desktopMinimapEl = document.getElementById("desktop-minimap");
  const desktopCanvas = document.getElementById("minimap-canvas");
  const desktopCtx = desktopCanvas ? desktopCanvas.getContext("2d") : null;
  const desktopBtn = document.getElementById("sv-toggle-btn");
  const desktopInfo = document.getElementById("sv-status-text");

  const btnCanvas = document.createElement("canvas");
  btnCanvas.width = 1024;
  btnCanvas.height = 384;
  const btnCtx = btnCanvas.getContext("2d");
  const btnTexture = new THREE.CanvasTexture(btnCanvas);
  btnTexture.colorSpace = THREE.SRGBColorSpace;
  btnTexture.minFilter = THREE.LinearFilter;

  // Wrist-Only Compass Strip (tucked at top of wrist tablet; hidden whenever wrist map is off)
  const compassCanvas = document.createElement("canvas");
  compassCanvas.width = 1024;
  compassCanvas.height = 128;
  const compassCtx = compassCanvas.getContext("2d");
  const compassTexture = new THREE.CanvasTexture(compassCanvas);
  compassTexture.colorSpace = THREE.SRGBColorSpace;
  compassTexture.minFilter = THREE.LinearFilter;

  function drawWristCompass(headingRad, force = false) {
    if (!force && renderer && renderer.xr.isPresenting && !wristGroup.visible) return;
    const now = performance.now();
    if (!force && now - lastCompassTime < 55) return;
    const deg = ((Math.round(THREE.MathUtils.radToDeg(headingRad)) % 360) + 360) % 360;
    if (!force && Math.abs(deg - lastCompassDeg) < 1) return;
    lastCompassDeg = deg;
    lastCompassTime = now;

    const W = 1024;
    const H = 128;
    compassCtx.clearRect(0, 0, W, H);
    compassCtx.fillStyle = "rgba(15, 23, 42, 0.96)";
    compassCtx.strokeStyle = "#38bdf8";
    compassCtx.lineWidth = 5;
    compassCtx.beginPath();
    compassCtx.roundRect(6, 6, W - 12, H - 12, 22);
    compassCtx.fill();
    compassCtx.stroke();

    // Scrolling cardinal / intercardinal strip centered on current heading
    const labels = [
      [0, "N"], [45, "NE"], [90, "E"], [135, "SE"],
      [180, "S"], [225, "SW"], [270, "W"], [315, "NW"]
    ];
    const pxPerDeg = 4.6;
    compassCtx.save();
    compassCtx.beginPath();
    compassCtx.rect(24, 12, W - 260, H - 24);
    compassCtx.clip();

    const stripCenterX = (W - 236) / 2;
    for (const [d, txt] of labels) {
      let diff = ((d - deg + 540) % 360) - 180;
      const x = stripCenterX + diff * pxPerDeg;
      if (x < -40 || x > W - 200) continue;
      const isNorth = d === 0;
      compassCtx.fillStyle = isNorth ? "#f87171" : txt.length === 1 ? "#f8fafc" : "#94a3b8";
      compassCtx.font = isNorth
        ? "bold 50px system-ui, sans-serif"
        : txt.length === 1
        ? "bold 44px system-ui, sans-serif"
        : "bold 34px system-ui, sans-serif";
      compassCtx.textAlign = "center";
      compassCtx.textBaseline = "middle";
      compassCtx.fillText(txt, x, H / 2 + 6);
    }

    // Center pointer caret
    compassCtx.fillStyle = "#38bdf8";
    compassCtx.beginPath();
    compassCtx.moveTo(stripCenterX, 26);
    compassCtx.lineTo(stripCenterX - 13, 10);
    compassCtx.lineTo(stripCenterX + 13, 10);
    compassCtx.closePath();
    compassCtx.fill();
    compassCtx.restore();

    // Right-side digital heading readout (e.g. "NW 312°")
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const dirName = dirs[Math.round(deg / 45) % 8];
    compassCtx.fillStyle = "rgba(30, 41, 59, 0.95)";
    compassCtx.beginPath();
    compassCtx.roundRect(W - 224, 18, 206, H - 36, 16);
    compassCtx.fill();

    compassCtx.fillStyle = "#38bdf8";
    compassCtx.font = "bold 42px system-ui, sans-serif";
    compassCtx.textAlign = "center";
    compassCtx.textBaseline = "middle";
    compassCtx.fillText(`${dirName} ${deg}°`, W - 121, H / 2 + 2);

    compassTexture.needsUpdate = true;
  }

  // Wrist map overlay zoom button bounds (in 1024x1024 mapCanvas pixels)
  const ZIN_BOX = { x: 892, y: 24, w: 108, h: 108 };
  const ZOUT_BOX = { x: 892, y: 148, w: 108, h: 108 };

  function drawWristButtons() {
    btnCtx.clearRect(0, 0, 1024, 384);

    // --- ROW 1 (y: 12..184): FLY | STREET/PIN SV/EXIT 3D | CENTER ---
    const canFly = Boolean(wristPinnedPlace);
    const flyBg = canFly
      ? hoveredWristControl === "fly"
        ? "#3b82f6"
        : "#2563eb"
      : "#334155";
    const flyBorder = canFly ? "#93c5fd" : "#475569";

    btnCtx.fillStyle = flyBg;
    btnCtx.strokeStyle = flyBorder;
    btnCtx.lineWidth = 7;
    btnCtx.beginPath();
    btnCtx.roundRect(8, 12, 304, 172, 26);
    btnCtx.fill();
    btnCtx.stroke();

    btnCtx.fillStyle = canFly ? "#ffffff" : "#94a3b8";
    btnCtx.font = 'bold 52px system-ui, -apple-system, "Segoe UI", sans-serif';
    btnCtx.textAlign = "center";
    btnCtx.textBaseline = "middle";
    btnCtx.fillText("FLY", 160, 100);

    let svBg = "#334155";
    let svBorder = "#475569";
    let svLabel = "NO SV";
    let desktopLabel = "NO STREET VIEW NEARBY";

    const isFlashingNoPano = performance.now() < noPanoFlashUntil;
    if (!svEnabled) {
      svBg = "#334155";
      svBorder = "#fbbf24";
      svLabel = "ADD KEY";
      desktopLabel = "ADD API KEY IN SETTINGS";
    } else if (isFlashingNoPano) {
      svBg = "#9a3412";
      svBorder = "#fdba74";
      svLabel = "NO PANO";
      desktopLabel = "NO 360° PANO AT PIN";
    } else if (svQuotaExceeded && !isInStreetView) {
      svBg = "#7c2d12";
      svBorder = "#fb923c";
      svLabel = "SV LIMIT";
      desktopLabel = "DAILY SV LIMIT REACHED";
    } else if (wristPinnedPlace && !svQuotaExceeded) {
      svBg = hoveredWristControl === "sv" ? "#22c55e" : "#16a34a";
      svBorder = "#86efac";
      svLabel = "PIN SV";
      desktopLabel = isInStreetView ? "EXIT TO 3D EARTH" : "ENTER STREET VIEW";
    } else if (isInStreetView) {
      svBg = hoveredWristControl === "sv" ? "#dc2626" : "#b91c1c";
      svBorder = "#fca5a5";
      svLabel = "EXIT 3D";
      desktopLabel = "EXIT TO 3D EARTH";
    } else if (nearestPano) {
      svBg = hoveredWristControl === "sv" ? "#22c55e" : "#15803d";
      svBorder = "#86efac";
      svLabel = "STREET";
      desktopLabel = "ENTER STREET VIEW";
    } else if (isCheckingPano) {
      svBg = "#1e3a8a";
      svBorder = "#60a5fa";
      svLabel = "...";
      desktopLabel = "SEARCHING ROADS...";
    }

    btnCtx.fillStyle = svBg;
    btnCtx.strokeStyle = svBorder;
    btnCtx.lineWidth = 7;
    btnCtx.beginPath();
    btnCtx.roundRect(326, 12, 404, 172, 26);
    btnCtx.fill();
    btnCtx.stroke();

    btnCtx.fillStyle =
      isInStreetView || wristPinnedPlace || nearestPano || isCheckingPano
        ? "#ffffff"
        : "#94a3b8";
    btnCtx.font = 'bold 52px system-ui, -apple-system, "Segoe UI", sans-serif';
    btnCtx.fillText(svLabel, 528, 100);

    const isOffset = wristManualMode || Boolean(wristPinnedPlace);
    const cenBg = isOffset
      ? hoveredWristControl === "center"
        ? "#38bdf8"
        : "#0284c7"
      : hoveredWristControl === "center"
      ? "#334155"
      : "#1e293b";
    const cenBorder = isOffset ? "#bae6fd" : "#475569";

    btnCtx.fillStyle = cenBg;
    btnCtx.strokeStyle = cenBorder;
    btnCtx.lineWidth = 7;
    btnCtx.beginPath();
    btnCtx.roundRect(744, 12, 272, 172, 26);
    btnCtx.fill();
    btnCtx.stroke();

    btnCtx.fillStyle = isOffset ? "#ffffff" : "#cbd5e1";
    btnCtx.font = 'bold 44px system-ui, -apple-system, "Segoe UI", sans-serif';
    btnCtx.fillText("CENTER", 880, 100);

    // --- ROW 2 (y: 200..372): ★ SAVE | 🎲 LUCKY ---
    const isFlashingSave = performance.now() < saveFlashUntil;
    const saveBg = isFlashingSave
      ? "#16a34a"
      : hoveredWristControl === "save"
      ? "#f59e0b"
      : "#d97706";
    const saveBorder = isFlashingSave ? "#86efac" : "#fcd34d";

    btnCtx.fillStyle = saveBg;
    btnCtx.strokeStyle = saveBorder;
    btnCtx.lineWidth = 7;
    btnCtx.beginPath();
    btnCtx.roundRect(8, 200, 496, 172, 26);
    btnCtx.fill();
    btnCtx.stroke();

    btnCtx.fillStyle = "#ffffff";
    btnCtx.font = 'bold 48px system-ui, -apple-system, "Segoe UI", sans-serif';
    btnCtx.fillText(isFlashingSave ? "★ SAVED!" : "★ SAVE SPOT", 256, 288);

    const luckyBg = hoveredWristControl === "lucky" ? "#8b5cf6" : "#7c3aed";
    btnCtx.fillStyle = luckyBg;
    btnCtx.strokeStyle = "#c4b5fd";
    btnCtx.lineWidth = 7;
    btnCtx.beginPath();
    btnCtx.roundRect(520, 200, 496, 172, 26);
    btnCtx.fill();
    btnCtx.stroke();

    btnCtx.fillStyle = "#ffffff";
    btnCtx.font = 'bold 48px system-ui, -apple-system, "Segoe UI", sans-serif';
    btnCtx.fillText("🎲 LUCKY", 768, 288);

    btnTexture.needsUpdate = true;

    // Sync Desktop sidebar button
    if (desktopBtn) {
      desktopBtn.textContent = desktopLabel;
      desktopBtn.disabled = !isInStreetView && !nearestPano;
      desktopBtn.className = isInStreetView
        ? "sv-btn exit"
        : nearestPano
        ? "sv-btn ready"
        : "sv-btn disabled";
    }
    if (desktopInfo) {
      if (!svEnabled) {
        desktopInfo.textContent = "Add your Google Maps API key in Settings for Street View";
      } else if (isInStreetView && currentPano) {
        desktopInfo.textContent = `Street View • ${currentPano.date || "360°"}`;
      } else if (svQuotaExceeded) {
        desktopInfo.textContent = "Daily Street View limit reached (resets midnight PT)";
      } else if (nearestPano) {
        desktopInfo.textContent = "Nearest Street View Found";
      } else {
        desktopInfo.textContent = "Zoom closer to a road for Street View";
      }
    }
  }

  // VR Wrist Minimap Tablet Mesh
  const wristGroup = new THREE.Group();
  wristGroup.position.set(0.02, 0.095, -0.04);
  wristGroup.rotation.set(-0.52, 0.15, 0);

  const frameMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.43),
    new THREE.MeshBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide
    })
  );
  frameMesh.position.set(0, -0.005, -0.002);
  wristGroup.add(frameMesh);

  const compassMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.033),
    new THREE.MeshBasicMaterial({ map: compassTexture, transparent: true })
  );
  compassMesh.position.set(0, 0.184, 0.001);
  wristGroup.add(compassMesh);

  const mapMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.26),
    new THREE.MeshBasicMaterial({ map: mapTexture })
  );
  mapMesh.position.set(0, 0.032, 0);
  wristGroup.add(mapMesh);

  // Lightweight 3D heading cone + blue player dot (rotates at 0ms without re-uploading 1024x1024 map)
  const wristConeGroup = new THREE.Group();
  wristConeGroup.position.set(0, 0.032, 0.0015);
  const coneShape = new THREE.Shape();
  coneShape.moveTo(0, 0);
  coneShape.absarc(0, 0, 0.021, Math.PI / 2 - 0.45, Math.PI / 2 + 0.45, false);
  coneShape.closePath();
  const wristConeSector = new THREE.Mesh(
    new THREE.ShapeGeometry(coneShape, 12),
    new THREE.MeshBasicMaterial({
      color: 0x2563eb,
      transparent: true,
      opacity: 0.42,
      depthWrite: false
    })
  );
  wristConeGroup.add(wristConeSector);

  const wristDotBorder = new THREE.Mesh(
    new THREE.CircleGeometry(0.0052, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false })
  );
  wristDotBorder.position.z = 0.0002;
  wristConeGroup.add(wristDotBorder);

  const wristDotCore = new THREE.Mesh(
    new THREE.CircleGeometry(0.0038, 16),
    new THREE.MeshBasicMaterial({ color: 0x2563eb, depthWrite: false })
  );
  wristDotCore.position.z = 0.0004;
  wristConeGroup.add(wristDotCore);
  wristGroup.add(wristConeGroup);

  const wristButtonMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.098),
    new THREE.MeshBasicMaterial({ map: btnTexture, transparent: true })
  );
  wristButtonMesh.position.set(0, -0.156, 0.001);
  wristButtonMesh.userData.isWristButton = true;
  wristGroup.add(wristButtonMesh);

  // Miniature high-contrast laser cursor dot for the wrist minimap
  const wristCursorDot = new THREE.Group();
  const wOuter = new THREE.Mesh(
    new THREE.CircleGeometry(0.0065, 20),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    })
  );
  wOuter.renderOrder = 111;
  wristCursorDot.add(wOuter);

  const wRing = new THREE.Mesh(
    new THREE.CircleGeometry(0.005, 20),
    new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      depthWrite: false
    })
  );
  wRing.renderOrder = 112;
  wristCursorDot.add(wRing);

  const wCore = new THREE.Mesh(
    new THREE.CircleGeometry(0.0028, 16),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      depthWrite: false
    })
  );
  wCore.renderOrder = 113;
  wristCursorDot.add(wCore);

  wristCursorDot.visible = false;
  scene.add(wristCursorDot);

  drawWristButtons();
  drawWristCompass(0, true);

  mapCtx.fillStyle = "#0f172a";
  mapCtx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
  mapCtx.fillStyle = "#94a3b8";
  mapCtx.font = "bold 42px system-ui, sans-serif";
  mapCtx.textAlign = "center";
  mapCtx.fillText("Loading HD Map...", MAP_SIZE / 2, MAP_SIZE / 2);
  mapTexture.needsUpdate = true;

  const tileImgCache = new Map();

  function load2DTile(z, x, y) {
    if (!map2DSession) return Promise.resolve(null);
    const key = `${z}/${x}/${y}`;
    if (tileImgCache.has(key)) return tileImgCache.get(key);

    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `${TILE_BASE}/2dtiles/${z}/${x}/${y}?session=${map2DSession}&key=${activeApiKey}`;
    });
    tileImgCache.set(key, p);
    if (tileImgCache.size > 160) {
      const firstKey = tileImgCache.keys().next().value;
      tileImgCache.delete(firstKey);
    }
    return p;
  }

  let mapRenderToken = 0;

  async function renderMinimap(lat, lon, headingRad, altitude, forceRender = false) {
    if (!map2DSession || minimapForceHidden) return;
    // Perf: skip 1024x1024 redraws when wrist map is hidden in VR
    if (!forceRender && renderer && renderer.xr.isPresenting && !wristMapVisible) return;

    const token = ++mapRenderToken;

    const autoZoom = isInStreetView
      ? 17
      : Math.round(
          THREE.MathUtils.clamp(
            18 - Math.log2(Math.max(altitude, 80) / 140),
            4,
            16
          )
        );

    if (!wristManualMode) {
      wristMapState.lat = lat;
      wristMapState.lon = lon;
      wristMapState.zoom = autoZoom;
    }

    const viewLat = wristMapState.lat;
    const viewLon = wristMapState.lon;
    const zoom = wristMapState.zoom;

    const center = latLonToTileXY(viewLat, viewLon, zoom);
    const tileX = Math.floor(center.x);
    const tileY = Math.floor(center.y);
    const fracX = center.x - tileX;
    const fracY = center.y - tileY;

    const maxTile = Math.pow(2, zoom);
    const promises = [];

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tx = ((tileX + dx) % maxTile + maxTile) % maxTile;
        const ty = tileY + dy;
        if (ty < 0 || ty >= maxTile) continue;
        promises.push(
          load2DTile(zoom, tx, ty).then((img) => ({ img, dx, dy }))
        );
      }
    }

    const loaded = await Promise.all(promises);
    if (token !== mapRenderToken) return;

    mapCtx.fillStyle = "#0f172a";
    mapCtx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    const half = MAP_SIZE / 2;
    const tileSize = 512;
    const originX = half - fracX * tileSize;
    const originY = half - fracY * tileSize;

    for (const item of loaded) {
      if (item.img) {
        mapCtx.drawImage(
          item.img,
          originX + item.dx * tileSize,
          originY + item.dy * tileSize,
          tileSize,
          tileSize
        );
      }
    }

    // Green dot for nearest Street View panorama
    if (nearestPano && !isInStreetView) {
      const pTile = latLonToTileXY(nearestPano.lat, nearestPano.lng, zoom);
      const px = half + (pTile.x - center.x) * tileSize;
      const py = half + (pTile.y - center.y) * tileSize;

      if (px >= -40 && px <= MAP_SIZE + 40 && py >= -40 && py <= MAP_SIZE + 40) {
        mapCtx.beginPath();
        mapCtx.arc(px, py, 20, 0, Math.PI * 2);
        mapCtx.fillStyle = "#22c55e";
        mapCtx.fill();
        mapCtx.lineWidth = 6;
        mapCtx.strokeStyle = "#ffffff";
        mapCtx.stroke();
      }
    }

    // Blue dot + heading cone: 3D mesh in VR (0ms head-turn), 2D canvas on desktop
    const inVR = Boolean(renderer && renderer.xr.isPresenting);
    const playerTile = latLonToTileXY(lat, lon, zoom);
    const plX = half + (playerTile.x - center.x) * tileSize;
    const plY = half + (playerTile.y - center.y) * tileSize;
    if (inVR) {
      const inBounds = plX >= 16 && plX <= MAP_SIZE - 16 && plY >= 16 && plY <= MAP_SIZE - 16;
      wristConeGroup.visible = inBounds;
      if (inBounds) {
        wristConeGroup.position.set(
          (plX / MAP_SIZE - 0.5) * 0.26,
          0.032 + (0.5 - plY / MAP_SIZE) * 0.26,
          0.0015
        );
        wristConeGroup.rotation.z = -headingRad;
      }
    } else if (plX >= -90 && plX <= MAP_SIZE + 90 && plY >= -90 && plY <= MAP_SIZE + 90) {
      mapCtx.save();
      mapCtx.translate(plX, plY);
      mapCtx.rotate(headingRad);

      mapCtx.beginPath();
      mapCtx.moveTo(0, 0);
      mapCtx.arc(0, 0, 82, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45);
      mapCtx.closePath();
      mapCtx.fillStyle = "rgba(37, 99, 235, 0.36)";
      mapCtx.fill();

      mapCtx.beginPath();
      mapCtx.arc(0, 0, 16, 0, Math.PI * 2);
      mapCtx.fillStyle = "#2563eb";
      mapCtx.fill();
      mapCtx.lineWidth = 5;
      mapCtx.strokeStyle = "#ffffff";
      mapCtx.stroke();
      mapCtx.restore();
    }

    // Red dropped pin on wrist map (when user drops a pin with A/X)
    if (wristPinnedPlace) {
      const pinTile = latLonToTileXY(wristPinnedPlace.lat, wristPinnedPlace.lon, zoom);
      const rx = half + (pinTile.x - center.x) * tileSize;
      const ry = half + (pinTile.y - center.y) * tileSize;
      if (rx >= -40 && rx <= MAP_SIZE + 40 && ry >= -40 && ry <= MAP_SIZE + 40) {
        mapCtx.beginPath();
        mapCtx.arc(rx, ry, 24, 0, Math.PI * 2);
        mapCtx.fillStyle = "#ef4444";
        mapCtx.fill();
        mapCtx.lineWidth = 7;
        mapCtx.strokeStyle = "#ffffff";
        mapCtx.stroke();
      }
    }

    // Copy clean map to desktop sidebar (skipped while presenting in VR)
    if (!inVR && desktopCtx && desktopCanvas) {
      desktopCtx.imageSmoothingEnabled = true;
      desktopCtx.imageSmoothingQuality = "high";
      desktopCtx.drawImage(
        mapCanvas,
        0,
        0,
        desktopCanvas.width,
        desktopCanvas.height
      );
    }

    // VR Wrist +/- Zoom Overlay Buttons (top-right corner)
    if (renderer && renderer.xr.isPresenting) {
      const drawZoomBtn = (box, sym, isHov) => {
        mapCtx.fillStyle = isHov ? "#2563eb" : "rgba(15, 23, 42, 0.88)";
        mapCtx.strokeStyle = isHov ? "#93c5fd" : "#94a3b8";
        mapCtx.lineWidth = 6;
        mapCtx.beginPath();
        mapCtx.roundRect(box.x, box.y, box.w, box.h, 22);
        mapCtx.fill();
        mapCtx.stroke();

        mapCtx.fillStyle = "#ffffff";
        mapCtx.font = "bold 74px system-ui, sans-serif";
        mapCtx.textAlign = "center";
        mapCtx.textBaseline = "middle";
        mapCtx.fillText(sym, box.x + box.w / 2, box.y + box.h / 2 + 4);
      };
      drawZoomBtn(ZIN_BOX, "+", hoveredWristControl === "zin");
      drawZoomBtn(ZOUT_BOX, "−", hoveredWristControl === "zout");
    }

    mapTexture.needsUpdate = true;
  }

  function redrawWristNow() {
    renderMinimap(
      livePlayer.lat,
      livePlayer.lon,
      isInStreetView ? lastSvConeHeading : livePlayer.heading,
      isInStreetView ? 50 : livePlayer.altitude,
      true
    );
  }

  function panWristMapByPixels(dxPx, dyPx) {
    const tileSize = 512;
    const center = latLonToTileXY(wristMapState.lat, wristMapState.lon, wristMapState.zoom);
    const next = tileXYToLatLon(
      center.x - dxPx / tileSize,
      center.y - dyPx / tileSize,
      wristMapState.zoom
    );
    wristMapState.lat = next.lat;
    wristMapState.lon = next.lon;
    wristManualMode = true;
    drawWristButtons();
    redrawWristNow();
  }

  function zoomWristMap(delta) {
    const prev = wristMapState.zoom;
    wristMapState.zoom = THREE.MathUtils.clamp(wristMapState.zoom + delta, 2, 18);
    if (wristMapState.zoom !== prev && audio) audio.playZoom(delta > 0);
    wristManualMode = true;
    drawWristButtons();
    redrawWristNow();
  }

  function recenterWristMap() {
    wristManualMode = false;
    wristPinnedPlace = null;
    drawWristButtons();
    redrawWristNow();
  }

  let wristStickZoomCooldown = 0;
  function handleVRWristStick(stickY, dt) {
    wristStickZoomCooldown = Math.max(0, wristStickZoomCooldown - dt);
    if (Math.abs(stickY) > 0.45 && wristStickZoomCooldown <= 0) {
      zoomWristMap(stickY < 0 ? 1 : -1);
      wristStickZoomCooldown = 0.26;
    } else if (Math.abs(stickY) < 0.2) {
      wristStickZoomCooldown = 0;
    }
  }

  async function findNearestPano(lat, lon, radius = 200) {
    if (!svEnabled || svQuotaExceeded || !svSession) return null;
    try {
      const res = await fetch(
        `${TILE_BASE}/streetview/panoIds?session=${svSession}&key=${activeApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locations: [{ lat, lng: lon }], radius })
        }
      );
      if (res.status === 429) {
        const switched = await handleSvQuotaHit();
        if (switched) return findNearestPano(lat, lon, radius);
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const panoId = data.panoIds?.[0];
      if (!svEnabled || !panoId) return null;

      const metaRes = await fetch(
        `${TILE_BASE}/streetview/metadata?session=${svSession}&key=${activeApiKey}&panoId=${encodeURIComponent(
          panoId
        )}`
      );
      if (metaRes.status === 429) {
        const switched = await handleSvQuotaHit();
        if (switched) return findNearestPano(lat, lon, radius);
        return null;
      }
      if (!metaRes.ok) return null;
      const meta = await metaRes.json();
      return {
        panoId,
        lat: meta.lat,
        lng: meta.lng,
        heading: meta.heading || 0,
        date: meta.date || "",
        copyright: meta.copyright || "",
        imageryType: meta.imageryType || "",
        links: meta.links || [],
        imageWidth: meta.imageWidth || 8192,
        imageHeight: meta.imageHeight || 4096,
        tileWidth: meta.tileWidth || 512,
        tileHeight: meta.tileHeight || 512
      };
    } catch (err) {
      console.warn("Street View lookup error:", err);
      return null;
    }
  }

  async function checkNearestStreetView(lat, lon) {
    if (!svSession || svQuotaExceeded || isCheckingPano || isInStreetView || minimapForceHidden) return;
    isCheckingPano = true;
    drawWristButtons();
    nearestPano = await findNearestPano(lat, lon, 200);
    isCheckingPano = false;
    drawWristButtons();
  }

  // 360° VR Street View Sphere + Ground Navigation Arrows
  const panoGroup = new THREE.Group();
  panoGroup.visible = false;
  scene.add(panoGroup);

  const panoCanvas = document.createElement("canvas");
  panoCanvas.width = 4096;
  panoCanvas.height = 2048;
  const panoCtx = panoCanvas.getContext("2d");

  const stitchCanvas = document.createElement("canvas");
  const stitchCtx = stitchCanvas.getContext("2d");

  const panoTexture = new THREE.CanvasTexture(panoCanvas);
  panoTexture.colorSpace = THREE.SRGBColorSpace;
  panoTexture.minFilter = THREE.LinearFilter;
  panoTexture.magFilter = THREE.LinearFilter;

  const panoSphere = new THREE.Mesh(
    new THREE.SphereGeometry(50, 64, 32),
    new THREE.MeshBasicMaterial({ map: panoTexture, side: THREE.BackSide })
  );
  panoSphere.scale.set(-1, 1, 1);
  panoGroup.add(panoSphere);

  // Inner crossfade sphere for smooth forward-push transitions during Street View movement
  const transitionSphere = new THREE.Mesh(
    new THREE.SphereGeometry(49.4, 48, 24),
    new THREE.MeshBasicMaterial({
      map: null,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false
    })
  );
  transitionSphere.scale.set(-1, 1, 1);
  transitionSphere.renderOrder = 1;
  transitionSphere.visible = false;
  panoGroup.add(transitionSphere);

  const transitionState = {
    active: false,
    elapsed: 0,
    duration: 0.16,
    dirX: 0,
    dirZ: -1
  };

  const arrowsGroup = new THREE.Group();
  panoGroup.add(arrowsGroup);

  function buildArrowMesh(link) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.45);
    shape.lineTo(0.38, -0.25);
    shape.lineTo(0.14, -0.25);
    shape.lineTo(0.14, -0.45);
    shape.lineTo(-0.14, -0.45);
    shape.lineTo(-0.14, -0.25);
    shape.lineTo(-0.38, -0.25);
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geo, mat);
    const rad = THREE.MathUtils.degToRad(link.heading);
    const dist = 3.6;

    mesh.position.set(Math.sin(rad) * dist, 0.15, -Math.cos(rad) * dist);
    mesh.rotation.y = -rad;
    mesh.userData = {
      isNavArrow: true,
      panoId: link.panoId,
      heading: link.heading,
      baseColor: 0x38bdf8
    };
    return mesh;
  }

  let panoLoadToken = 0;
  let isLoadingPano = false;
  let currentPanoIsFast = false;
  let fastTempTexture = null;
  let isBoostActive = false;
  let hdBoostEnabled = false;

  function applyLoadedPanorama(nextPano, sourceTexture, transitionHeadingDeg = null) {
    const prevMap = panoSphere.material.map;
    if (transitionHeadingDeg !== null && prevMap && currentPano && currentPano.panoId !== nextPano.panoId) {
      if (audio) audio.playStep(isBoostActive);
      transitionSphere.material.map = prevMap;
      transitionSphere.material.opacity = 1.0;
      transitionSphere.material.needsUpdate = true;
      transitionSphere.rotation.y = panoSphere.rotation.y;
      transitionSphere.position.set(0, 0, 0);
      transitionSphere.visible = true;
      const rad = THREE.MathUtils.degToRad(transitionHeadingDeg);
      transitionState.active = true;
      transitionState.elapsed = 0;
      transitionState.dirX = Math.sin(rad);
      transitionState.dirZ = -Math.cos(rad);
    }

    currentPano = nextPano;
    livePlayer.lat = currentPano.lat;
    livePlayer.lon = currentPano.lng;

    // Swap dedicated per-pano CanvasTexture (zero CPU copy, avoids GPU size-mismatch artifacts)
    panoSphere.material.map = sourceTexture;
    panoSphere.material.needsUpdate = true;

    const headingRad = THREE.MathUtils.degToRad(currentPano.heading);
    panoSphere.rotation.y = -headingRad - Math.PI / 2;

    hoveredArrow = null;
    while (arrowsGroup.children.length > 0) {
      const child = arrowsGroup.children.pop();
      child.geometry.dispose();
      child.material.dispose();
    }
    for (const link of currentPano.links) {
      arrowsGroup.add(buildArrowMesh(link));
    }
    arrowsGroup.visible = !movementLocked;

    if (onLocationChange && !minimapForceHidden) {
      onLocationChange(currentPano.lat, currentPano.lng);
    }
    renderMinimap(currentPano.lat, currentPano.lng, lastSvConeHeading, 50);
    drawWristButtons();
  }

  // Loads immediately at crisp full resolution (Google zoom 3 or Mapillary 2048px)
  // with a 12-panorama memory cache and automatic Google -> Mapillary fallback on 429.
  async function loadPanoramaById(panoId, { fastMode = false, transitionHeadingDeg = null } = {}) {
    if (!panoId) return null;

    const cached = panoCache.get(panoId);
    if (cached) {
      currentPanoIsFast = false;
      applyLoadedPanorama(cached.pano, cached.texture, transitionHeadingDeg);
      return currentPano;
    }

    const token = ++panoLoadToken;
    isLoadingPano = true;

    try {
      if (!svSession) return null;
      const metaRes = await fetch(
        `${TILE_BASE}/streetview/metadata?session=${svSession}&key=${activeApiKey}&panoId=${encodeURIComponent(
          panoId
        )}`
      );
      if (metaRes.status === 429) {
        const switched = await handleSvQuotaHit();
        if (switched) return loadPanoramaById(panoId, { fastMode, transitionHeadingDeg });
        return null;
      }
      if (!metaRes.ok || token !== panoLoadToken) return null;
      const meta = await metaRes.json();

      const nextPano = {
        source: "google",
        panoId,
        lat: meta.lat,
        lng: meta.lng,
        heading: meta.heading || 0,
        date: meta.date || "",
        links: meta.links || [],
        imageWidth: meta.imageWidth || 8192,
        imageHeight: meta.imageHeight || 4096,
        tileWidth: meta.tileWidth || 512,
        tileHeight: meta.tileHeight || 512
      };

      const { imageWidth: imgW, imageHeight: imgH, tileWidth: tileW, tileHeight: tileH } = nextPano;
      const maxZ = Math.max(1, Math.ceil(Math.log2(Math.max(imgW / tileW, imgH / tileH))));
      const z = fastMode ? Math.min(hdBoostEnabled ? 2 : 1, maxZ) : Math.min(3, maxZ);
      const scale = Math.pow(2, maxZ - z);
      const actualW = Math.max(tileW, Math.round(imgW / scale));
      const actualH = Math.max(tileH, Math.round(imgH / scale));
      const cols = Math.ceil(actualW / tileW);
      const rows = Math.ceil(actualH / tileH);

      const fetches = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          fetches.push(
            new Promise((resolve) => {
              const img = new Image();
              img.crossOrigin = "anonymous";
              img.onload = () => resolve({ img, x, y });
              img.onerror = () => resolve(null);
              img.src = `${TILE_BASE}/streetview/tiles/${z}/${x}/${y}?session=${svSession}&key=${activeApiKey}&panoId=${encodeURIComponent(
                panoId
              )}`;
            })
          );
        }
      }

      const tilesLoaded = await Promise.all(fetches);
      if (token !== panoLoadToken) return currentPano;

      let loadedCount = 0;
      for (const t of tilesLoaded) {
        if (t && t.img) loadedCount++;
      }
      if (loadedCount === 0) {
        const switched = await handleSvQuotaHit();
        if (switched) return loadPanoramaById(panoId, { fastMode, transitionHeadingDeg });
        return null;
      }

      const cacheCanvas = document.createElement("canvas");
      cacheCanvas.width = actualW;
      cacheCanvas.height = actualH;
      const cacheCtx = cacheCanvas.getContext("2d");
      cacheCtx.fillStyle = "#000000";
      cacheCtx.fillRect(0, 0, actualW, actualH);

      for (const t of tilesLoaded) {
        if (t && t.img) {
          cacheCtx.drawImage(t.img, t.x * tileW, t.y * tileH, tileW, tileH);
        }
      }

      const cacheTex = new THREE.CanvasTexture(cacheCanvas);
      cacheTex.colorSpace = THREE.SRGBColorSpace;
      cacheTex.minFilter = THREE.LinearFilter;
      cacheTex.magFilter = THREE.LinearFilter;
      cacheTex.generateMipmaps = false;

      currentPanoIsFast = fastMode;
      if (fastMode) {
        const oldTemp = fastTempTexture;
        fastTempTexture = cacheTex;
        applyLoadedPanorama(nextPano, cacheTex, transitionHeadingDeg);
        if (oldTemp && oldTemp !== panoSphere.material.map && oldTemp !== transitionSphere.material.map) {
          oldTemp.dispose();
        }
      } else {
        panoCache.set(panoId, { pano: nextPano, canvas: cacheCanvas, texture: cacheTex });
        if (panoCache.size > 4) {
          const oldestKey = panoCache.keys().next().value;
          const oldest = panoCache.get(oldestKey);
          if (
            oldest &&
            oldest.texture &&
            oldest.texture !== panoSphere.material.map &&
            oldest.texture !== transitionSphere.material.map
          ) {
            oldest.texture.dispose();
          }
          panoCache.delete(oldestKey);
        }
        applyLoadedPanorama(nextPano, cacheTex, transitionHeadingDeg);
      }
      return currentPano;
    } finally {
      if (token === panoLoadToken) {
        isLoadingPano = false;
      }
    }
  }

  function stepForwardInDirection(controller, fastMode = false) {
    if (!isInStreetView || movementLocked || isLoadingPano || !controller) return false;
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const zoneArrow = findArrowInDirection(raycaster.ray.direction);
    if (zoneArrow && zoneArrow.userData.panoId) {
      loadPanoramaById(zoneArrow.userData.panoId, {
        fastMode,
        transitionHeadingDeg: zoneArrow.userData.heading
      });
      return true;
    }
    return false;
  }

  function sharpenCurrentPano() {
    if (isInStreetView && currentPano && currentPanoIsFast) {
      loadPanoramaById(currentPano.panoId, { fastMode: false });
    }
  }

  function setHdBoost(enabled) {
    hdBoostEnabled = Boolean(enabled);
  }

  function setBoostMode(active) {
    if (isBoostActive === active) return;
    isBoostActive = active;
    if (hoveredArrow) {
      hoveredArrow.material.color.setHex(isBoostActive ? 0xef4444 : 0x4ade80);
      hoveredArrow.scale.setScalar(isBoostActive ? 1.38 : 1.25);
    }
  }

  function update(dt) {
    if (!transitionState.active) return;
    transitionState.elapsed += dt;
    const t = Math.min(1, transitionState.elapsed / transitionState.duration);
    transitionSphere.material.opacity = 1.0 - t;
    const push = t * 3.8;
    transitionSphere.position.set(
      -transitionState.dirX * push,
      0,
      -transitionState.dirZ * push
    );
    if (t >= 1) {
      transitionState.active = false;
      transitionSphere.visible = false;
      transitionSphere.position.set(0, 0, 0);
    }
  }

  // Hold-Trigger ~100m Big Step along laser compass heading (skips intermediate panos)
  async function stepBigForwardInDirection(controller) {
    if (!isInStreetView || movementLocked || isLoadingPano || !controller || !currentPano) {
      return false;
    }
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    invPanoQ.copy(panoGroup.quaternion).invert();
    localRayDir.copy(raycaster.ray.direction).applyQuaternion(invPanoQ).normalize();
    const aimHeadingDeg =
      (THREE.MathUtils.radToDeg(Math.atan2(localRayDir.x, -localRayDir.z)) + 360) % 360;

    // Try ~100m ahead first, then ~55m ahead, else fall back to 1-step arrow
    const attempts = [
      { dist: 100, rad: 65 },
      { dist: 55, rad: 45 }
    ];
    for (const att of attempts) {
      const dest = offsetLatLon(currentPano.lat, currentPano.lng, att.dist, aimHeadingDeg);
      const found = await findNearestPano(dest.lat, dest.lon, att.rad);
      if (found && found.panoId !== currentPano.panoId) {
        await loadPanoramaById(found.panoId);
        return true;
      }
    }
    return stepForwardInDirection(controller);
  }

  async function enterStreetView(initialHeadingRad = 0) {
    if (!nearestPano || isInStreetView) return;
    isInStreetView = true;
    panoGroup.visible = true;
    panoGroup.rotation.y = initialHeadingRad;
    lastSvConeHeading = initialHeadingRad;
    drawWristButtons();
    if (audio) audio.playEnterSV();
    if (onEnterStreetView) onEnterStreetView();
    await loadPanoramaById(nearestPano.panoId);
  }

  async function loadPanoramaDirect(panoId, initialHeadingRad = 0) {
    if (!isInStreetView) {
      isInStreetView = true;
      panoGroup.visible = true;
      panoGroup.rotation.y = initialHeadingRad;
      lastSvConeHeading = initialHeadingRad;
      drawWristButtons();
      if (onEnterStreetView) onEnterStreetView();
    }
    return await loadPanoramaById(panoId);
  }

  async function jumpToStreetViewAt(lat, lon, initialHeadingRad = 0) {
    const found = await findNearestPano(lat, lon, 500);
    if (!found) return false;
    nearestPano = found;
    if (!isInStreetView) {
      await enterStreetView(initialHeadingRad);
    } else {
      await loadPanoramaById(found.panoId);
    }
    return true;
  }

  function exitStreetView() {
    if (!isInStreetView) return;
    isInStreetView = false;
    panoGroup.visible = false;
    hoveredArrow = null;
    drawWristButtons();
    if (audio) audio.playExitSV();
    if (onExitStreetView) onExitStreetView();
  }

  function toggleStreetView(initialHeadingRad = 0) {
    if (minimapForceHidden) return;
    if (isInStreetView) {
      exitStreetView();
    } else if (nearestPano) {
      enterStreetView(initialHeadingRad);
    }
  }

  function updateWristVisibility() {
    wristGroup.visible = wristMapVisible && !minimapForceHidden;
    if (!wristGroup.visible) {
      wristCursorDot.visible = false;
      wristDragging = false;
      hoveredWristControl = null;
    }
    if (desktopMinimapEl) {
      desktopMinimapEl.classList.toggle("hidden", minimapForceHidden);
    }
  }

  function toggleWristMap() {
    wristMapVisible = !wristMapVisible;
    if (audio) {
      if (wristMapVisible) audio.playMenuOpen();
      else audio.playMenuClose();
    }
    updateWristVisibility();
    if (wristGroup.visible) {
      redrawWristNow();
      drawWristCompass(isInStreetView ? lastSvConeHeading : livePlayer.heading, true);
    }
    return wristMapVisible;
  }

  function setMinimapForceHidden(hidden) {
    minimapForceHidden = hidden;
    updateWristVisibility();
  }

  function setMovementLocked(locked) {
    movementLocked = locked;
    arrowsGroup.visible = !movementLocked;
  }

  function setWristHandedness(isLefty) {
    wristGroup.position.set(isLefty ? -0.02 : 0.02, 0.095, -0.04);
    wristGroup.rotation.set(-0.52, isLefty ? -0.15 : 0.15, 0);
  }

  function rotateStreetView(deltaRad) {
    if (!isInStreetView) return;
    panoGroup.rotation.y += deltaRad;
  }

  if (desktopBtn) {
    desktopBtn.addEventListener("click", () => toggleStreetView(0));
  }

  function updateStreetViewCone(cameraYawRad) {
    if (!isInStreetView || !currentPano || minimapForceHidden) return;
    const compassHeading = panoGroup.rotation.y - cameraYawRad;
    drawWristCompass(compassHeading);
    if (renderer && renderer.xr.isPresenting) {
      lastSvConeHeading = compassHeading;
      wristConeGroup.rotation.z = -compassHeading;
    } else if (Math.abs(compassHeading - lastSvConeHeading) > 0.08) {
      lastSvConeHeading = compassHeading;
      renderMinimap(currentPano.lat, currentPano.lng, compassHeading, 50);
    }
  }

  // Directional Zone Matching + Wrist Minimap Raycasting
  const raycaster = new THREE.Raycaster();
  const tempMatrix = new THREE.Matrix4();
  const localRayDir = new THREE.Vector3();
  const invPanoQ = new THREE.Quaternion();
  const wristWorldQ = new THREE.Quaternion();
  let hoveredArrow = null;

  function findArrowInDirection(worldRayDir) {
    if (!isInStreetView || movementLocked || arrowsGroup.children.length === 0) return null;

    invPanoQ.copy(panoGroup.quaternion).invert();
    localRayDir.copy(worldRayDir).applyQuaternion(invPanoQ).normalize();

    if (localRayDir.y > 0.55) return null;

    const rayHeadingDeg =
      (THREE.MathUtils.radToDeg(Math.atan2(localRayDir.x, -localRayDir.z)) +
        360) %
      360;

    let bestArrow = null;
    let bestDiff = 52;

    for (const arrow of arrowsGroup.children) {
      const arrowHdg = arrow.userData.heading;
      const diff = Math.abs(((rayHeadingDeg - arrowHdg + 540) % 360) - 180);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestArrow = arrow;
      }
    }
    return bestArrow;
  }

  function setHighlightedArrow(arrow) {
    if (hoveredArrow === arrow) return;
    if (hoveredArrow) {
      hoveredArrow.material.color.setHex(hoveredArrow.userData.baseColor);
      hoveredArrow.scale.setScalar(1.0);
    }
    hoveredArrow = arrow;
    if (hoveredArrow) {
      hoveredArrow.material.color.setHex(isBoostActive ? 0xef4444 : 0x4ade80);
      hoveredArrow.scale.setScalar(isBoostActive ? 1.38 : 1.25);
    }
  }

  function inBox(px, py, box) {
    return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
  }

  function getWristRayInfo(controller) {
    if (!wristGroup.visible || !controller) return null;
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const btnHits = raycaster.intersectObject(wristButtonMesh, false);
    if (btnHits.length > 0 && btnHits[0].uv) {
      const u = btnHits[0].uv.x;
      const v = btnHits[0].uv.y;
      let ctrl = "sv";
      if (v >= 0.5) {
        if (u < 0.312) ctrl = "fly";
        else if (u > 0.722) ctrl = "center";
        else ctrl = "sv";
      } else {
        ctrl = u < 0.5 ? "save" : "lucky";
      }
      return { target: "button", control: ctrl, point: btnHits[0].point, u, v };
    }

    const mapHits = raycaster.intersectObject(mapMesh, false);
    if (mapHits.length > 0 && mapHits[0].uv) {
      const px = mapHits[0].uv.x * MAP_SIZE;
      const py = (1 - mapHits[0].uv.y) * MAP_SIZE;
      let ctrl = "map";
      if (inBox(px, py, ZIN_BOX)) ctrl = "zin";
      else if (inBox(px, py, ZOUT_BOX)) ctrl = "zout";
      return { target: "map", control: ctrl, point: mapHits[0].point, px, py };
    }

    return null;
  }

  function updateHover(domController) {
    if (!domController) {
      wristCursorDot.visible = false;
      hoveredWristControl = null;
      return;
    }

    const prevCtrl = hoveredWristControl;
    const hit = getWristRayInfo(domController);

    if (hit) {
      wristCursorDot.position.copy(hit.point);
      wristGroup.getWorldQuaternion(wristWorldQ);
      wristCursorDot.quaternion.copy(wristWorldQ);
      wristCursorDot.visible = true;
      hoveredWristControl = hit.control;

      if (wristDragging && hit.target === "map") {
        const dx = hit.px - wristDragLastPx.x;
        const dy = hit.py - wristDragLastPx.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          panWristMapByPixels(dx, dy);
          wristDragLastPx.x = hit.px;
          wristDragLastPx.y = hit.py;
        }
      }

      if (hoveredWristControl !== prevCtrl) {
        drawWristButtons();
        if (
          hoveredWristControl === "zin" ||
          hoveredWristControl === "zout" ||
          prevCtrl === "zin" ||
          prevCtrl === "zout"
        ) {
          redrawWristNow();
        }
      }
      setHighlightedArrow(null);
      return;
    }

    wristCursorDot.visible = false;
    hoveredWristControl = null;
    if (prevCtrl !== null) {
      drawWristButtons();
      if (prevCtrl === "zin" || prevCtrl === "zout") {
        redrawWristNow();
      }
    }

    if (isInStreetView && !movementLocked) {
      tempMatrix.identity().extractRotation(domController.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(domController.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
      const zoneArrow = findArrowInDirection(raycaster.ray.direction);
      setHighlightedArrow(zoneArrow);
    } else {
      setHighlightedArrow(null);
    }
  }

  function handleVRClick(controller, currentHeadingRad = 0) {
    const hit = getWristRayInfo(controller);
    if (hit) {
      if (hit.target === "button") {
        if (hit.control === "fly") {
          if (wristPinnedPlace && onFlyTo) {
            if (audio) audio.playClick();
            onFlyTo(wristPinnedPlace.lat, wristPinnedPlace.lon);
            wristManualMode = false;
            drawWristButtons();
          }
          return true;
        }
        if (hit.control === "sv") {
          if (wristPinnedPlace && !svQuotaExceeded) {
            const target = wristPinnedPlace;
            jumpToStreetViewAt(target.lat, target.lon, currentHeadingRad).then((ok) => {
              if (ok) {
                wristManualMode = false;
                wristPinnedPlace = null;
                drawWristButtons();
              } else {
                if (audio) audio.playError();
                noPanoFlashUntil = performance.now() + 1600;
                drawWristButtons();
                setTimeout(() => drawWristButtons(), 1650);
              }
            });
          } else if (isInStreetView) {
            exitStreetView();
          } else if (nearestPano) {
            enterStreetView(currentHeadingRad);
          }
          return true;
        }
        if (hit.control === "center") {
          if (audio) audio.playClick();
          recenterWristMap();
          return true;
        }
        if (hit.control === "save") {
          if (audio) audio.playPin();
          const lat = wristPinnedPlace ? wristPinnedPlace.lat : livePlayer.lat;
          const lon = wristPinnedPlace ? wristPinnedPlace.lon : livePlayer.lon;
          if (onBookmarkSpot) onBookmarkSpot(lat, lon);
          saveFlashUntil = performance.now() + 1600;
          drawWristButtons();
          setTimeout(() => drawWristButtons(), 1650);
          return true;
        }
        if (hit.control === "lucky") {
          if (audio) audio.playLucky();
          wristManualMode = false;
          wristPinnedPlace = null;
          drawWristButtons();
          if (onFeelingLucky) onFeelingLucky();
          return true;
        }
      }

      if (hit.target === "map") {
        if (hit.control === "zin") {
          zoomWristMap(1);
          return true;
        }
        if (hit.control === "zout") {
          zoomWristMap(-1);
          return true;
        }
        // Start Trigger + Drag pan on the wrist minimap
        wristDragging = true;
        wristManualMode = true;
        wristDragLastPx.x = hit.px;
        wristDragLastPx.y = hit.py;
        drawWristButtons();
        return true;
      }
    }

    if (isInStreetView && !movementLocked) {
      tempMatrix.identity().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
      const zoneArrow = findArrowInDirection(raycaster.ray.direction);
      if (zoneArrow && zoneArrow.userData.panoId) {
        loadPanoramaById(zoneArrow.userData.panoId, { transitionHeadingDeg: zoneArrow.userData.heading });
        return true;
      }
    }
    return false;
  }

  function handleVRPointerUp() {
    wristDragging = false;
  }

  function handleVRWristPinDrop(controller) {
    const hit = getWristRayInfo(controller);
    if (!hit || hit.target !== "map") return false;
    if (hit.control === "zin" || hit.control === "zout") return false;

    const tileSize = 512;
    const center = latLonToTileXY(wristMapState.lat, wristMapState.lon, wristMapState.zoom);
    const target = tileXYToLatLon(
      center.x + (hit.px - MAP_SIZE / 2) / tileSize,
      center.y + (hit.py - MAP_SIZE / 2) / tileSize,
      wristMapState.zoom
    );

    wristPinnedPlace = { lat: target.lat, lon: target.lon };
    wristManualMode = true;
    if (audio) audio.playPin();
    drawWristButtons();
    redrawWristNow();
    return true;
  }

  function hideWristCursor() {
    wristCursorDot.visible = false;
    hoveredWristControl = null;
    wristDragging = false;
  }

  function updateDesktopHover(clientX, clientY) {
    if (!isInStreetView || movementLocked) return;
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const zoneArrow = findArrowInDirection(raycaster.ray.direction);
    setHighlightedArrow(zoneArrow);
  }

  function handleDesktopClick(clientX, clientY) {
    if (!isInStreetView || movementLocked) return false;
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const zoneArrow = findArrowInDirection(raycaster.ray.direction);
    if (zoneArrow && zoneArrow.userData.panoId) {
      loadPanoramaById(zoneArrow.userData.panoId, { transitionHeadingDeg: zoneArrow.userData.heading });
      return true;
    }
    return false;
  }

  const camFwdTmp = new THREE.Vector3();

  function stepDesktopInDirection(clientX, clientY, fastMode = false) {
    if (!isInStreetView || movementLocked || isLoadingPano) return false;
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const zoneArrow = findArrowInDirection(raycaster.ray.direction);
    setHighlightedArrow(zoneArrow);
    if (zoneArrow && zoneArrow.userData.panoId) {
      loadPanoramaById(zoneArrow.userData.panoId, {
        fastMode,
        transitionHeadingDeg: zoneArrow.userData.heading
      });
      return true;
    }
    return false;
  }

  function stepCameraForward(fastMode = false) {
    if (!isInStreetView || movementLocked || isLoadingPano) return false;
    camera.getWorldDirection(camFwdTmp);
    const zoneArrow = findArrowInDirection(camFwdTmp);
    setHighlightedArrow(zoneArrow);
    if (zoneArrow && zoneArrow.userData.panoId) {
      loadPanoramaById(zoneArrow.userData.panoId, {
        fastMode,
        transitionHeadingDeg: zoneArrow.userData.heading
      });
      return true;
    }
    return false;
  }

  function syncFromGlobe(lat, lon, headingRad, altitude, isMoving) {
    livePlayer.lat = lat;
    livePlayer.lon = lon;
    livePlayer.heading = headingRad;
    livePlayer.altitude = altitude;
    drawWristCompass(headingRad);

    if (isInStreetView || minimapForceHidden) return;

    const mapMoved =
      lastMapRenderLat === null ||
      Math.hypot(lat - lastMapRenderLat, lon - lastMapRenderLon) >
        Math.max(0.00025, altitude / 9000000) ||
      Math.abs((lastMapRenderZoom || 0) - altitude) > altitude * 0.25;

    if (mapMoved && map2DSession) {
      lastMapRenderLat = lat;
      lastMapRenderLon = lon;
      lastMapRenderZoom = altitude;
      renderMinimap(lat, lon, headingRad, altitude);
    }

    if (!isMoving && altitude < 35000 && svEnabled && svSession && !svQuotaExceeded) {
      const lookupMoved =
        lastLookupLat === null ||
        Math.hypot(lat - lastLookupLat, lon - lastLookupLon) > 0.0004;
      if (lookupMoved) {
        lastLookupLat = lat;
        lastLookupLon = lon;
        checkNearestStreetView(lat, lon).then(() => {
          renderMinimap(lat, lon, headingRad, altitude);
        });
      }
    }
  }

  return {
    wristGroup,
    panoGroup,
    isInStreetView: () => isInStreetView,
    isLoadingPano: () => isLoadingPano,
    isStreetViewEnabled: () => svEnabled,
    isQuotaExceeded: () => svQuotaExceeded,
    isWristHovered: () => hoveredWristControl !== null || wristDragging,
    handleVRWristStick,
    getMap2DSession: () => map2DSession,
    findNearestPano,
    loadPanoramaDirect,
    stepForwardInDirection,
    sharpenCurrentPano,
    setHdBoost,
    setBoostMode,
    update,
    toggleWristMap,
    setMinimapForceHidden,
    setMovementLocked,
    setWristHandedness,
    rotateStreetView,
    syncFromGlobe,
    updateStreetViewCone,
    updateCompassHeading: (headingRad) => {
      wristConeGroup.rotation.z = -headingRad;
      drawWristCompass(headingRad);
    },
    updateHover,
    hideWristCursor,
    updateDesktopHover,
    handleVRClick,
    handleVRPointerUp,
    handleVRWristPinDrop,
    handleDesktopClick,
    stepDesktopInDirection,
    stepCameraForward,
    jumpToStreetViewAt,
    switchApiKey,
    exitStreetView
  };
}
