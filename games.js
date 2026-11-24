import * as THREE from "three";
import { CITIES, latLonToECEF } from "./boundaries.js";

const SV_REGIONS = [
  [33, 47, -123, -110], [34, 45, -106, -90], [30, 44, -88, -72],
  [44, 52, -124, -112], [43, 47, -81, -71], [19, 24, -104, -97],
  [-35, -22, -59, -43], [-36, -30, -72, -68], [3, 7, -76, -73],
  [50, 56, -5, 1], [43, 50, -2, 7], [47, 54, 6, 14],
  [37, 43, -8, 2], [40, 46, 8, 15], [49, 54, 15, 23],
  [55, 63, 8, 25], [37, 41, 20, 29], [44, 48, 16, 26],
  [32, 43, 130, 142], [35, 38, 126, 129], [22, 25, 120, 122],
  [13, 18, 99, 104], [2, 6, 101, 104], [-8, -6, 106, 113],
  [-38, -26, 144, 153], [-44, -36, 169, 177], [-34, -25, 18, 30],
  [63, 65, -23, -15], [31, 33, 34.7, 35.3], [24.8, 25.4, 55.0, 55.5]
];

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = THREE.MathUtils.degToRad(lat2 - lat1);
  const dLon = THREE.MathUtils.degToRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(THREE.MathUtils.degToRad(lat1)) *
      Math.cos(THREE.MathUtils.degToRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function scoreFromDistanceKm(km, scale = 2000) {
  if (km < 0.15) return 5000;
  return Math.max(0, Math.round(5000 * Math.exp(-km / scale)));
}

function encodeChallenge(obj) {
  const json = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(json)));
}

function decodeChallenge(str) {
  try {
    const json = decodeURIComponent(escape(atob(str)));
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function formatTimer(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function createGamesSystem({
  scene,
  enuGroup,
  renderer,
  boundaries,
  svSystem,
  audio,
  onOpenMenuTab,
  onCloseMenu,
  onResetGlobeOrbit,
  onGameStateChange
}) {
  const options = {
    ggMove: true,
    ggTimed: false,
    mtTimed: false,
    mtPool: "major",
    mtRegion: "world"
  };

  const BESTS_KEY = "zinthorr_world_bests_v1";
  let personalBests = {};
  try {
    personalBests = JSON.parse(localStorage.getItem(BESTS_KEY) || "{}") || {};
  } catch (_) {
    personalBests = {};
  }

  function getBestKeyForCurrentOptions(mode) {
    if (mode === "geoguessr") {
      return `gg_${options.ggMove ? "move" : "nomove"}_${options.ggTimed ? "timed" : "untimed"}`;
    }
    return `mt_${options.mtPool}_${options.mtRegion}_${options.mtTimed ? "timed" : "untimed"}`;
  }

  function formatBestKeyLabel(mode, key) {
    const parts = key.split("_");
    if (mode === "geoguessr") {
      const mv = parts[1] === "nomove" ? "No Move" : "Move";
      const tm = parts[2] === "timed" ? "3 Min" : "Untimed";
      return `${mv} • ${tm}`;
    }
    const poolMap = { major: "Major", all: "All 220+", hard: "Hard 100k+" };
    const regMap = { world: "World", na: "N. America", eu: "Europe", asia: "Asia" };
    const pool = poolMap[parts[1]] || parts[1] || "Major";
    const reg = regMap[parts[2]] || parts[2] || "World";
    const tm = parts[3] === "timed" ? "30s" : "Untimed";
    return `${pool} • ${reg} • ${tm}`;
  }

  function getOverallBest(mode) {
    const prefix = mode === "geoguessr" ? "gg_" : "mt_";
    let bestScore = -1;
    let bestKey = null;
    for (const [k, v] of Object.entries(personalBests)) {
      if (k.startsWith(prefix) && typeof v === "number" && v > bestScore) {
        bestScore = v;
        bestKey = k;
      }
    }
    if (bestKey === null) return null;
    return { score: bestScore, label: formatBestKeyLabel(mode, bestKey) };
  }

  function getBestScore(mode) {
    const k = getBestKeyForCurrentOptions(mode);
    return typeof personalBests[k] === "number" ? personalBests[k] : null;
  }

  function recordBestScore(mode, score) {
    const k =
      mode === "geoguessr"
        ? `gg_${session.moveAllowed ? "move" : "nomove"}_${session.isTimed ? "timed" : "untimed"}`
        : `mt_${session.activePool || options.mtPool}_${session.activeRegion || options.mtRegion}_${session.isTimed ? "timed" : "untimed"}`;
    const prev = typeof personalBests[k] === "number" ? personalBests[k] : -1;
    if (score > prev) {
      personalBests[k] = score;
      try {
        localStorage.setItem(BESTS_KEY, JSON.stringify(personalBests));
      } catch (_) {}
      return true;
    }
    return false;
  }

  const session = {
    mode: null,
    phase: "idle",
    rounds: [],
    results: [],
    roundIndex: 0,
    totalScore: 0,
    timeLeft: 0,
    isTimed: false,
    moveAllowed: true,
    activePool: "major",
    activeRegion: "world",
    pendingGuess: null,
    challengeTargetScore: null,
    shareUrl: "",
    lastError: "",
    isNewBest: false
  };

  let incomingChallenge = null;

  // =========================================================================
  // 1. 3D Globe Markers & Arc for Map Tap Mode (Dynamic Zoom-Scaled Size)
  // =========================================================================
  const mapTapGroup = new THREE.Group();
  enuGroup.add(mapTapGroup);

  const guessPinMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false, depthWrite: false })
  );
  guessPinMesh.renderOrder = 30;
  guessPinMesh.visible = false;
  mapTapGroup.add(guessPinMesh);

  const targetPinMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x22c55e, depthTest: false, depthWrite: false })
  );
  targetPinMesh.renderOrder = 30;
  targetPinMesh.visible = false;
  mapTapGroup.add(targetPinMesh);

  let guessPinCoords = null;
  let targetPinCoords = null;
  let arcLine = null;

  function clearMapTap3D() {
    guessPinMesh.visible = false;
    targetPinMesh.visible = false;
    guessPinCoords = null;
    targetPinCoords = null;
    if (arcLine) {
      mapTapGroup.remove(arcLine);
      arcLine.geometry.dispose();
      arcLine.material.dispose();
      arcLine = null;
    }
  }

  function updateMapTapMarkerScale(altitude, groundElev = 0) {
    // Scales smoothly from orbit down to neighborhood level without sinking underground
    const r = Math.max(15, altitude * 0.014);
    const lift = groundElev + Math.max(15, altitude * 0.015);
    guessPinMesh.scale.setScalar(r);
    targetPinMesh.scale.setScalar(r);
    if (guessPinCoords && guessPinMesh.visible) {
      guessPinMesh.position.copy(
        latLonToECEF(guessPinCoords.lat, guessPinCoords.lon, lift)
      );
    }
    if (targetPinCoords && targetPinMesh.visible) {
      targetPinMesh.position.copy(
        latLonToECEF(targetPinCoords.lat, targetPinCoords.lon, lift)
      );
    }
  }

  function setMapTapGuessPin(lat, lon, altitude, groundElev = 0) {
    session.pendingGuess = { lat, lon };
    guessPinCoords = { lat, lon };
    guessPinMesh.visible = true;
    updateMapTapMarkerScale(altitude, groundElev);
    if (audio) audio.playPin();
    syncBannerUI();
  }

  function drawMapTapRevealArc(gLat, gLon, tLat, tLon, altitude) {
    targetPinCoords = { lat: tLat, lon: tLon };
    targetPinMesh.visible = true;
    updateMapTapMarkerScale(altitude);

    if (arcLine) {
      mapTapGroup.remove(arcLine);
      arcLine.geometry.dispose();
      arcLine.material.dispose();
    }

    const p1 = latLonToECEF(gLat, gLon, 5000);
    const p2 = latLonToECEF(tLat, tLon, 5000);
    const pts = [];
    const steps = 40;
    const dist = p1.distanceTo(p2);
    const lift = Math.min(2000000, dist * 0.25);

    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const v = new THREE.Vector3().lerpVectors(p1, p2, f);
      const bump = Math.sin(f * Math.PI) * lift;
      v.normalize().multiplyScalar(6378137 + 5000 + bump);
      pts.push(v);
    }

    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0xfbbf24 });
    arcLine = new THREE.Line(geo, mat);
    arcLine.renderOrder = 15;
    mapTapGroup.add(arcLine);
  }

  // =========================================================================
  // 2. VR Floating Game HUD Banner
  // =========================================================================
  const vrHudCanvas = document.createElement("canvas");
  vrHudCanvas.width = 768;
  vrHudCanvas.height = 176;
  const vrHudCtx = vrHudCanvas.getContext("2d");
  const vrHudTex = new THREE.CanvasTexture(vrHudCanvas);
  vrHudTex.colorSpace = THREE.SRGBColorSpace;

  const vrHudMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.68, 0.155),
    new THREE.MeshBasicMaterial({
      map: vrHudTex,
      transparent: true,
      depthTest: false
    })
  );
  vrHudMesh.renderOrder = 50;
  vrHudMesh.visible = false;
  scene.add(vrHudMesh);

  let finalHudHideAt = 0;
  let revealAutoAdvanceTimer = 0;

  function renderVRGameHud() {
    if (!session.mode || session.phase === "idle" || !renderer.xr.isPresenting) {
      vrHudMesh.visible = false;
      return;
    }
    if (session.phase === "finished" && performance.now() >= finalHudHideAt) {
      vrHudMesh.visible = false;
      return;
    }
    vrHudMesh.visible = true;
    vrHudCtx.clearRect(0, 0, 768, 176);

    vrHudCtx.fillStyle = "rgba(10, 15, 30, 0.90)";
    vrHudCtx.strokeStyle = "#38bdf8";
    vrHudCtx.lineWidth = 4;
    vrHudCtx.beginPath();
    vrHudCtx.roundRect(6, 6, 756, 164, 22);
    vrHudCtx.fill();
    vrHudCtx.stroke();

    const modeName = session.mode === "geoguessr" ? "GEOGUESSR" : "MAP TAP";
    const rdText = `${modeName} • ROUND ${Math.min(session.roundIndex + 1, 5)}/5`;
    vrHudCtx.fillStyle = "#38bdf8";
    vrHudCtx.font = "bold 24px system-ui, sans-serif";
    vrHudCtx.textAlign = "left";
    vrHudCtx.fillText(rdText, 28, 42);

    vrHudCtx.textAlign = "right";
    vrHudCtx.fillStyle = "#4ade80";
    vrHudCtx.fillText(`Score: ${session.totalScore.toLocaleString()}`, 740, 42);

    vrHudCtx.textAlign = "center";
    vrHudCtx.fillStyle = "#ffffff";
    vrHudCtx.font = "bold 36px system-ui, sans-serif";

    let mainLine = "";
    if (session.phase === "finished") {
      mainLine = `FINAL SCORE: ${session.totalScore.toLocaleString()} / 25,000`;
    } else if (session.phase === "loading") {
      mainLine = session.mode === "geoguessr" ? "Finding 5 Street View locations..." : "Loading 5 random cities...";
    } else if (session.mode === "maptap" && session.rounds[session.roundIndex]) {
      const city = session.rounds[session.roundIndex];
      mainLine =
        session.phase === "reveal"
          ? `${city.name} • +${session.results[session.roundIndex]?.score || 0} pts`
          : `Find: ${city.name}`;
    } else if (session.mode === "geoguessr") {
      mainLine =
        session.phase === "reveal"
          ? `Round Score: +${session.results[session.roundIndex]?.score || 0} pts`
          : "Explore • Open Menu to Guess";
    }
    vrHudCtx.fillText(mainLine, 384, 102);

    vrHudCtx.font = "bold 24px system-ui, sans-serif";
    if (session.phase === "finished") {
      vrHudCtx.fillStyle = session.isNewBest ? "#4ade80" : "#cbd5e1";
      vrHudCtx.fillText(
        session.isNewBest ? "★ NEW PERSONAL BEST! ★" : "Game Complete!",
        384,
        146
      );
    } else if (session.isTimed && session.phase === "playing") {
      vrHudCtx.fillStyle = session.timeLeft <= 10 ? "#f87171" : "#fbbf24";
      vrHudCtx.fillText(`Time Left: ${formatTimer(session.timeLeft)}`, 384, 146);
    } else if (session.mode === "maptap" && session.phase === "playing") {
      vrHudCtx.fillStyle = "#cbd5e1";
      vrHudCtx.fillText(
        session.pendingGuess
          ? "Pin Dropped! Open Menu or Press A/X to Lock In"
          : "Point laser at Earth & pull Trigger to drop pin",
        384,
        146
      );
    } else if (session.mode === "maptap" && session.phase === "reveal") {
      vrHudCtx.fillStyle = "#fbbf24";
      const secs = Math.max(1, Math.ceil(revealAutoAdvanceTimer));
      const nextLabel = session.roundIndex < 4 ? "Next Round" : "Final Score";
      vrHudCtx.fillText(`Press A/X for ${nextLabel} • Auto in ${secs}s`, 384, 146);
    }
    vrHudTex.needsUpdate = true;
  }

  // =========================================================================
  // 3. Desktop Game Banner Sync
  // =========================================================================
  const bannerEl = document.getElementById("game-banner");
  const titleEl = document.getElementById("game-banner-title");
  const promptEl = document.getElementById("game-banner-prompt");
  const timerEl = document.getElementById("game-banner-timer");
  const scoreEl = document.getElementById("game-banner-score");
  const primaryBtn = document.getElementById("game-action-primary");
  const menuBtn = document.getElementById("game-action-menu");
  const quitBtn = document.getElementById("game-action-quit");

  function syncBannerUI() {
    renderVRGameHud();
    if (!bannerEl) return;
    if (!session.mode || session.phase === "idle" || session.phase === "finished") {
      bannerEl.classList.add("hidden");
      return;
    }

    bannerEl.classList.remove("hidden");
    const modeLabel = session.mode === "geoguessr" ? "GeoGuessr" : "Map Tap";
    titleEl.textContent = `${modeLabel} — Round ${session.roundIndex + 1}/5`;
    scoreEl.textContent = `Score: ${session.totalScore.toLocaleString()}`;
    timerEl.textContent =
      session.isTimed && session.phase === "playing"
        ? `⏱ ${formatTimer(session.timeLeft)}`
        : session.isTimed
        ? "⏱ Paused"
        : "Untimed";

    if (session.phase === "loading") {
      promptEl.textContent = "Loading 5 locations...";
      primaryBtn.classList.add("hidden");
      menuBtn.classList.add("hidden");
    } else if (session.mode === "maptap") {
      const target = session.rounds[session.roundIndex];
      if (session.phase === "playing") {
        promptEl.textContent = `Find: ${target.name}`;
        primaryBtn.classList.remove("hidden");
        primaryBtn.textContent = session.pendingGuess
          ? "LOCK IN GUESS"
          : "CLICK GLOBE TO DROP PIN";
        primaryBtn.disabled = !session.pendingGuess;
        menuBtn.classList.add("hidden");
      } else if (session.phase === "reveal") {
        const res = session.results[session.roundIndex];
        promptEl.textContent = `${target.name} • ${res.distKm.toFixed(0)} km away (+${res.score} pts)`;
        primaryBtn.classList.remove("hidden");
        primaryBtn.disabled = false;
        const secs = Math.max(1, Math.ceil(revealAutoAdvanceTimer));
        primaryBtn.textContent =
          session.roundIndex < 4 ? `NEXT ROUND (${secs}s)` : `VIEW FINAL SCORE (${secs}s)`;
        menuBtn.classList.add("hidden");
      }
    } else if (session.mode === "geoguessr") {
      if (session.phase === "playing") {
        promptEl.textContent = session.moveAllowed
          ? "Explore & guess on the 2D Map"
          : "No Move • Look around & guess";
        primaryBtn.classList.add("hidden");
        menuBtn.classList.remove("hidden");
        menuBtn.textContent = "OPEN 2D MAP TO GUESS (M)";
      } else if (session.phase === "reveal") {
        const res = session.results[session.roundIndex];
        promptEl.textContent = `${res.distKm.toFixed(1)} km away (+${res.score} pts)`;
        primaryBtn.classList.remove("hidden");
        primaryBtn.disabled = false;
        primaryBtn.textContent =
          session.roundIndex < 4 ? "NEXT ROUND" : "VIEW FINAL SCORE";
        menuBtn.classList.add("hidden");
      }
    }
    renderVRGameHud();
  }

  if (primaryBtn) {
    primaryBtn.addEventListener("click", () => {
      if (session.phase === "playing" && session.mode === "maptap" && session.pendingGuess) {
        submitGuess(session.pendingGuess.lat, session.pendingGuess.lon);
      } else if (session.phase === "reveal") {
        nextRound();
      }
    });
  }
  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      if (onOpenMenuTab) onOpenMenuTab("map");
    });
  }
  if (quitBtn) {
    quitBtn.addEventListener("click", () => quitGame());
  }

  // =========================================================================
  // 4. Start GeoGuessr / Map Tap & Challenge Hash Handling
  // =========================================================================
  const HARD_CITIES_URL = "https://cdn.jsdelivr.net/npm/cities.json@1.1.66/cities.json";
  const TIER1_COUNTRIES = new Set([
    "US", "CA", "GB", "FR", "DE", "IT", "ES", "NL", "BE", "CH", "AT",
    "SE", "NO", "DK", "FI", "IE", "PT", "PL", "CZ", "JP", "AU", "NZ", "TW"
  ]);
  let hardCitiesCache = null;
  let tier1CitiesCache = null;

  async function ensureHardCitiesLoaded() {
    if (hardCitiesCache) return hardCitiesCache;
    try {
      const res = await fetch(HARD_CITIES_URL);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 1000) {
          hardCitiesCache = data;
          tier1CitiesCache = data.filter((c) => TIER1_COUNTRIES.has(c.country));
        }
      }
    } catch (err) {
      console.warn("Could not fetch 100k+ cities dataset:", err);
    }
    return hardCitiesCache;
  }

  async function getRandomWorldCity() {
    await ensureHardCitiesLoaded();
    if (tier1CitiesCache && tier1CitiesCache.length > 100) {
      const item = tier1CitiesCache[Math.floor(Math.random() * tier1CitiesCache.length)];
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lng);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        const cName = formatCountryCode(item.country);
        return {
          name: cName ? `${item.name}, ${cName}` : item.name,
          lat,
          lon,
          alt: 550
        };
      }
    }
    const c = CITIES[Math.floor(Math.random() * CITIES.length)];
    return { name: c[0], lat: c[1], lon: c[2], alt: 550 };
  }

  async function generateGeoGuessrRounds() {
    const picked = [];
    const shuffled = [...SV_REGIONS].sort(() => Math.random() - 0.5);
    let idx = 0;
    for (let attempt = 0; attempt < 45 && picked.length < 5; attempt++) {
      if (svSystem.isQuotaExceeded && svSystem.isQuotaExceeded()) break;
      const reg = shuffled[idx % shuffled.length];
      idx++;
      const lat = reg[0] + Math.random() * (reg[1] - reg[0]);
      const lon = reg[2] + Math.random() * (reg[3] - reg[2]);
      const pano = await svSystem.findNearestPano(lat, lon, 50000);
      if (svSystem.isQuotaExceeded && svSystem.isQuotaExceeded()) break;
      if (!pano) continue;
      // Only allow official, outdoor, road-connected Google Street View panos (skip user photospheres)
      const isOfficialGoogle = (pano.copyright || "").toLowerCase().includes("google");
      const isOutdoor = (pano.imageryType || "").toLowerCase() !== "indoor";
      const hasRoadLinks = Array.isArray(pano.links) && pano.links.length > 0;
      if (isOfficialGoogle && isOutdoor && hasRoadLinks && !picked.some((p) => p.panoId === pano.panoId)) {
        picked.push({ panoId: pano.panoId, lat: pano.lat, lon: pano.lng });
      }
    }
    return picked;
  }

  const HARD_CITIES_FALLBACK = [
    ["Ushuaia, Argentina", -54.80, -68.30], ["Hammerfest, Norway", 70.66, 23.68],
    ["Yakutsk, Russia", 62.03, 129.73], ["Yellowknife, Canada", 62.45, -114.37],
    ["Broken Hill, Australia", -31.96, 141.46], ["Timbuktu, Mali", 16.77, -3.01],
    ["Punta Arenas, Chile", -53.16, -70.91], ["Nuuk, Greenland", 64.18, -51.72],
    ["Invercargill, New Zealand", -46.41, 168.35], ["Iquitos, Peru", -3.75, -73.25],
    ["Alice Springs, Australia", -23.70, 133.88], ["Tromsø, Norway", 69.65, 18.96],
    ["Magadan, Russia", 59.56, 150.80], ["Whitehorse, Canada", 60.72, -135.06],
    ["Swakopmund, Namibia", -22.68, 14.53], ["Tamanrasset, Algeria", 22.79, 5.52],
    ["Kashgar, China", 39.47, 75.99], ["Leh, India", 34.15, 77.58],
    ["Kuching, Malaysia", 1.55, 110.34], ["Zamboanga, Philippines", 6.92, 122.08],
    ["Arequipa, Peru", -16.41, -71.54], ["Mendoza, Argentina", -32.89, -68.83],
    ["Faro, Portugal", 37.02, -7.93], ["Tórshavn, Faroe Islands", 62.01, -6.77],
    ["Rovaniemi, Finland", 66.50, 25.73], ["Murmansk, Russia", 68.97, 33.07],
    ["Hilo, United States", 19.73, -155.09], ["Juneau, United States", 58.30, -134.42],
    ["Cairns, Australia", -16.92, 145.77], ["Hobart, Australia", -42.88, 147.33]
  ];

  let regionNames = null;
  try {
    regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  } catch (_) {}

  function formatCountryCode(code) {
    if (!code) return "";
    if (regionNames) {
      try {
        return regionNames.of(code) || code;
      } catch (_) {
        return code;
      }
    }
    return code;
  }

  function matchesRegion(lat, lon, region) {
    if (!region || region === "world") return true;
    if (region === "na") {
      return lat >= 7 && lat <= 75 && lon >= -170 && lon <= -50;
    }
    if (region === "eu") {
      return lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45;
    }
    if (region === "asia") {
      return (
        (lat >= -10 && lat <= 75 && lon >= 45 && lon <= 180) ||
        (lat >= 12 && lat <= 42 && lon >= 34 && lon < 45)
      );
    }
    return true;
  }

  async function generateMapTapRounds(poolType, region = "world") {
    if (poolType === "hard") {
      if (!hardCitiesCache) {
        try {
          const res = await fetch(HARD_CITIES_URL);
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 1000) {
              hardCitiesCache = data;
            }
          }
        } catch (err) {
          console.warn("Could not fetch 100k+ cities dataset, using fallback:", err);
        }
      }

      if (hardCitiesCache && hardCitiesCache.length > 50) {
        const picked = [];
        const usedIdx = new Set();
        let guard = 0;
        while (picked.length < 5 && guard < 2500) {
          guard++;
          const idx = Math.floor(Math.random() * hardCitiesCache.length);
          if (usedIdx.has(idx)) continue;
          const item = hardCitiesCache[idx];
          const lat = parseFloat(item.lat);
          const lon = parseFloat(item.lng);
          if (!item.name || Number.isNaN(lat) || Number.isNaN(lon)) continue;
          if (!matchesRegion(lat, lon, region)) continue;
          usedIdx.add(idx);
          const cName = formatCountryCode(item.country);
          picked.push({
            name: cName ? `${item.name}, ${cName}` : item.name,
            lat,
            lon
          });
        }
        if (picked.length === 5) return picked;
      }

      let fb = HARD_CITIES_FALLBACK.filter(([, lat, lon]) => matchesRegion(lat, lon, region));
      if (fb.length < 5) fb = [...HARD_CITIES_FALLBACK];
      fb.sort(() => Math.random() - 0.5);
      return fb.slice(0, 5).map(([name, lat, lon]) => ({ name, lat, lon }));
    }

    let pool =
      poolType === "major"
        ? CITIES.filter((c) => c[3] === 1 && matchesRegion(c[1], c[2], region))
        : CITIES.filter((c) => matchesRegion(c[1], c[2], region));

    // Graceful fallback if major + region has fewer than 5 cities
    if (pool.length < 5) {
      pool = CITIES.filter((c) => matchesRegion(c[1], c[2], region));
    }
    if (pool.length < 5) {
      pool = [...CITIES];
    }

    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 5).map(([name, lat, lon]) => ({ name, lat, lon }));
  }

  async function startGeoGuessr(challengeData = null) {
    if (svSystem.isStreetViewEnabled && !svSystem.isStreetViewEnabled()) {
      session.lastError =
        "GeoGuessr requires your own Google Maps API key. Add it in Settings → Google Maps API Key.";
      if (onGameStateChange) onGameStateChange(session);
      if (onOpenMenuTab) onOpenMenuTab("geoguessr");
      return;
    }
    quitGame(true);
    session.mode = "geoguessr";
    session.phase = "loading";
    session.results = [];
    session.roundIndex = 0;
    session.totalScore = 0;
    session.moveAllowed = challengeData ? challengeData.move : options.ggMove;
    session.isTimed = challengeData ? challengeData.timed : options.ggTimed;
    session.challengeTargetScore = challengeData ? challengeData.score : null;
    session.shareUrl = "";
    session.lastError = "";
    session.isNewBest = false;

    svSystem.setMinimapForceHidden(true);
    svSystem.setMovementLocked(!session.moveAllowed);
    if (onCloseMenu) onCloseMenu();
    syncBannerUI();
    if (onGameStateChange) onGameStateChange(session);

    session.rounds = challengeData
      ? challengeData.rounds
      : await generateGeoGuessrRounds();

    if (session.rounds.length < 5) {
      const hitLimit = svSystem.isQuotaExceeded && svSystem.isQuotaExceeded();
      quitGame();
      session.lastError = hitLimit
        ? "Daily Street View quota reached (resets midnight PT). 3D Earth & Map Tap still work!"
        : "Could not find 5 Street View locations right now. Please try again.";
      if (onGameStateChange) onGameStateChange(session);
      if (onOpenMenuTab) onOpenMenuTab("geoguessr");
      return;
    }
    session.lastError = "";

    await beginCurrentRound();
  }

  async function startMapTap(challengeData = null) {
    quitGame(true);
    session.mode = "maptap";
    session.phase = "loading";
    session.results = [];
    session.roundIndex = 0;
    session.totalScore = 0;
    session.isTimed = challengeData ? challengeData.timed : options.mtTimed;
    session.challengeTargetScore = challengeData ? challengeData.score : null;
    session.shareUrl = "";

    if (svSystem.isInStreetView()) svSystem.exitStreetView();
    boundaries.setForceHidden(true);
    svSystem.setMinimapForceHidden(true);
    if (onCloseMenu) onCloseMenu();
    syncBannerUI();
    if (onGameStateChange) onGameStateChange(session);

    const poolType = challengeData ? challengeData.pool : options.mtPool;
    const region = challengeData ? (challengeData.region || "world") : options.mtRegion;
    session.activePool = poolType;
    session.activeRegion = region;
    session.isNewBest = false;
    session.rounds = challengeData
      ? challengeData.rounds
      : await generateMapTapRounds(poolType, region);

    if (session.mode !== "maptap" || session.rounds.length < 5) {
      quitGame();
      return;
    }

    beginCurrentRound();
  }

  async function beginCurrentRound() {
    session.phase = "playing";
    session.pendingGuess = null;
    clearMapTap3D();

    if (session.mode === "geoguessr") {
      session.timeLeft = session.isTimed ? 180 : 0;
      const rd = session.rounds[session.roundIndex];
      await svSystem.loadPanoramaDirect(rd.panoId, 0);
    } else if (session.mode === "maptap") {
      session.timeLeft = session.isTimed ? 30 : 0;
      boundaries.setForceHidden(true);
      if (onResetGlobeOrbit) onResetGlobeOrbit();
    }

    syncBannerUI();
    if (onGameStateChange) onGameStateChange(session);
  }

  function submitGuess(guessLat, guessLon) {
    if (session.phase !== "playing") return null;
    const target = session.rounds[session.roundIndex];

    let distKm = 20000;
    let score = 0;
    if (guessLat !== null && guessLon !== null) {
      distKm = haversineKm(guessLat, guessLon, target.lat, target.lon);
      score = scoreFromDistanceKm(distKm, session.mode === "maptap" ? 1800 : 2000);
    }

    const res = {
      guessLat,
      guessLon,
      targetLat: target.lat,
      targetLon: target.lon,
      targetName: target.name || "",
      distKm,
      score
    };
    session.results[session.roundIndex] = res;
    session.totalScore += score;
    session.phase = "reveal";
    revealAutoAdvanceTimer = session.mode === "maptap" ? 10.0 : 0;

    if (session.mode === "maptap" && guessLat !== null) {
      drawMapTapRevealArc(guessLat, guessLon, target.lat, target.lon, 8500000);
    }

    if (audio) {
      audio.playLockIn();
      setTimeout(() => audio.playReveal(score), 160);
    }

    syncBannerUI();
    if (onGameStateChange) onGameStateChange(session);
    return res;
  }

  function nextRound() {
    if (session.phase !== "reveal") return;
    revealAutoAdvanceTimer = 0;
    if (session.roundIndex < 4) {
      session.roundIndex++;
      if (onCloseMenu) onCloseMenu();
      beginCurrentRound();
    } else {
      finishGame();
    }
  }

  function finishGame() {
    session.phase = "finished";
    finalHudHideAt = performance.now() + 5000;
    session.isNewBest = recordBestScore(session.mode, session.totalScore);
    if (audio) audio.playFanfare(session.isNewBest);
    clearMapTap3D();
    boundaries.setForceHidden(false);
    svSystem.setMinimapForceHidden(false);
    svSystem.setMovementLocked(false);
    if (svSystem.isInStreetView()) svSystem.exitStreetView();

    const payload =
      session.mode === "geoguessr"
        ? {
            m: "gg",
            move: session.moveAllowed,
            timed: session.isTimed,
            score: session.totalScore,
            rounds: session.rounds
          }
        : {
            m: "mt",
            timed: session.isTimed,
            pool: session.activePool || options.mtPool,
            region: session.activeRegion || options.mtRegion,
            score: session.totalScore,
            rounds: session.rounds
          };

    const prefix = session.mode === "geoguessr" ? "#gg=" : "#mt=";
    const base = window.location.origin + window.location.pathname;
    session.shareUrl = `${base}${prefix}${encodeChallenge(payload)}`;

    syncBannerUI();
    if (onGameStateChange) onGameStateChange(session);
    if (onOpenMenuTab) onOpenMenuTab(session.mode);
  }

  function quitGame(silent = false) {
    session.mode = null;
    session.phase = "idle";
    finalHudHideAt = 0;
    revealAutoAdvanceTimer = 0;
    vrHudMesh.visible = false;
    session.pendingGuess = null;
    clearMapTap3D();
    boundaries.setForceHidden(false);
    svSystem.setMinimapForceHidden(false);
    svSystem.setMovementLocked(false);
    if (svSystem.isInStreetView()) svSystem.exitStreetView();
    if (!silent) {
      syncBannerUI();
      if (onGameStateChange) onGameStateChange(session);
    }
  }

  const vrHudPos = new THREE.Vector3();
  const vrHudQuat = new THREE.Quaternion();
  const vrHudOffset = new THREE.Vector3();
  const vrHudTiltQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.38, 0, 0));

  function update(dt, altitude, groundElev = 0) {
    if (session.mode === "maptap" && (guessPinMesh.visible || targetPinMesh.visible)) {
      updateMapTapMarkerScale(altitude, groundElev);
    }

    if (session.phase === "finished" && vrHudMesh.visible && performance.now() >= finalHudHideAt) {
      vrHudMesh.visible = false;
    }

    if (vrHudMesh.visible && renderer.xr.isPresenting) {
      const xrCam = renderer.xr.getCamera();
      // Tucked high near the upper lens rim — glance up to read without blocking center view
      vrHudOffset.set(0, 0.62, -1.45);

      xrCam.getWorldPosition(vrHudPos);
      xrCam.getWorldQuaternion(vrHudQuat);
      vrHudOffset.applyQuaternion(vrHudQuat);

      vrHudMesh.position.copy(vrHudPos).add(vrHudOffset);
      vrHudMesh.quaternion.copy(vrHudQuat).multiply(vrHudTiltQ);
    }

    if (session.mode === "maptap" && session.phase === "reveal" && revealAutoAdvanceTimer > 0) {
      const prevSec = Math.ceil(revealAutoAdvanceTimer);
      revealAutoAdvanceTimer -= dt;
      if (revealAutoAdvanceTimer <= 0) {
        revealAutoAdvanceTimer = 0;
        nextRound();
        return;
      } else if (Math.ceil(revealAutoAdvanceTimer) !== prevSec) {
        syncBannerUI();
      }
    }

    if (session.phase === "playing" && session.isTimed) {
      const prevSec = Math.ceil(session.timeLeft);
      session.timeLeft -= dt;
      if (session.timeLeft <= 0) {
        session.timeLeft = 0;
        const g = session.pendingGuess;
        submitGuess(g ? g.lat : null, g ? g.lon : null);
        if (session.mode === "geoguessr" && onOpenMenuTab) {
          onOpenMenuTab("map");
        }
      } else if (Math.ceil(session.timeLeft) !== prevSec) {
        syncBannerUI();
      }
    }
  }

  function checkIncomingChallengeHash() {
    const hash = window.location.hash || "";
    if (hash.startsWith("#gg=")) {
      const data = decodeChallenge(hash.slice(4));
      if (data && data.rounds?.length === 5) {
        incomingChallenge = { mode: "geoguessr", data };
      }
    } else if (hash.startsWith("#mt=")) {
      const data = decodeChallenge(hash.slice(4));
      if (data && data.rounds?.length === 5) {
        incomingChallenge = { mode: "maptap", data };
      }
    }
    return incomingChallenge;
  }

  function copyShareLink() {
    if (!session.shareUrl) return false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(session.shareUrl).catch(() => {});
      return true;
    }
    return false;
  }

  return {
    options,
    session,
    getBestScore,
    getOverallBest,
    getRandomWorldCity,
    getIncomingChallenge: () => incomingChallenge,
    checkIncomingChallengeHash,
    startGeoGuessr,
    startMapTap,
    setMapTapGuessPin,
    submitGuess,
    nextRound,
    quitGame,
    copyShareLink,
    update
  };
}
