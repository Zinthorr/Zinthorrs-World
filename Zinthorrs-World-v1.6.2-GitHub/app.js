// =========================================================================
// PASTE YOUR GOOGLE MAPS API KEY BETWEEN THE QUOTES BELOW
// =========================================================================
const DEFAULT_GOOGLE_API_KEY = "PASTE_YOUR_API_KEY_HERE";
const CUSTOM_KEY_STORAGE = "zinthorr_world_custom_key_v1";
let savedCustomKey = "";
try {
  savedCustomKey = (localStorage.getItem(CUSTOM_KEY_STORAGE) || "").trim();
} catch (_) {}
const defaultKeyValid =
  Boolean(DEFAULT_GOOGLE_API_KEY) &&
  DEFAULT_GOOGLE_API_KEY !== "PASTE_YOUR_API_KEY_HERE";
const GOOGLE_API_KEY = savedCustomKey || (defaultKeyValid ? DEFAULT_GOOGLE_API_KEY : "");
const HAS_API_KEY = Boolean(GOOGLE_API_KEY);

import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { TilesRenderer } from "3d-tiles-renderer";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
import {
  GLTFExtensionsPlugin
} from "3d-tiles-renderer/three/plugins";
import { createBoundariesOverlay } from "./boundaries.js";
import { createStreetViewSystem } from "./streetview.js";
import { createGamesSystem } from "./games.js";
import { createSearchHUD } from "./search_hud.js";
import { createAudioSystem } from "./audio.js";
import { getRandomLuckyPlace } from "./featured.js";

// UI Elements
const hudEl = document.getElementById("hud");
const hudToggleBtn = document.getElementById("hud-toggle-btn");
const statusEl = document.getElementById("status");
const coordsEl = document.getElementById("coords");
const attributionEl = document.getElementById("attribution");
const errorBannerEl = document.getElementById("error-banner");

if (hudEl && hudToggleBtn) {
  hudToggleBtn.addEventListener("click", () => {
    const collapsed = hudEl.classList.toggle("collapsed");
    hudToggleBtn.textContent = collapsed ? "▶ HUD" : "◀";
  });
}

function showError(msg) {
  errorBannerEl.textContent = msg;
  errorBannerEl.classList.remove("hidden");
  statusEl.textContent = "Error loading tiles";
  statusEl.style.color = "#f87171";
}

// =========================================================================
// 0. Persistent User Settings (Turning, Comfort Vignette, Lefty Mode)
// =========================================================================
const SETTINGS_KEY = "zinthorr_world_settings_v2";
const settings = {
  turn3D: "smooth",
  turnSV: "snap",
  vignette: false,
  handedness: "right",
  timeOfDay: "day",
  muted: false
};

try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  if (saved) {
    if (saved.turn3D === "snap" || saved.turn3D === "smooth") settings.turn3D = saved.turn3D;
    if (saved.turnSV === "snap" || saved.turnSV === "smooth") settings.turnSV = saved.turnSV;
    if (typeof saved.vignette === "boolean") settings.vignette = saved.vignette;
    if (saved.handedness === "left" || saved.handedness === "right") settings.handedness = saved.handedness;
    if (saved.timeOfDay === "day" || saved.timeOfDay === "sunset" || saved.timeOfDay === "night") settings.timeOfDay = saved.timeOfDay;
    if (typeof saved.muted === "boolean") settings.muted = saved.muted;
  }
} catch (_) {}

const audio = createAudioSystem(settings);

function getDominantHand() {
  return settings.handedness === "left" ? "left" : "right";
}
function getOffHand() {
  return settings.handedness === "left" ? "right" : "left";
}

// =========================================================================
// 1. Scene, Camera, Renderer + VR Comfort Vignette
// =========================================================================
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  20000
);
camera.position.set(0, 1.3, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance"
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.xr.setFramebufferScaleFactor(1.0);
if (renderer.xr.setFoveation) renderer.xr.setFoveation(1.0);

document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const ambientLight = new THREE.AmbientLight(0xffffff, 1.15);
scene.add(ambientLight);
const sunLight = new THREE.DirectionalLight(0xffffff, 0.75);
sunLight.position.set(5, 10, 7);
scene.add(sunLight);

// VR Comfort Vignette (Sized to sit inside the headset FOV at 0.35m)
const vignetteUniforms = { uStrength: { value: 0.0 } };
const vignetteMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(0.7, 0.7),
  new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: vignetteUniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        float dist = distance(vUv, vec2(0.5)) * 2.0;
        float alpha = smoothstep(0.32, 0.82, dist) * uStrength * 0.92;
        gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
      }
    `
  })
);
vignetteMesh.frustumCulled = false;
vignetteMesh.renderOrder = 999;
vignetteMesh.visible = false;
scene.add(vignetteMesh);

// =========================================================================
// 2. Seamless World-Locked Geodesic Skybox
// =========================================================================
const skyUniforms = {
  uSkyMix: { value: 0.0 },
  uTime: { value: 0.0 },
  uTimeOfDay: { value: 0.0 }
};

const skyGeo = new THREE.IcosahedronGeometry(9000, 5);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: skyUniforms,
  vertexShader: `
    varying vec3 vWorldDir;
    void main() {
      vWorldDir = normalize(position);
      vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = clipPos.xyww;
    }
  `,
  fragmentShader: `
    uniform float uSkyMix;
    uniform float uTime;
    uniform float uTimeOfDay;
    varying vec3 vWorldDir;

    float hash31(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }

    float hash21(vec2 p) {
      p = fract(p * vec2(127.1, 311.7));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    float noise2D(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      return mix(
        mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float amp = 0.5;
      mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
      for (int i = 0; i < 3; i++) {
        v += amp * noise2D(p);
        p = rot * p * 2.03;
        amp *= 0.5;
      }
      return v;
    }

    void main() {
      vec3 dir = normalize(vWorldDir);

      vec3 spaceCol = vec3(0.010, 0.015, 0.038);
      vec3 starGrid = dir * 280.0;
      vec3 starCell = floor(starGrid);
      vec3 starFrac = fract(starGrid) - 0.5;
      float rnd = hash31(starCell);
      if (rnd > 0.990) {
        float dist = length(starFrac);
        float pointMask = smoothstep(0.38, 0.04, dist);
        float brightness = smoothstep(0.990, 1.0, rnd) * pointMask;
        vec3 starTint = mix(vec3(0.78, 0.88, 1.0), vec3(1.0, 0.90, 0.76), fract(rnd * 97.0));
        spaceCol += starTint * brightness * 1.4;
      }

      if (uSkyMix < 0.002) {
        gl_FragColor = vec4(spaceCol, 1.0);
        return;
      }

      float elev = clamp(dir.y, -1.0, 1.0);
      float isSunset = smoothstep(0.5, 1.0, uTimeOfDay) * (1.0 - smoothstep(1.0, 1.5, uTimeOfDay));
      float isNight = smoothstep(1.5, 2.0, uTimeOfDay);

      vec3 zenithCol = vec3(0.11, 0.36, 0.74);
      vec3 midSkyCol = vec3(0.28, 0.58, 0.90);
      vec3 horizonCol = vec3(0.76, 0.88, 0.98);
      vec3 lowerHazeCol = vec3(0.62, 0.77, 0.90);

      // Golden Hour Sunset palette
      zenithCol = mix(zenithCol, vec3(0.12, 0.14, 0.34), isSunset);
      midSkyCol = mix(midSkyCol, vec3(0.66, 0.30, 0.38), isSunset);
      horizonCol = mix(horizonCol, vec3(0.98, 0.62, 0.28), isSunset);
      lowerHazeCol = mix(lowerHazeCol, vec3(0.42, 0.24, 0.28), isSunset);

      // Night palette (blends with starfield)
      zenithCol = mix(zenithCol, vec3(0.012, 0.020, 0.055), isNight);
      midSkyCol = mix(midSkyCol, vec3(0.025, 0.045, 0.11), isNight);
      horizonCol = mix(horizonCol, vec3(0.06, 0.10, 0.19), isNight);
      lowerHazeCol = mix(lowerHazeCol, vec3(0.03, 0.05, 0.09), isNight);

      vec3 dayCol;
      if (elev >= 0.0) {
        float t1 = smoothstep(0.0, 0.25, elev);
        float t2 = smoothstep(0.20, 0.85, elev);
        dayCol = mix(horizonCol, midSkyCol, t1);
        dayCol = mix(dayCol, zenithCol, t2);
      } else {
        dayCol = mix(horizonCol, lowerHazeCol, smoothstep(0.0, -0.35, elev));
      }

      // Keep crisp stars visible overhead at night
      dayCol += max(spaceCol - vec3(0.010, 0.015, 0.038), 0.0) * isNight * smoothstep(0.02, 0.35, elev);

      vec3 sunDir = normalize(mix(vec3(0.45, 0.42, -0.78), vec3(0.45, 0.09, -0.88), isSunset));
      float sunAmt = max(dot(dir, sunDir), 0.0);
      vec3 sunGlow = mix(vec3(1.0, 0.94, 0.82), vec3(1.0, 0.58, 0.22), isSunset);
      dayCol += sunGlow * pow(sunAmt, mix(12.0, 8.0, isSunset)) * mix(0.22, 0.55, isSunset) * (1.0 - isNight * 0.85);

      if (elev > 0.005) {
        vec2 skyPlane = dir.xz / (elev + 0.22);
        vec2 wind = vec2(uTime * 0.006, uTime * 0.0025);
        vec2 warp = vec2(
          fbm(skyPlane * 0.9 + wind),
          fbm(skyPlane * 0.9 + vec2(5.2, 1.3) - wind * 0.7)
        );
        float c = fbm(skyPlane * 1.15 + warp * 1.4 + wind);
        float horizonFade = smoothstep(0.005, 0.22, elev);
        float cloudDensity = smoothstep(0.46, 0.78, c) * horizonFade;

        vec3 cloudLit = mix(vec3(0.99, 0.99, 1.0), vec3(1.0, 0.74, 0.48), isSunset);
        vec3 cloudShade = mix(vec3(0.76, 0.83, 0.92), vec3(0.46, 0.26, 0.36), isSunset);
        cloudLit = mix(cloudLit, vec3(0.16, 0.21, 0.32), isNight);
        cloudShade = mix(cloudShade, vec3(0.06, 0.08, 0.14), isNight);
        vec3 cloudCol = mix(cloudShade, cloudLit, smoothstep(0.45, 0.75, c));
        dayCol = mix(dayCol, cloudCol, cloudDensity * mix(0.85, 0.45, isNight));
      }

      vec3 finalCol = mix(spaceCol, dayCol, uSkyMix);
      gl_FragColor = vec4(finalCol, 1.0);
    }
  `
});
const skyDome = new THREE.Mesh(skyGeo, skyMat);
skyDome.renderOrder = 1;
skyDome.frustumCulled = false;
scene.add(skyDome);

function applyTimeOfDay() {
  const tod = settings.timeOfDay || "day";
  if (tod === "sunset") {
    skyUniforms.uTimeOfDay.value = 1.0;
    ambientLight.color.setHex(0xffd2b3);
    ambientLight.intensity = 1.05;
    sunLight.color.setHex(0xff9955);
    sunLight.intensity = 0.85;
  } else if (tod === "night") {
    skyUniforms.uTimeOfDay.value = 2.0;
    ambientLight.color.setHex(0x94b4e8);
    ambientLight.intensity = 0.65;
    sunLight.color.setHex(0x88aadd);
    sunLight.intensity = 0.42;
  } else {
    skyUniforms.uTimeOfDay.value = 0.0;
    ambientLight.color.setHex(0xffffff);
    ambientLight.intensity = 1.15;
    sunLight.color.setHex(0xffffff);
    sunLight.intensity = 0.75;
  }
}
applyTimeOfDay();

// =========================================================================
// 3. WGS84 Exact Ellipsoid + Horizon-Tilt Globe Hierarchy + Borders Overlay
// =========================================================================
const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;

const SURFACE_DIST = 2.0;
const MIN_ALTITUDE = 15;
const MAX_ALTITUDE = 16000000;

const TILT_START_ALT = 40000;
const TILT_FULL_ALT = 350;
const MAX_TILT_DEG = 68;

const state = {
  lat: 38.8339,
  lon: -104.8214,
  heading: 0,
  altitude: 8500000,
  groundElevation: 0
};

let flightTween = null;

const globePivot = new THREE.Group();
scene.add(globePivot);

const scaleGroup = new THREE.Group();
globePivot.add(scaleGroup);

const headingGroup = new THREE.Group();
scaleGroup.add(headingGroup);

const enuGroup = new THREE.Group();
enuGroup.matrixAutoUpdate = false;
headingGroup.add(enuGroup);

const boundaries = createBoundariesOverlay(maxAnisotropy);
enuGroup.add(boundaries.group);

const ecefToEnuMatrix = new THREE.Matrix4();
const SKY_AXIS_X = new THREE.Vector3(1, 0, 0);
const SKY_AXIS_Z = new THREE.Vector3(0, 0, 1);
const SKY_QUAT_ENU_ALIGN = new THREE.Quaternion().setFromAxisAngle(SKY_AXIS_X, Math.PI / 2);
const skyQuatTilt = new THREE.Quaternion();
const skyQuatHeading = new THREE.Quaternion();

function updateGlobeTransform() {
  const latRad = THREE.MathUtils.degToRad(state.lat);
  const lonRad = THREE.MathUtils.degToRad(state.lon);

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);

  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const h = state.groundElevation;
  const px = (N + h) * cosLat * cosLon;
  const py = (N + h) * cosLat * sinLon;
  const pz = (N * (1 - WGS84_E2) + h) * sinLat;

  const ex = -sinLon,          ey = cosLon,           ez = 0;
  const nx = -sinLat * cosLon, ny = -sinLat * sinLon, nz = cosLat;
  const ux = cosLat * cosLon,  uy = cosLat * sinLon,  uz = sinLat;

  const tx = -(ex * px + ey * py + ez * pz);
  const ty = -(nx * px + ny * py + nz * pz);
  const tz = -(ux * px + uy * py + uz * pz);

  ecefToEnuMatrix.set(
    ex, ey, ez, tx,
    nx, ny, nz, ty,
    ux, uy, uz, tz,
    0,  0,  0,  1
  );
  enuGroup.matrix.copy(ecefToEnuMatrix);
  enuGroup.matrixWorldNeedsUpdate = true;

  headingGroup.rotation.set(0, 0, state.heading);

  const scale = SURFACE_DIST / state.altitude;
  scaleGroup.scale.setScalar(scale);

  const logAlt = Math.log10(state.altitude);
  const t = THREE.MathUtils.clamp(
    (Math.log10(TILT_START_ALT) - logAlt) /
      (Math.log10(TILT_START_ALT) - Math.log10(TILT_FULL_ALT)),
    0,
    1
  );
  const smoothT = t * t * (3 - 2 * t);
  const tiltRad = THREE.MathUtils.degToRad(smoothT * MAX_TILT_DEG);

  skyUniforms.uSkyMix.value = smoothT;

  const pivotY = THREE.MathUtils.lerp(1.3, 0.85, smoothT);
  globePivot.position.set(0, pivotY, -SURFACE_DIST);
  globePivot.rotation.set(-tiltRad, 0, 0);

  // Lock skybox (sun, clouds, stars) to the exact same tilted ENU frame as the Earth
  skyQuatTilt.setFromAxisAngle(SKY_AXIS_X, -tiltRad);
  skyQuatHeading.setFromAxisAngle(SKY_AXIS_Z, state.heading);
  skyDome.quaternion.copy(skyQuatTilt).multiply(skyQuatHeading).multiply(SKY_QUAT_ENU_ALIGN);

  boundaries.update(state.lat, state.lon, state.altitude);
}

updateGlobeTransform();

function startSmoothFlight(targetLat, targetLon, targetAlt = 550) {
  if (svSystem.isInStreetView()) svSystem.exitStreetView();
  const distDeg = Math.hypot(targetLat - state.lat, targetLon - state.lon);
  const peakAlt = Math.min(
    MAX_ALTITUDE,
    Math.max(state.altitude, targetAlt, distDeg * 120000)
  );

  flightTween = {
    startLat: state.lat,
    startLon: state.lon,
    startAlt: state.altitude,
    endLat: targetLat,
    endLon: targetLon,
    endAlt: targetAlt,
    peakAlt,
    elapsed: 0,
    duration: THREE.MathUtils.clamp(1.2 + distDeg * 0.025, 1.2, 2.8)
  };
}

// =========================================================================
// 4. Street View, Games (GeoGuessr / Map Tap) & 6-Tab Main Menu HUD
// =========================================================================
let desktopSvYaw = 0;
let desktopSvPitch = 0;

const svSystem = createStreetViewSystem({
  apiKey: GOOGLE_API_KEY,
  streetViewEnabled: HAS_API_KEY,
  scene,
  camera,
  renderer,
  audio,
  onEnterStreetView: () => {
    flightTween = null;
    globePivot.visible = false;
    skyDome.visible = false;
    desktopSvYaw = 0;
    desktopSvPitch = 0;
    camera.rotation.set(0, 0, 0);
    camera.fov = 60;
    camera.updateProjectionMatrix();
    statusEl.textContent = "360° Street View Active";
    statusEl.style.color = "#38bdf8";
  },
  onExitStreetView: () => {
    globePivot.visible = true;
    skyDome.visible = true;
    camera.rotation.set(0, 0, 0);
    camera.fov = 60;
    camera.updateProjectionMatrix();
    statusEl.textContent = "Google 3D Earth Ready";
    statusEl.style.color = "#4ade80";
    updateGlobeTransform();
  },
  onLocationChange: (newLat, newLon) => {
    state.lat = newLat;
    state.lon = newLon;
    updateGlobeTransform();
  },
  onFlyTo: (lat, lon, alt = 550) => startSmoothFlight(lat, lon, alt),
  onBookmarkSpot: (lat, lon) => { if (searchHUD) searchHUD.addBookmark(lat, lon); },
  onFeelingLucky: () => {
    games.getRandomWorldCity().then((p) => {
      if (p) startSmoothFlight(p.lat, p.lon, p.alt || 550);
    });
  }
});

let searchHUD = null;

const games = createGamesSystem({
  scene,
  enuGroup,
  renderer,
  boundaries,
  svSystem,
  audio,
  onOpenMenuTab: (tab) => { if (searchHUD) searchHUD.open(tab); },
  onCloseMenu: () => { if (searchHUD) searchHUD.close(); },
  onResetGlobeOrbit: () => {
    state.altitude = 9000000;
    state.heading = 0;
    updateGlobeTransform();
  },
  onGameStateChange: () => {
    if (searchHUD) searchHUD.refreshUI();
  }
});

function reattachWristMinimap() {
  const offHand = getOffHand();
  svSystem.setWristHandedness(settings.handedness === "left");
  for (let i = 0; i < controllers.length; i++) {
    controllers[i].remove(svSystem.wristGroup);
    if (controllerHandedness[i] === offHand) {
      controllers[i].add(svSystem.wristGroup);
    }
  }
  updateWristControllerVisibility();
}

function updateWristControllerVisibility() {
  const offHand = getOffHand();
  const wristOpen = Boolean(svSystem && svSystem.wristGroup && svSystem.wristGroup.visible);
  for (let i = 0; i < controllerModels.length; i++) {
    controllerModels[i].visible = !(wristOpen && controllerHandedness[i] === offHand);
  }
}


function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {}
  applyTimeOfDay();
  reattachWristMinimap();
}

searchHUD = createSearchHUD({
  apiKey: GOOGLE_API_KEY,
  scene,
  camera,
  renderer,
  settings,
  games,
  audio,
  getPlayerLocation: () => ({ lat: state.lat, lon: state.lon }),
  getMap2DSession: () => svSystem.getMap2DSession(),
  customKeyStorageKey: CUSTOM_KEY_STORAGE,
  isUsingCustomKey: () => HAS_API_KEY,
  onSettingsChange: saveSettings,
  onFlyTo: (lat, lon, alt = 550) => startSmoothFlight(lat, lon, alt),
  onJumpStreetView: async (lat, lon) => {
    const ok = await svSystem.jumpToStreetViewAt(lat, lon, state.heading);
    if (!ok) startSmoothFlight(lat, lon, 550);
  },
  onFeelingLucky: () => {
    games.getRandomWorldCity().then((p) => {
      if (p) startSmoothFlight(p.lat, p.lon, p.alt || 550);
    });
  }
});

const minimapCanvasEl = document.getElementById("minimap-canvas");
const openSearchBtnEl = document.getElementById("open-search-btn");
if (minimapCanvasEl) minimapCanvasEl.addEventListener("click", () => searchHUD.open("map"));
if (openSearchBtnEl) openSearchBtnEl.addEventListener("click", () => searchHUD.open("map"));

const incoming = games.checkIncomingChallengeHash();
if (incoming) {
  setTimeout(() => searchHUD.open(incoming.mode), 400);
}

// =========================================================================
// 4b. One-Time Dismissible VR Welcome Card (Saved in localStorage)
// =========================================================================
const WELCOME_SEEN_KEY = "zinthorr_world_welcome_seen_v1";
let welcomeVisible = false;
let welcomeHovered = false;

const welcomeCanvas = document.createElement("canvas");
welcomeCanvas.width = 1024;
welcomeCanvas.height = 800;
const welcomeCtx = welcomeCanvas.getContext("2d");
const welcomeTex = new THREE.CanvasTexture(welcomeCanvas);
welcomeTex.colorSpace = THREE.SRGBColorSpace;
welcomeTex.minFilter = THREE.LinearFilter;
welcomeTex.magFilter = THREE.LinearFilter;
welcomeTex.generateMipmaps = false;

const welcomeMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1.06, 0.828),
  new THREE.MeshBasicMaterial({
    map: welcomeTex,
    transparent: true,
    depthTest: false,
    depthWrite: false
  })
);
welcomeMesh.renderOrder = 105;
welcomeMesh.visible = false;
scene.add(welcomeMesh);

const welcomeCursor = new THREE.Mesh(
  new THREE.CircleGeometry(0.013, 20),
  new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 1.0,
    depthTest: false,
    depthWrite: false
  })
);
welcomeCursor.renderOrder = 114;
welcomeCursor.visible = false;
scene.add(welcomeCursor);

function drawWelcomeCard(hovered = false) {
  const W = 1024, H = 800;
  welcomeCtx.clearRect(0, 0, W, H);

  welcomeCtx.fillStyle = "rgba(10, 15, 30, 0.97)";
  welcomeCtx.strokeStyle = "#38bdf8";
  welcomeCtx.lineWidth = 6;
  welcomeCtx.beginPath();
  welcomeCtx.roundRect(10, 10, W - 20, H - 20, 28);
  welcomeCtx.fill();
  welcomeCtx.stroke();

  welcomeCtx.textAlign = "center";
  welcomeCtx.textBaseline = "middle";
  welcomeCtx.fillStyle = "#38bdf8";
  welcomeCtx.font = "bold 36px system-ui, sans-serif";
  welcomeCtx.fillText("Welcome to Zinthorr's World VR", W / 2, 58);

  welcomeCtx.fillStyle = "#cbd5e1";
  welcomeCtx.font = "21px system-ui, sans-serif";
  welcomeCtx.fillText("Quick Controls for Galaxy XR", W / 2, 100);

  const tips = [
    ["Right B (or Left Y)", "Open Main Menu (Map, Search, Bookmarks, Featured, Games)"],
    ["Hold A or X (Either Hand)", "Superman Free-Flight (+ Trigger Boost, Opp. Stick Turns)"],
    ["Either Stick Up / Down", "Zoom 3D Earth in & out toward your laser"],
    ["Hold Grip + Move L/R", "Rotate globe North orientation (Click Left Stick: North-Up)"],
    ["Left Y (Upper)", "Toggle Interactive Wrist Minimap & Compass"],
    ["Left Menu Button", "Exit VR Mode"]
  ];

  let y = 156;
  for (const [key, desc] of tips) {
    welcomeCtx.fillStyle = "#1e293b";
    welcomeCtx.beginPath();
    welcomeCtx.roundRect(42, y - 24, W - 84, 52, 12);
    welcomeCtx.fill();

    welcomeCtx.textAlign = "left";
    welcomeCtx.fillStyle = "#38bdf8";
    welcomeCtx.font = "bold 20px system-ui, sans-serif";
    welcomeCtx.fillText(key, 66, y + 2);

    welcomeCtx.fillStyle = "#f1f5f9";
    welcomeCtx.font = "19px system-ui, sans-serif";
    welcomeCtx.fillText(desc, 376, y + 2);
    y += 62;
  }

  // API Key / Shared Pool Notice Box
  welcomeCtx.fillStyle = "rgba(120, 53, 15, 0.40)";
  welcomeCtx.strokeStyle = "#fbbf24";
  welcomeCtx.lineWidth = 2.5;
  welcomeCtx.beginPath();
  welcomeCtx.roundRect(42, 534, W - 84, 134, 14);
  welcomeCtx.fill();
  welcomeCtx.stroke();

  welcomeCtx.textAlign = "left";
  welcomeCtx.fillStyle = "#fde68a";
  welcomeCtx.font = "bold 20px system-ui, sans-serif";
  welcomeCtx.fillText("Bring Your Own Google Maps API Key", 64, 562);

  welcomeCtx.fillStyle = "#f8fafc";
  welcomeCtx.font = "18px system-ui, sans-serif";
  welcomeCtx.fillText("This GitHub version includes no built-in API key.", 64, 594);
  welcomeCtx.fillText("Paste your free Google Maps key in Settings (stored locally) or on line 4 of app.js.", 64, 620);
  welcomeCtx.fillStyle = "#cbd5e1";
  welcomeCtx.font = "16px system-ui, sans-serif";
  welcomeCtx.fillText("Experimental AI-assisted hobby project. See README for setup instructions.", 64, 648);

  welcomeCtx.fillStyle = hovered ? "#22c55e" : "#16a34a";
  welcomeCtx.strokeStyle = "#86efac";
  welcomeCtx.lineWidth = 4;
  welcomeCtx.beginPath();
  welcomeCtx.roundRect(240, 692, 544, 74, 16);
  welcomeCtx.fill();
  welcomeCtx.stroke();

  welcomeCtx.textAlign = "center";
  welcomeCtx.fillStyle = "#ffffff";
  welcomeCtx.font = "bold 28px system-ui, sans-serif";
  welcomeCtx.fillText("GOT IT — START EXPLORING", W / 2, 729);

  welcomeTex.needsUpdate = true;
}

function showWelcomeCardIfFirstTime() {
  let seen = false;
  try {
    seen = localStorage.getItem(WELCOME_SEEN_KEY) === "1";
  } catch (_) {}
  if (seen) return;

  welcomeVisible = true;
  drawWelcomeCard(false);
  const xrCam = renderer.xr.getCamera();
  const pos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  xrCam.getWorldPosition(pos);
  xrCam.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 0.001) fwd.set(0, 0, -1);
  fwd.normalize();
  welcomeMesh.position.copy(pos).addScaledVector(fwd, 1.25);
  welcomeMesh.position.y = Math.max(0.95, pos.y - 0.04);
  welcomeMesh.lookAt(pos.x, welcomeMesh.position.y, pos.z);
  welcomeMesh.visible = true;
}

function dismissWelcomeCard() {
  welcomeVisible = false;
  welcomeHovered = false;
  welcomeMesh.visible = false;
  welcomeCursor.visible = false;
  if (audio) audio.playClick();
  try {
    localStorage.setItem(WELCOME_SEEN_KEY, "1");
  } catch (_) {}
}

const welcomeRaycaster = new THREE.Raycaster();
const welcomeMat = new THREE.Matrix4();

function getWelcomeHit(controller) {
  if (!welcomeVisible || !welcomeMesh.visible || !controller) return null;
  welcomeMat.identity().extractRotation(controller.matrixWorld);
  welcomeRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  welcomeRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(welcomeMat);
  const hits = welcomeRaycaster.intersectObject(welcomeMesh, false);
  if (hits.length === 0 || !hits[0].uv) return null;
  return {
    px: hits[0].uv.x * 1024,
    py: (1 - hits[0].uv.y) * 800,
    point: hits[0].point
  };
}

// =========================================================================
// 5. Google Photorealistic 3D Tiles
// =========================================================================
let tiles = null;
let activeXREyeCam = null;
let defaultLruCache = null;

function scheduleTileTask(cb) {
  const session = renderer.xr.getSession();
  if (session) {
    session.requestAnimationFrame(() => cb());
  } else {
    window.requestAnimationFrame(cb);
  }
}

if (!GOOGLE_API_KEY || GOOGLE_API_KEY === "PASTE_YOUR_API_KEY_HERE") {
  showError("No Google Maps API key set! Press M -> Settings to paste your key in the browser, or paste it on line 4 of app.js.");
} else {
  tiles = new TilesRenderer("https://tile.googleapis.com/v1/3dtiles/root.json");

  tiles.registerPlugin(
    new GoogleCloudAuthPlugin({
      apiToken: GOOGLE_API_KEY,
      autoRefreshToken: true
    })
  );
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  dracoLoader.setWorkerLimit(4);
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));

  tiles.errorTarget = 8;
  tiles.maxDepth = 24;
  tiles.loadSiblings = false;

  defaultLruCache = tiles.lruCache
    ? {
        minSize: tiles.lruCache.minSize,
        maxSize: tiles.lruCache.maxSize,
        minBytesSize: tiles.lruCache.minBytesSize,
        maxBytesSize: tiles.lruCache.maxBytesSize
      }
    : null;

  if (tiles.downloadQueue) {
    tiles.downloadQueue.schedulingCallback = scheduleTileTask;
    tiles.downloadQueue.maxJobs = 6;
  }
  if (tiles.parseQueue) {
    tiles.parseQueue.schedulingCallback = scheduleTileTask;
    tiles.parseQueue.maxJobs = 1;
  }
  if (tiles.processNodeQueue) {
    tiles.processNodeQueue.schedulingCallback = scheduleTileTask;
  }

  tiles.addEventListener("load-model", ({ scene: tileScene }) => {
    tileScene.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (mat.map && mat.map.anisotropy !== maxAnisotropy) {
            mat.map.anisotropy = maxAnisotropy;
          }
        }
      }
    });
  });

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);

  const onReady = () => {
    if (!svSystem.isInStreetView()) {
      statusEl.textContent = "Google 3D Earth Ready";
      statusEl.style.color = "#4ade80";
    }
  };
  tiles.addEventListener("load-tile-set", onReady);
  tiles.addEventListener("load-tileset", onReady);

  tiles.addEventListener("load-error", (e) => {
    console.error("Tile load error:", e);
    showError("Google rejected the 3D Tiles request. Verify your API key and Map Tiles API status.");
  });

  enuGroup.add(tiles.group);
}

renderer.xr.addEventListener("sessionstart", () => {
  if (renderer.xr.setFoveation) renderer.xr.setFoveation(1.0);
  if (tiles) {
    if (tiles.lruCache) {
      tiles.lruCache.minSize = 500;
      tiles.lruCache.maxSize = 800;
      tiles.lruCache.minBytesSize = 150 * 1024 * 1024;
      tiles.lruCache.maxBytesSize = 300 * 1024 * 1024;
    }
    tiles.deleteCamera(camera);
    activeXREyeCam = null;
  }
  setTimeout(() => {
    if (renderer.xr.isPresenting) {
      showWelcomeCardIfFirstTime();
      loadOfficialControllerModelsInBackground();
    }
  }, 450);
});

renderer.xr.addEventListener("sessionend", () => {
  searchHUD.close();
  welcomeVisible = false;
  welcomeMesh.visible = false;
  welcomeCursor.visible = false;
  vignetteMesh.visible = false;
  for (let i = 0; i < controllerModels.length; i++) controllerModels[i].visible = true;
  deactivateScoutCamera();
  if (tiles) {
    if (tiles.lruCache && typeof defaultLruCache !== "undefined" && defaultLruCache) {
      tiles.lruCache.minSize = defaultLruCache.minSize;
      tiles.lruCache.maxSize = defaultLruCache.maxSize;
      tiles.lruCache.minBytesSize = defaultLruCache.minBytesSize;
      tiles.lruCache.maxBytesSize = defaultLruCache.maxBytesSize;
    }
    if (activeXREyeCam) {
      tiles.deleteCamera(activeXREyeCam);
      activeXREyeCam = null;
    }
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
  }
});


// Forward Scout Camera for predictive tile prefetching during Superman Flight
const scoutCamera = new THREE.PerspectiveCamera(65, 1, 0.1, 20000);
const scoutDir = new THREE.Vector3();
let scoutActive = false;

function deactivateScoutCamera() {
  if (!scoutActive) return;
  scoutActive = false;
  if (tiles) tiles.deleteCamera(scoutCamera);
}

function updateScoutCamera(eyeCam) {
  if (!tiles) return;
  if (!isFreeFlying) {
    deactivateScoutCamera();
    return;
  }
  const flyCtrlIndex = flyingHand === getOffHand()
    ? controllerHandedness.indexOf(getOffHand())
    : controllerHandedness.indexOf(getDominantHand());
  if (flyCtrlIndex === -1 || !controllers[flyCtrlIndex]) {
    deactivateScoutCamera();
    return;
  }
  controllers[flyCtrlIndex].getWorldDirection(scoutDir).negate().normalize();
  const lookAheadDist = Math.max(state.altitude * 1.4, 120);
  scoutCamera.position.copy(eyeCam.position).addScaledVector(scoutDir, lookAheadDist);
  scoutCamera.quaternion.copy(eyeCam.quaternion);
  scoutCamera.updateMatrixWorld();
  if (!scoutActive) {
    scoutActive = true;
    tiles.setCamera(scoutCamera);
    tiles.setResolution(scoutCamera, 800, 800);
  }
}

// =========================================================================
// 6. Shared Helpers + Map Tap 3D Globe Raycast Pin-Drop
// =========================================================================
function moveByEastNorthMeters(dEast, dNorth) {
  const dLat = THREE.MathUtils.radToDeg(dNorth / WGS84_A);
  const cosLat = Math.max(0.15, Math.cos(THREE.MathUtils.degToRad(state.lat)));
  const dLon = THREE.MathUtils.radToDeg(dEast / (WGS84_A * cosLat));

  state.lat = THREE.MathUtils.clamp(state.lat + dLat, -85, 85);
  state.lon = ((state.lon + dLon + 540) % 360) - 180;
}

function panByScreenFraction(dxScreen, dyScreen) {
  flightTween = null;
  const metersPerUnit = state.altitude * 1.35;
  const moveRight = dxScreen * metersPerUnit;
  const moveUp = dyScreen * metersPerUnit;

  const cosH = Math.cos(state.heading);
  const sinH = Math.sin(state.heading);
  const dEast = -(moveRight * cosH + moveUp * sinH);
  const dNorth = -(-moveRight * sinH + moveUp * cosH);

  moveByEastNorthMeters(dEast, dNorth);
  updateGlobeTransform();
}

function rotateHeading(deltaRad) {
  state.heading += deltaRad;
  updateGlobeTransform();
  if (svSystem && svSystem.updateCompassHeading) svSystem.updateCompassHeading(state.heading);
}

function zoomByFactor(factor) {
  flightTween = null;
  state.altitude = THREE.MathUtils.clamp(state.altitude * factor, MIN_ALTITUDE, MAX_ALTITUDE);
  updateGlobeTransform();
}

function getHorizonSmoothT(alt) {
  const logAlt = Math.log10(alt);
  const t = THREE.MathUtils.clamp(
    (Math.log10(TILT_START_ALT) - logAlt) /
      (Math.log10(TILT_START_ALT) - Math.log10(TILT_FULL_ALT)),
    0,
    1
  );
  return t * t * (3 - 2 * t);
}

function ecefToGeodeticLatLon(vec) {
  const p = Math.hypot(vec.x, vec.y);
  let latRad = Math.atan2(vec.z, p * (1 - WGS84_E2));
  for (let i = 0; i < 4; i++) {
    const sinL = Math.sin(latRad);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinL * sinL);
    latRad = Math.atan2(vec.z + WGS84_E2 * N * sinL, p);
  }
  return {
    lat: THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(latRad), -85, 85),
    lon: THREE.MathUtils.radToDeg(Math.atan2(vec.y, vec.x))
  };
}

const mapTapRaycaster = new THREE.Raycaster();
const hitECEF = new THREE.Vector3();
const localRayOrig = new THREE.Vector3();
const localRayEnd = new THREE.Vector3();
const localRayDir = new THREE.Vector3();

// Instant analytical Earth intersection (0ms, works over oceans & rapid scroll ticks)
function raycastEarthSphereLatLon(worldOrigin, worldDir) {
  globePivot.updateMatrixWorld(true);
  localRayOrig.copy(worldOrigin);
  localRayEnd.copy(worldOrigin).add(worldDir);
  enuGroup.worldToLocal(localRayOrig);
  enuGroup.worldToLocal(localRayEnd);
  localRayDir.subVectors(localRayEnd, localRayOrig).normalize();

  const R = WGS84_A + state.groundElevation;
  const b = localRayOrig.dot(localRayDir);
  const c = localRayOrig.dot(localRayOrig) - R * R;
  const disc = b * b - c;
  if (disc < 0) return null;

  const t = -b - Math.sqrt(disc);
  if (t < 0) return null;

  hitECEF.copy(localRayOrig).addScaledVector(localRayDir, t);
  return ecefToGeodeticLatLon(hitECEF);
}

function zoomTowardRay(factor, worldOrigin, worldDir) {
  flightTween = null;
  const oldAlt = state.altitude;
  const newAlt = THREE.MathUtils.clamp(oldAlt * factor, MIN_ALTITUDE, MAX_ALTITUDE);
  const actualFactor = newAlt / oldAlt;
  if (Math.abs(actualFactor - 1) < 1e-6) return;

  const smoothT = getHorizonSmoothT(oldAlt);
  const cursorWeight = 1.0 - smoothT;

  if (cursorWeight > 0.02 && worldOrigin && worldDir) {
    const targetGeo = raycastEarthSphereLatLon(worldOrigin, worldDir);

    if (targetGeo) {
      let dLon = targetGeo.lon - state.lon;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;
      const dLat = targetGeo.lat - state.lat;

      if (Math.hypot(dLat, dLon) < 75) {
        const pull = (1 - actualFactor) * cursorWeight;
        state.lat = THREE.MathUtils.clamp(state.lat + dLat * pull, -85, 85);
        state.lon = ((state.lon + dLon * pull + 540) % 360) - 180;
      }
    }
  }

  state.altitude = newAlt;
  updateGlobeTransform();
}

function zoomTowardMouseCursor(factor, clientX, clientY) {
  const ndc = new THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1
  );
  mapTapRaycaster.setFromCamera(ndc, camera);
  zoomTowardRay(factor, mapTapRaycaster.ray.origin, mapTapRaycaster.ray.direction);
}

function tryDropMapTapPinFromRay(origin, dir) {
  if (games.session.mode !== "maptap" || games.session.phase !== "playing") return false;
  let geo = null;
  if (tiles) {
    globePivot.updateMatrixWorld(true);
    mapTapRaycaster.set(origin, dir);
    const hits = mapTapRaycaster.intersectObject(tiles.group, true);
    if (hits.length > 0) {
      hitECEF.copy(hits[0].point);
      enuGroup.worldToLocal(hitECEF);
      if (hitECEF.length() >= 1000000) {
        geo = ecefToGeodeticLatLon(hitECEF);
      }
    }
  }
  if (!geo) geo = raycastEarthSphereLatLon(origin, dir);
  if (!geo) return false;
  games.setMapTapGuessPin(geo.lat, geo.lon, state.altitude, state.groundElevation);
  return true;
}

// =========================================================================
// 7. Desktop Mouse & Keyboard Controls (Includes Street View Scroll Zoom)
// =========================================================================
let mouseDragMode = null;
let lastMouseX = 0, lastMouseY = 0, pointerDownX = 0, pointerDownY = 0;
let pcSvMouseHold = false;
let pcSvHoldTime = 0;
let pcSvCruiseTimer = 0;
let pcSvDidCruise = false;
let pcSvKeyCruiseActive = false;

window.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("pointerdown", (e) => {
  if (renderer.xr.isPresenting || searchHUD.isOpen()) return;
  if (
    e.target.closest("#hud") ||
    e.target.closest("#desktop-minimap") ||
    e.target.closest("#search-modal") ||
    e.target.closest("#game-banner")
  ) return;

  pointerDownX = lastMouseX = e.clientX;
  pointerDownY = lastMouseY = e.clientY;

  if (svSystem.isInStreetView()) {
    mouseDragMode = "sv-look";
    if (e.button === 0) {
      pcSvMouseHold = true;
      pcSvHoldTime = 0;
      pcSvCruiseTimer = 0;
      pcSvDidCruise = false;
    }
  } else if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
    mouseDragMode = "rotate";
  } else if (e.button === 0) {
    mouseDragMode = "pan";
  }
});

window.addEventListener("pointermove", (e) => {
  if (renderer.xr.isPresenting || searchHUD.isOpen()) return;

  if (svSystem.isInStreetView() && !mouseDragMode) {
    svSystem.updateDesktopHover(e.clientX, e.clientY);
  }

  if (!mouseDragMode) return;
  const dxPx = e.clientX - lastMouseX;
  const dyPx = e.clientY - lastMouseY;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;

  if (mouseDragMode === "sv-look") {
    if (pcSvMouseHold && !pcSvDidCruise && Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > 8) {
      pcSvMouseHold = false;
      pcSvHoldTime = 0;
      svSystem.setBoostMode(false);
    }
    const fovScale = camera.fov / 60;
    desktopSvYaw += dxPx * 0.004 * fovScale;
    desktopSvPitch = THREE.MathUtils.clamp(
      desktopSvPitch + dyPx * 0.004 * fovScale,
      -Math.PI / 2.2,
      Math.PI / 2.2
    );
    camera.rotation.order = "YXZ";
    camera.rotation.y = desktopSvYaw;
    camera.rotation.x = desktopSvPitch;
    svSystem.updateStreetViewCone(desktopSvYaw);
  } else if (mouseDragMode === "pan") {
    const scaleNorm = 1.0 / Math.max(window.innerHeight, 400);
    panByScreenFraction(dxPx * scaleNorm, -dyPx * scaleNorm);
  } else if (mouseDragMode === "rotate") {
    rotateHeading(dxPx * 0.006);
  }
});

window.addEventListener("pointerup", (e) => {
  const clickDist = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);
  const wasPcCruise = pcSvDidCruise;
  if (pcSvMouseHold || pcSvDidCruise) {
    pcSvMouseHold = false;
    pcSvHoldTime = 0;
    pcSvCruiseTimer = 0;
    svSystem.setBoostMode(false);
    if (pcSvDidCruise) {
      svSystem.sharpenCurrentPano();
    }
    pcSvDidCruise = false;
  }
  if (mouseDragMode === "sv-look" && clickDist < 6 && !wasPcCruise) {
    svSystem.handleDesktopClick(e.clientX, e.clientY);
  } else if (mouseDragMode === "pan" && clickDist < 6 && games.session.mode === "maptap") {
    const ndc = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
    mapTapRaycaster.setFromCamera(ndc, camera);
    tryDropMapTapPinFromRay(mapTapRaycaster.ray.origin, mapTapRaycaster.ray.direction);
  }
  mouseDragMode = null;
});

window.addEventListener(
  "wheel",
  (e) => {
    if (renderer.xr.isPresenting || searchHUD.isOpen()) return;
    if (svSystem.isInStreetView()) {
      camera.fov = THREE.MathUtils.clamp(
        camera.fov + (e.deltaY > 0 ? 5 : -5),
        20,
        80
      );
      camera.updateProjectionMatrix();
      return;
    }
    zoomTowardMouseCursor(e.deltaY < 0 ? 0.82 : 1.22, e.clientX, e.clientY);
  },
  { passive: true }
);

const pressedKeys = new Set();
window.addEventListener("keydown", (e) => {
  if (document.activeElement && document.activeElement.tagName === "INPUT") {
    if (e.key === "Escape") searchHUD.close();
    return;
  }

  const key = e.key.toLowerCase();
  pressedKeys.add(key);

  if (key === "escape") {
    if (searchHUD.isOpen()) searchHUD.close();
    else if (svSystem.isInStreetView() && !games.session.mode) svSystem.exitStreetView();
  } else if (key === "m") {
    e.preventDefault();
    searchHUD.toggle();
  } else if (key === "r" && !svSystem.isInStreetView() && !searchHUD.isOpen()) {
    state.heading = 0;
    updateGlobeTransform();
  } else if (key === "l" && !svSystem.isInStreetView() && !searchHUD.isOpen()) {
    boundaries.toggle();
    boundaries.update(state.lat, state.lon, state.altitude);
  }
});
window.addEventListener("keyup", (e) => pressedKeys.delete(e.key.toLowerCase()));

// =========================================================================
// 8. Galaxy XR / WebXR Controllers (Full Lefty Mode Support)
// =========================================================================
const controllers = [];
const controllerModels = [];
const controllerGrips = [];
const proceduralFallbacks = [];
let officialControllerModelsLoaded = false;

function createProceduralControllerModel() {
  const g = new THREE.Group();
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.55, metalness: 0.2 });
  const faceMat = new THREE.MeshStandardMaterial({ color: 0x11141a, roughness: 0.35, metalness: 0.25 });
  const btnMat = new THREE.MeshStandardMaterial({ color: 0x3b4252, roughness: 0.4, metalness: 0.15 });
  const accentMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });

  // Angled pistol-style grip handle extending down and back into the palm (+Z is toward user)
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.0155, 0.0135, 0.11, 16), gripMat);
  handle.rotation.x = -0.58;
  handle.position.set(0, -0.042, 0.036);
  g.add(handle);

  // Bottom rounded pommel
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.0135, 14, 10), gripMat);
  pommel.position.set(0, -0.088, 0.066);
  g.add(pommel);

  // Upper thumb-rest body / faceplate angled toward thumb
  const topBody = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.018, 0.026, 18), gripMat);
  topBody.rotation.x = 0.28;
  topBody.position.set(0, 0.004, -0.002);
  g.add(topBody);

  const facePlate = new THREE.Mesh(new THREE.CircleGeometry(0.022, 18), faceMat);
  facePlate.rotation.x = -Math.PI / 2 + 0.28;
  facePlate.position.set(0, 0.0175, -0.0055);
  g.add(facePlate);

  // Subtle accent trim around faceplate
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.0225, 0.0016, 8, 24), accentMat);
  rim.rotation.x = Math.PI / 2 + 0.28;
  rim.position.set(0, 0.017, -0.0055);
  g.add(rim);

  // Thumbstick + two face buttons
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0045, 0.01, 12), btnMat);
  stick.position.set(-0.006, 0.022, -0.009);
  g.add(stick);

  const btn1 = new THREE.Mesh(new THREE.CylinderGeometry(0.0036, 0.0036, 0.004, 10), btnMat);
  btn1.position.set(0.008, 0.020, -0.002);
  g.add(btn1);

  const btn2 = new THREE.Mesh(new THREE.CylinderGeometry(0.0036, 0.0036, 0.004, 10), btnMat);
  btn2.position.set(0.011, 0.018, -0.011);
  g.add(btn2);

  // Index trigger tucked forward (-Z) underneath
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.018, 0.012), btnMat);
  trigger.rotation.x = 0.35;
  trigger.position.set(0, -0.012, -0.022);
  g.add(trigger);

  return g;
}

// Lazy-load official WebXR controller models AFTER VR starts so VR entry is instant
function loadOfficialControllerModelsInBackground() {
  if (officialControllerModelsLoaded) return;
  officialControllerModelsLoaded = true;
  import("three/addons/webxr/XRControllerModelFactory.js")
    .then(({ XRControllerModelFactory }) => {
      const factory = new XRControllerModelFactory();
      for (let i = 0; i < controllerGrips.length; i++) {
        const officialModel = factory.createControllerModel(controllerGrips[i]);
        controllerModels[i].add(officialModel);
        // Hide procedural fallback once the official GLB child mesh loads in
        const checkLoaded = setInterval(() => {
          if (officialModel.motionController || officialModel.children.length > 0) {
            if (proceduralFallbacks[i]) proceduralFallbacks[i].visible = false;
            clearInterval(checkLoaded);
          }
        }, 250);
        setTimeout(() => clearInterval(checkLoaded), 12000);
      }
    })
    .catch(() => {
      // Keep clean procedural fallback if offline or profile unavailable
    });
}
const beamMaterials = [];
const controllerHandedness = ["unknown", "unknown"];
const activeTriggers = new Set();
const activeGrips = new Set();

const lastHandPositions = [new THREE.Vector3(), new THREE.Vector3()];
const lastGripPositions = [new THREE.Vector3(), new THREE.Vector3()];
const currHandPos0 = new THREE.Vector3();
const currHandPos1 = new THREE.Vector3();
const gripDeltaVec = new THREE.Vector3();
const xrCamRightVec = new THREE.Vector3();
const xrCamQuatTmp = new THREE.Quaternion();
let lastWheelAngle = null;
let lastGripWheelAngle = null;
let wasDomMenuPressed = false;
let wasOffWristPressed = false;
let wasOffStickClickPressed = false;
let wasDomConfirmPressed = false;
let snapTurnArmed = true;

const vrDragVelocity = { x: 0, y: 0 };
let isFreeFlying = false;
let flyingHand = null; // "left" | "right" | null
let isBoostFlying = false;
let flyRamp = 0;
let boostRamp = 0;
let domFaceHoldTime = 0;
let domFaceUsedForWrist = false;

// VR Street View hold-trigger low-res (z=1) Cruise Boost state
let svHoldActive = false;
let svHoldTime = 0;
let svCruiseTimer = 0;
let svDidCruise = false;

function updateBeamColors() {
  const offHand = getOffHand();
  for (let i = 0; i < beamMaterials.length; i++) {
    let color = 0x38bdf8;
    if (activeGrips.size >= 1) color = 0xf59e0b;
    else if (isFreeFlying && controllerHandedness[i] === flyingHand) {
      color = isBoostFlying ? 0x67e8f9 : 0xd946ef;
    } else if (activeTriggers.size >= 2) color = 0xf59e0b;
    else if (activeTriggers.size === 1) color = 0x4ade80;
    beamMaterials[i].color.setHex(color);
  }
}

const ctrlTempMat = new THREE.Matrix4();
const ctrlRayOrig = new THREE.Vector3();
const ctrlRayDir = new THREE.Vector3();

function setupController(index) {
  const controller = renderer.xr.getController(index);

  const beamGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -4)
  ]);
  const beamMat = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.95,
    depthTest: true,
    depthWrite: false
  });
  const beamLine = new THREE.Line(beamGeo, beamMat);
  beamLine.renderOrder = 110;
  controller.add(beamLine);

  controller.addEventListener("connected", (event) => {
    controllerHandedness[index] = event.data?.handedness || "unknown";
    reattachWristMinimap();
  });

  controller.addEventListener("disconnected", () => {
    controller.remove(svSystem.wristGroup);
    controllerHandedness[index] = "unknown";
  });

  controller.addEventListener("selectstart", () => {
    const domHand = getDominantHand();

    if (controllerHandedness[index] === domHand) {
      if (welcomeVisible) {
        const wHit = getWelcomeHit(controller);
        if (wHit) {
          dismissWelcomeCard();
          return;
        }
      }
      if (searchHUD.isOpen() && searchHUD.handleVRPointerDown(controller)) return;
      const wasHoveringWrist = svSystem.isWristHovered();
      const clickedSVOrWrist = svSystem.handleVRClick(controller, state.heading);
      if (svSystem.isInStreetView() && !wasHoveringWrist) {
        svHoldActive = true;
        svHoldTime = 0;
        svCruiseTimer = 0;
        svDidCruise = false;
        return;
      }
      if (clickedSVOrWrist) return;

      if (games.session.mode === "maptap" && games.session.phase === "playing") {
        ctrlTempMat.identity().extractRotation(controller.matrixWorld);
        ctrlRayOrig.setFromMatrixPosition(controller.matrixWorld);
        ctrlRayDir.set(0, 0, -1).applyMatrix4(ctrlTempMat);
        tryDropMapTapPinFromRay(ctrlRayOrig, ctrlRayDir);
      }
    }

    if (svSystem.isInStreetView() || searchHUD.isOpen()) return;

    activeTriggers.add(index);
    flightTween = null;
    vrDragVelocity.x = 0;
    vrDragVelocity.y = 0;
    controller.getWorldPosition(lastHandPositions[index]);
    if (activeTriggers.size === 2) {
      controllers[0].getWorldPosition(currHandPos0);
      controllers[1].getWorldPosition(currHandPos1);
      lastWheelAngle = Math.atan2(
        currHandPos1.y - currHandPos0.y,
        currHandPos1.x - currHandPos0.x
      );
    }
    updateBeamColors();
  });

  controller.addEventListener("selectend", () => {
    if (controllerHandedness[index] === getDominantHand()) {
      svSystem.handleVRPointerUp();
      if (searchHUD.isOpen()) {
        searchHUD.handleVRPointerUp(controller);
      }
      if (svHoldActive) {
        svHoldActive = false;
        svSystem.setBoostMode(false);
        if (svDidCruise) {
          svSystem.sharpenCurrentPano();
        }
        svDidCruise = false;
        svHoldTime = 0;
        svCruiseTimer = 0;
      }
    }
    activeTriggers.delete(index);
    lastWheelAngle = null;
    if (activeTriggers.size === 1) {
      const remaining = [...activeTriggers][0];
      controllers[remaining].getWorldPosition(lastHandPositions[remaining]);
    }
    updateBeamColors();
  });

  controller.addEventListener("squeezestart", () => {
    activeGrips.add(index);
    controller.getWorldPosition(lastGripPositions[index]);
    if (activeGrips.size >= 2) {
      controllers[0].getWorldPosition(currHandPos0);
      controllers[1].getWorldPosition(currHandPos1);
      lastGripWheelAngle = Math.atan2(
        currHandPos1.y - currHandPos0.y,
        currHandPos1.x - currHandPos0.x
      );
    }
    updateBeamColors();
  });

  controller.addEventListener("squeezeend", () => {
    activeGrips.delete(index);
    lastGripWheelAngle = null;
    if (activeGrips.size === 1) {
      const rem = [...activeGrips][0];
      controllers[rem].getWorldPosition(lastGripPositions[rem]);
    }
    updateBeamColors();
  });

  const controllerGrip = renderer.xr.getControllerGrip(index);
  const modelRoot = new THREE.Group();
  const fallbackMesh = createProceduralControllerModel();
  modelRoot.add(fallbackMesh);
  controllerGrip.add(modelRoot);
  scene.add(controllerGrip);
  controllerGrips.push(controllerGrip);
  controllerModels.push(modelRoot);
  proceduralFallbacks.push(fallbackMesh);

  scene.add(controller);
  controllers.push(controller);
  beamMaterials.push(beamMat);
}

setupController(0);
setupController(1);

// =========================================================================
// 9. Live Terrain Elevation Raycaster
// =========================================================================
const raycaster = new THREE.Raycaster();
const rayOriginLocal = new THREE.Vector3();
const rayEndLocal = new THREE.Vector3();
const rayOriginWorld = new THREE.Vector3();
const rayEndWorld = new THREE.Vector3();
const rayDirWorld = new THREE.Vector3();
const hitLocal = new THREE.Vector3();

let lastElevLat = null;
let lastElevLon = null;
let lastElevAlt = null;
let targetGroundElevation = 0;

const elevBoundSphere = new THREE.Sphere();

function sampleTerrainElevation() {
  if (!tiles || svSystem.isInStreetView()) return;

  if (state.altitude > 120000) {
    lastElevLat = null;
    targetGroundElevation = 0;
    return;
  }

  // Skip redundant raycast only when stationary AND already converged to terrain
  if (
    lastElevLat !== null &&
    Math.hypot(state.lat - lastElevLat, state.lon - lastElevLon) < 0.00005 &&
    Math.abs(state.altitude - lastElevAlt) < state.altitude * 0.15 &&
    Math.abs(targetGroundElevation - state.groundElevation) < 1.0
  ) {
    return;
  }
  lastElevLat = state.lat;
  lastElevLon = state.lon;
  lastElevAlt = state.altitude;

  headingGroup.updateMatrixWorld(true);
  rayOriginLocal.set(0, 0, 12000);
  rayEndLocal.set(0, 0, -10000);

  rayOriginWorld.copy(rayOriginLocal).applyMatrix4(headingGroup.matrixWorld);
  rayEndWorld.copy(rayEndLocal).applyMatrix4(headingGroup.matrixWorld);
  rayDirWorld.subVectors(rayEndWorld, rayOriginWorld).normalize();

  raycaster.set(rayOriginWorld, rayDirWorld);

  // Pre-filter to visible meshes whose world bounding sphere intersects the ray,
  // then sort smallest-first (most detailed tile) and stop on the first hit
  const candidates = [];
  tiles.group.traverseVisible((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
    elevBoundSphere.copy(obj.geometry.boundingSphere).applyMatrix4(obj.matrixWorld);
    if (raycaster.ray.intersectsSphere(elevBoundSphere)) {
      candidates.push({ obj, radius: elevBoundSphere.radius });
    }
  });
  if (candidates.length === 0) return;

  candidates.sort((a, b) => a.radius - b.radius);

  for (let i = 0; i < candidates.length; i++) {
    const hits = raycaster.intersectObject(candidates[i].obj, false);
    if (hits.length > 0) {
      hitLocal.copy(hits[0].point);
      headingGroup.worldToLocal(hitLocal);
      targetGroundElevation = THREE.MathUtils.clamp(state.groundElevation + hitLocal.z, -500, 9000);
      break;
    }
  }
}

function convergeGroundElevation(dt) {
  if (svSystem.isInStreetView()) return;
  const diff = targetGroundElevation - state.groundElevation;
  if (Math.abs(diff) < 0.25) {
    if (diff !== 0) {
      const prevElev = state.groundElevation;
      state.groundElevation = targetGroundElevation;
      if (!flightTween) {
        state.altitude = THREE.MathUtils.clamp(
          state.altitude - (state.groundElevation - prevElev),
          MIN_ALTITUDE,
          MAX_ALTITUDE
        );
      }
      updateGlobeTransform();
    }
    return;
  }

  const blend = Math.min(1, dt * 6.0);
  const step = diff * blend;
  state.groundElevation += step;
  // Preserve visual MSL height so the camera never jumps, while clamping AGL above terrain
  if (!flightTween) {
    state.altitude = THREE.MathUtils.clamp(
      state.altitude - step,
      MIN_ALTITUDE,
      MAX_ALTITUDE
    );
  }
  updateGlobeTransform();
}

function updateCoordsReadout() {
  if (games.session.mode === "geoguessr" && games.session.phase === "playing") {
    coordsEl.textContent = "GeoGuessr Active • Coords Hidden";
    return;
  }
  const altStr =
    state.altitude >= 10000
      ? `${(state.altitude / 1000).toFixed(0)} km`
      : state.altitude >= 1000
      ? `${(state.altitude / 1000).toFixed(1)} km`
      : `${state.altitude.toFixed(0)} m`;

  const headingDeg = ((THREE.MathUtils.radToDeg(state.heading) % 360) + 360) % 360;
  coordsEl.textContent = `Lat: ${state.lat.toFixed(4)} | Lng: ${state.lon.toFixed(4)} | Alt: ${altStr} | Hdg: ${headingDeg.toFixed(0)}°`;
}

// =========================================================================
// 10. Main Animation & VR Loop
// =========================================================================
const clock = new THREE.Clock();
const flyWorldDir = new THREE.Vector3();
const invPivotQ = new THREE.Quaternion();
const invHeadingQ = new THREE.Quaternion();
const xrLookDir = new THREE.Vector3();
const vigPos = new THREE.Vector3();
const vigQuat = new THREE.Quaternion();
const vigFwd = new THREE.Vector3();
let frameCounter = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  skyUniforms.uTime.value += dt;

  const inSV = svSystem.isInStreetView();
  if (inSV) svSystem.update(dt);
  let isMovingThisFrame = mouseDragMode !== null;

  games.update(dt, state.altitude, state.groundElevation);

  if (flightTween && !inSV) {
    isMovingThisFrame = true;
    flightTween.elapsed += dt;
    const rawT = Math.min(1, flightTween.elapsed / flightTween.duration);
    const ease = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

    state.lat = THREE.MathUtils.lerp(flightTween.startLat, flightTween.endLat, ease);
    state.lon = THREE.MathUtils.lerp(flightTween.startLon, flightTween.endLon, ease);

    const logStart = Math.log10(flightTween.startAlt);
    const logEnd = Math.log10(flightTween.endAlt);
    const logPeak = Math.log10(flightTween.peakAlt);
    const arc = Math.sin(rawT * Math.PI);
    const baseLog = THREE.MathUtils.lerp(logStart, logEnd, ease);
    state.altitude = Math.pow(10, THREE.MathUtils.lerp(baseLog, logPeak, arc * 0.65));

    updateGlobeTransform();
    if (rawT >= 1) {
      state.altitude = flightTween.endAlt;
      flightTween = null;
      updateGlobeTransform();
    }
  }

  // PC Street View Cruise Boost: Hold Left-Click (>= 0.4s without drag) OR Hold W / ArrowUp
  if (!renderer.xr.isPresenting && inSV && !searchHUD.isOpen()) {
    const keyFwd = pressedKeys.has("w") || pressedKeys.has("arrowup");
    if (keyFwd) {
      pcSvKeyCruiseActive = true;
      svSystem.setBoostMode(true);
      pcSvCruiseTimer -= dt;
      if (pcSvCruiseTimer <= 0 && !svSystem.isLoadingPano()) {
        if (svSystem.stepCameraForward(true)) {
          pcSvCruiseTimer = 0.28;
        }
      }
    } else if (pcSvKeyCruiseActive) {
      pcSvKeyCruiseActive = false;
      svSystem.setBoostMode(false);
      svSystem.sharpenCurrentPano();
      pcSvCruiseTimer = 0;
    } else if (pcSvMouseHold) {
      pcSvHoldTime += dt;
      if (pcSvHoldTime >= 0.4) {
        svSystem.setBoostMode(true);
        pcSvCruiseTimer -= dt;
        if (pcSvCruiseTimer <= 0 && !svSystem.isLoadingPano()) {
          if (svSystem.stepDesktopInDirection(lastMouseX, lastMouseY, true)) {
            pcSvDidCruise = true;
            pcSvCruiseTimer = 0.28;
          }
        }
      }
    }
  } else if (!inSV && (pcSvMouseHold || pcSvKeyCruiseActive)) {
    pcSvMouseHold = false;
    pcSvKeyCruiseActive = false;
    pcSvDidCruise = false;
    pcSvHoldTime = 0;
    pcSvCruiseTimer = 0;
    svSystem.setBoostMode(false);
  }

    if (!renderer.xr.isPresenting && !inSV && !searchHUD.isOpen()) {
    if (pressedKeys.has("q")) { rotateHeading(-1.4 * dt); isMovingThisFrame = true; }
    if (pressedKeys.has("e")) { rotateHeading(1.4 * dt); isMovingThisFrame = true; }

    const fwd = (pressedKeys.has("w") ? 1 : 0) - (pressedKeys.has("s") ? 1 : 0);
    const right = (pressedKeys.has("d") ? 1 : 0) - (pressedKeys.has("a") ? 1 : 0);
    if (fwd !== 0 || right !== 0) {
      flightTween = null;
      isMovingThisFrame = true;
      const len = Math.hypot(fwd, right);
      const nf = fwd / len, nr = right / len;
      const cosH = Math.cos(state.heading), sinH = Math.sin(state.heading);
      const boost = pressedKeys.has("shift") ? 2.8 : 1.0;
      const speedMeters = Math.max(state.altitude * 0.9, 45) * boost * dt;
      moveByEastNorthMeters((nr * cosH + nf * sinH) * speedMeters, (-nr * sinH + nf * cosH) * speedMeters);
      updateGlobeTransform();
    }
  }

  const session = renderer.xr.getSession();
  if (session) {
    const domHand = getDominantHand();
    const offHand = getOffHand();
    const domCtrlIndex = controllerHandedness.indexOf(domHand);
    const offCtrlIndex = controllerHandedness.indexOf(offHand);

    const menuOpen = searchHUD.isOpen();
    for (let i = 0; i < beamMaterials.length; i++) {
      beamMaterials[i].depthTest = !(menuOpen || welcomeVisible);
    }

    if (domCtrlIndex !== -1) {
      if (welcomeVisible) {
        svSystem.hideWristCursor();
        const wHit = getWelcomeHit(controllers[domCtrlIndex]);
        if (wHit) {
          welcomeCursor.position.copy(wHit.point);
          welcomeCursor.quaternion.copy(welcomeMesh.quaternion);
          welcomeCursor.visible = true;
          const overBtn = wHit.px >= 240 && wHit.px <= 784 && wHit.py >= 692 && wHit.py <= 766;
          if (overBtn !== welcomeHovered) {
            welcomeHovered = overBtn;
            drawWelcomeCard(overBtn);
          }
        } else {
          welcomeCursor.visible = false;
          if (welcomeHovered) {
            welcomeHovered = false;
            drawWelcomeCard(false);
          }
        }
      } else if (menuOpen) {
        welcomeCursor.visible = false;
        svSystem.hideWristCursor();
        searchHUD.updateHover(controllers[domCtrlIndex]);
      } else {
        welcomeCursor.visible = false;
        svSystem.updateHover(controllers[domCtrlIndex]);
      }
    }

    // VR Street View Hold-Trigger Low-Res (z=1) Cruise Boost (2 tiles/step, red arrow, sharpens on release)
    if (svHoldActive && inSV && !menuOpen && domCtrlIndex !== -1) {
      svHoldTime += dt;
      if (svHoldTime >= 0.4) {
        svSystem.setBoostMode(true);
        svCruiseTimer -= dt;
        if (svCruiseTimer <= 0 && !svSystem.isLoadingPano()) {
          if (svSystem.stepForwardInDirection(controllers[domCtrlIndex], true)) {
            svDidCruise = true;
            svCruiseTimer = 0.28;
          }
        }
      }
    } else if (!inSV && svHoldActive) {
      svHoldActive = false;
      svDidCruise = false;
      svHoldTime = 0;
      svCruiseTimer = 0;
      svSystem.setBoostMode(false);
    }

    let gamepadGripsPressed = 0;
    let offFlyPressed = false;
    let offTriggerPressed = false;
    let offWristPressed = false;
    let offStickClickPressed = false;
    let domMenuPressed = false;
    let domFacePressed = false;
    let domTriggerPressed = false;
    let domStickX = 0;
    let domStickY = 0;
    let offStickX = 0;
    let offStickY = 0;

    for (const source of session.inputSources) {
      if (!source.gamepad) continue;

      if (source.gamepad.buttons[1]?.pressed) gamepadGripsPressed++;

      if (source.handedness === offHand) {
        if (source.gamepad.buttons[4]?.pressed) offFlyPressed = true;
        if (source.gamepad.buttons[5]?.pressed) offWristPressed = true;
        if (source.gamepad.buttons[3]?.pressed) offStickClickPressed = true;
        if (source.gamepad.buttons[0]?.pressed) offTriggerPressed = true;
        if (source.gamepad.axes.length >= 4) {
          offStickX = source.gamepad.axes[2];
          offStickY = source.gamepad.axes[3];
        }
      }

      if (source.handedness === domHand) {
        if (source.gamepad.buttons[4]?.pressed) domFacePressed = true;
        if (source.gamepad.buttons[5]?.pressed) domMenuPressed = true;
        if (source.gamepad.buttons[0]?.pressed) domTriggerPressed = true;
        if (source.gamepad.axes.length >= 4) {
          domStickX = source.gamepad.axes[2];
          domStickY = source.gamepad.axes[3];
        }
      }
    }

    if (offWristPressed && !wasOffWristPressed) {
      svSystem.toggleWristMap();
      updateWristControllerVisibility();
    }
    wasOffWristPressed = offWristPressed;

    // Off-hand thumbstick click (L3 / R3 in Lefty Mode) snaps globe orientation back to North-up
    if (offStickClickPressed && !wasOffStickClickPressed && !inSV && !searchHUD.isOpen()) {
      state.heading = 0;
      updateGlobeTransform();
    }
    wasOffStickClickPressed = offStickClickPressed;

    if (domMenuPressed && !wasDomMenuPressed) {
      if (welcomeVisible) dismissWelcomeCard();
      searchHUD.toggle();
    }
    wasDomMenuPressed = domMenuPressed;

    // VR Extended 2D Map Stick Controls (Off-Hand Stick Y = Zoom, Dom-Hand Stick = Pan)
    if (searchHUD.isOpen()) {
      searchHUD.handleVRMapStick(offStickY, domStickX, domStickY, dt);
    }

    // Dominant A/X button:
    // - Hovering over wrist minimap: drops a red pin on the 2D wrist map (mutes flight)
    // - In Map Tap: Tap (<0.25s) confirms guess / advances round; Hold (>=0.25s) flies
    // - Free roam: Hold engages ambidextrous Superman Flight
    const wristHovered = !searchHUD.isOpen() && svSystem.isWristHovered();
    const inMapTapActive = games.session.mode === "maptap" && (games.session.phase === "playing" || games.session.phase === "reveal");

    if (domFacePressed && !searchHUD.isOpen()) {
      if (!wasDomConfirmPressed && wristHovered && domCtrlIndex !== -1) {
        if (svSystem.handleVRWristPinDrop(controllers[domCtrlIndex])) {
          domFaceUsedForWrist = true;
        }
      }
      if (!domFaceUsedForWrist) {
        domFaceHoldTime += dt;
      }
    } else {
      if (wasDomConfirmPressed && !domFaceUsedForWrist && !searchHUD.isOpen() && inMapTapActive && domFaceHoldTime < 0.25) {
        if (games.session.phase === "playing" && games.session.pendingGuess) {
          games.submitGuess(games.session.pendingGuess.lat, games.session.pendingGuess.lon);
        } else if (games.session.phase === "reveal") {
          games.nextRound();
        }
      }
      domFaceHoldTime = 0;
      domFaceUsedForWrist = false;
    }
    wasDomConfirmPressed = domFacePressed;

    // Determine active ambidextrous Superman Flight hand (muted on domHand while hovering wrist map)
    const domFlyActive = domFacePressed && !wristHovered && !domFaceUsedForWrist && (!inMapTapActive || domFaceHoldTime >= 0.25);
    const activeFlyHand = !inSV && !searchHUD.isOpen()
      ? (offFlyPressed && offCtrlIndex !== -1 ? offHand : (domFlyActive && domCtrlIndex !== -1 ? domHand : null))
      : null;

    // Wrist-Hovered Stick Zoom: pointing at the wrist minimap makes stick Up/Down zoom the minimap
    if (!searchHUD.isOpen() && wristHovered) {
      const domY = Math.abs(domStickY) > 0.2 ? domStickY : 0;
      const offY = Math.abs(offStickY) > 0.2 ? offStickY : 0;
      const wristZoomY = Math.abs(domY) >= Math.abs(offY) ? domY : offY;
      svSystem.handleVRWristStick(wristZoomY, dt);
    } else if (!inSV && !searchHUD.isOpen() && !activeFlyHand) {
      // Consistent 3D Earth Zoom at ALL altitudes: either thumbstick Up/Down zooms toward dominant laser
      const domY = Math.abs(domStickY) > 0.2 ? domStickY : 0;
      const offY = Math.abs(offStickY) > 0.2 ? offStickY : 0;
      const zoomInputY = Math.abs(domY) >= Math.abs(offY) ? domY : offY;

      if (zoomInputY !== 0) {
        const zFactor = Math.pow(2.2, zoomInputY * dt * 2.2);
        if (domCtrlIndex !== -1) {
          const domCtrl = controllers[domCtrlIndex];
          ctrlTempMat.identity().extractRotation(domCtrl.matrixWorld);
          ctrlRayOrig.setFromMatrixPosition(domCtrl.matrixWorld);
          ctrlRayDir.set(0, 0, -1).applyMatrix4(ctrlTempMat);
          zoomTowardRay(zFactor, ctrlRayOrig, ctrlRayDir);
        } else {
          zoomByFactor(zFactor);
        }
        isMovingThisFrame = true;
      }
    }

    // Hold Either Grip + Move Left/Right (or Both Grips Steering Wheel) rotates North orientation in 3D Earth
    if (!inSV && !searchHUD.isOpen() && activeGrips.size > 0) {
      if (activeGrips.size >= 2) {
        controllers[0].getWorldPosition(currHandPos0);
        controllers[1].getWorldPosition(currHandPos1);
        const gripAngle = Math.atan2(
          currHandPos1.y - currHandPos0.y,
          currHandPos1.x - currHandPos0.x
        );
        if (lastGripWheelAngle !== null) {
          const delta = Math.atan2(
            Math.sin(gripAngle - lastGripWheelAngle),
            Math.cos(gripAngle - lastGripWheelAngle)
          );
          if (Math.abs(delta) > 0.0005) {
            rotateHeading(delta * 1.35);
            isMovingThisFrame = true;
          }
        }
        lastGripWheelAngle = gripAngle;
      } else {
        const gIdx = [...activeGrips][0];
        controllers[gIdx].getWorldPosition(currHandPos0);
        gripDeltaVec.subVectors(currHandPos0, lastGripPositions[gIdx]);
        renderer.xr.getCamera().getWorldQuaternion(xrCamQuatTmp);
        xrCamRightVec.set(1, 0, 0).applyQuaternion(xrCamQuatTmp);
        xrCamRightVec.y = 0;
        if (xrCamRightVec.lengthSq() > 0.0001) xrCamRightVec.normalize();
        const horizMove = gripDeltaVec.dot(xrCamRightVec);
        if (Math.abs(horizMove) > 0.0004) {
          rotateHeading(horizMove * 4.2);
          isMovingThisFrame = true;
        }
        lastGripPositions[gIdx].copy(currHandPos0);
      }
    }

    // Thumbstick Turning:
    // - While Superman Flying: Opposite hand's stick rotates North orientation
    // - In Street View or Horizon / Low-Altitude 3D Earth (< 40 km): Either stick Left/Right looks around
    // - High Orbit (>= 40 km, not flying): Disabled so zooming with sticks never accidentally rotates
    const inHorizonView = !inSV && state.altitude < TILT_START_ALT;
    if (!searchHUD.isOpen() && (inSV || activeFlyHand || inHorizonView)) {
      let turnStickX = 0;
      if (activeFlyHand) {
        turnStickX = activeFlyHand === offHand ? domStickX : offStickX;
      } else {
        turnStickX = Math.abs(domStickX) >= Math.abs(offStickX) ? domStickX : offStickX;
      }
      const turnMode = inSV ? settings.turnSV : settings.turn3D;
      if (turnMode === "snap") {
        if (Math.abs(turnStickX) > 0.65 && snapTurnArmed) {
          const step = Math.sign(turnStickX) * (Math.PI / 4);
          if (inSV) svSystem.rotateStreetView(step);
          else { rotateHeading(step); isMovingThisFrame = true; }
          snapTurnArmed = false;
        } else if (Math.abs(turnStickX) < 0.25) {
          snapTurnArmed = true;
        }
      } else if (Math.abs(turnStickX) > 0.18) {
        const delta = turnStickX * dt * 1.65;
        if (inSV) {
          svSystem.rotateStreetView(delta);
          isMovingThisFrame = true;
        } else {
          rotateHeading(delta);
          isMovingThisFrame = true;
        }
      }
    }

    if (!inSV && !searchHUD.isOpen()) {
      if (activeFlyHand) {
        flightTween = null;
        const flyCtrlIndex = activeFlyHand === offHand ? offCtrlIndex : domCtrlIndex;
        const nowBoost = activeFlyHand === offHand ? offTriggerPressed : domTriggerPressed;
        if (!isFreeFlying || flyingHand !== activeFlyHand || nowBoost !== isBoostFlying) {
          isFreeFlying = true;
          flyingHand = activeFlyHand;
          isBoostFlying = nowBoost;
          updateBeamColors();
        }
        isMovingThisFrame = true;
        flyRamp = Math.min(1.0, flyRamp + dt / 0.35);
        boostRamp = nowBoost
          ? Math.min(1.0, boostRamp + dt / 0.3)
          : Math.max(0.0, boostRamp - dt / 0.25);

        const flyCtrl = controllers[flyCtrlIndex];
        flyCtrl.getWorldDirection(flyWorldDir).negate().normalize();

        invPivotQ.copy(globePivot.quaternion).invert();
        invHeadingQ.copy(headingGroup.quaternion).invert();
        flyWorldDir.applyQuaternion(invPivotQ).applyQuaternion(invHeadingQ).normalize();

        const boostMult = 1.0 + boostRamp * 2.5;
        const flySpeedMeters = Math.max(state.altitude * 0.9, 45) * flyRamp * boostMult * dt;

        moveByEastNorthMeters(flyWorldDir.x * flySpeedMeters, flyWorldDir.y * flySpeedMeters);
        state.altitude = THREE.MathUtils.clamp(
          state.altitude + flyWorldDir.z * flySpeedMeters,
          MIN_ALTITUDE,
          MAX_ALTITUDE
        );
        updateGlobeTransform();
      } else {
        if (isFreeFlying) {
          isFreeFlying = false;
          flyingHand = null;
          isBoostFlying = false;
          flyRamp = 0;
          boostRamp = 0;
          updateBeamColors();
        }

        if (activeTriggers.size === 2) {
          isMovingThisFrame = true;
          controllers[0].getWorldPosition(currHandPos0);
          controllers[1].getWorldPosition(currHandPos1);
          const wheelAngle = Math.atan2(currHandPos1.y - currHandPos0.y, currHandPos1.x - currHandPos0.x);
          if (lastWheelAngle !== null) {
            const delta = Math.atan2(Math.sin(wheelAngle - lastWheelAngle), Math.cos(wheelAngle - lastWheelAngle));
            rotateHeading(delta * 1.25);
          }
          lastWheelAngle = wheelAngle;
        } else if (activeTriggers.size === 1) {
          isMovingThisFrame = true;
          const idx = [...activeTriggers][0];
          controllers[idx].getWorldPosition(currHandPos0);
          const dx = (currHandPos0.x - lastHandPositions[idx].x) * 3.2;
          const dy = (currHandPos0.y - lastHandPositions[idx].y) * 3.2;
          if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
            panByScreenFraction(dx, dy);
            vrDragVelocity.x = dx / Math.max(dt, 0.016);
            vrDragVelocity.y = dy / Math.max(dt, 0.016);
          }
          lastHandPositions[idx].copy(currHandPos0);
        } else if (Math.abs(vrDragVelocity.x) > 0.005 || Math.abs(vrDragVelocity.y) > 0.005) {
          isMovingThisFrame = true;
          panByScreenFraction(vrDragVelocity.x * dt, vrDragVelocity.y * dt);
          const damp = Math.exp(-7.0 * dt);
          vrDragVelocity.x *= damp;
          vrDragVelocity.y *= damp;
        }
      }
    }

    // VR Comfort Vignette Update
    if (settings.vignette) {
      const targetVig = isMovingThisFrame ? 1.0 : 0.0;
      vignetteUniforms.uStrength.value = THREE.MathUtils.lerp(
        vignetteUniforms.uStrength.value,
        targetVig,
        Math.min(1, dt * 10)
      );
      vignetteMesh.visible = vignetteUniforms.uStrength.value > 0.01;
      if (vignetteMesh.visible) {
        const xrCam = renderer.xr.getCamera();
        xrCam.getWorldPosition(vigPos);
        xrCam.getWorldQuaternion(vigQuat);
        vigFwd.set(0, 0, -0.35).applyQuaternion(vigQuat);
        vignetteMesh.position.copy(vigPos).add(vigFwd);
        vignetteMesh.quaternion.copy(vigQuat);
      }
    } else {
      vignetteMesh.visible = false;
      vignetteUniforms.uStrength.value = 0;
    }

    if (inSV && frameCounter % 10 === 0) {
      renderer.xr.getCamera().getWorldDirection(xrLookDir);
      svSystem.updateStreetViewCone(Math.atan2(-xrLookDir.x, -xrLookDir.z));
    }


  }

  if (tiles && !inSV) {
    if (frameCounter % 30 === 0) {
      sampleTerrainElevation();
    }
    convergeGroundElevation(dt);

    if (renderer.xr.isPresenting) {
      tiles.errorTarget = 14;
      const xrCam = renderer.xr.getCamera();
      const eyeCam = xrCam.cameras && xrCam.cameras.length > 0 ? xrCam.cameras[0] : xrCam;
      if (eyeCam !== activeXREyeCam) {
        if (activeXREyeCam) tiles.deleteCamera(activeXREyeCam);
        activeXREyeCam = eyeCam;
        tiles.setCamera(eyeCam);
      }
      eyeCam.updateMatrixWorld();
      tiles.setResolution(eyeCam, 1920, 1920);
      updateScoutCamera(eyeCam);
      tiles.update();
    } else {
      tiles.errorTarget = isMovingThisFrame ? 10 : 6;
      camera.updateMatrixWorld();
      tiles.setCamera(camera);
      tiles.setResolutionFromRenderer(camera, renderer);
      tiles.update();
    }

    skyDome.position.copy(
      renderer.xr.isPresenting ? renderer.xr.getCamera().position : camera.position
    );

    if (frameCounter % 30 === 15) {
      if (!renderer.xr.isPresenting) updateCoordsReadout();
      svSystem.syncFromGlobe(state.lat, state.lon, state.heading, state.altitude, isMovingThisFrame);
      if (renderer.xr.isPresenting) updateWristControllerVisibility();
    }
    if (!renderer.xr.isPresenting && frameCounter % 90 === 0) {
      const attrs = [];
      tiles.getAttributions(attrs);
      const text = attrs.map((a) => a.value).filter(Boolean).join(" • ");
      if (text) attributionEl.textContent = `Google • ${text}`;
    }
  }

  frameCounter++;
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
