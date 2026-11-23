import * as THREE from "three";
import * as topojson from "topojson-client";

const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;
const SURFACE_DIST = 2.0;

const WORLD_TOPO_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";
const US_STATES_TOPO_URL =
  "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";

export function latLonToECEF(latDeg, lonDeg, elevMeters = 0) {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return new THREE.Vector3(
    (N + elevMeters) * cosLat * cosLon,
    (N + elevMeters) * cosLat * sinLon,
    (N * (1 - WGS84_E2) + elevMeters) * sinLat
  );
}

function latLonToUnit(latDeg, lonDeg, out = new THREE.Vector3()) {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const cosLat = Math.cos(lat);
  return out.set(cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat));
}

function buildLineSegmentsFromMultiLine(multiLine, elevMeters, color, opacity) {
  const positions = [];

  for (const ring of multiLine.coordinates) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];

      if (Math.abs(lon2 - lon1) > 180) continue;

      const distDeg = Math.hypot(lon2 - lon1, lat2 - lat1);
      const steps = Math.max(1, Math.ceil(distDeg / 1.5));

      let prev = latLonToECEF(lat1, lon1, elevMeters);
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        const curr = latLonToECEF(
          lat1 + (lat2 - lat1) * f,
          lon1 + (lon2 - lon1) * f,
          elevMeters
        );
        positions.push(prev.x, prev.y, prev.z, curr.x, curr.y, curr.z);
        prev = curr;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );

  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 5;
  lines.frustumCulled = false;
  return lines;
}

function createLabelSprite(text, style, maxAnisotropy = 4) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const fontSize = style.fontSize;
  const fontWeight = style.fontWeight || "700";
  const font = `${fontWeight} ${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  ctx.font = font;
  const metrics = ctx.measureText(text);
  const dotSpace = style.showDot ? fontSize * 0.65 : 0;
  const padX = Math.ceil(fontSize * 0.45);
  const padY = Math.ceil(fontSize * 0.35);

  canvas.width = Math.ceil(metrics.width + dotSpace + padX * 2);
  canvas.height = Math.ceil(fontSize * 1.4 + padY * 2);

  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const centerY = canvas.height / 2;
  let textX = padX;

  if (style.showDot) {
    const dotR = fontSize * 0.14;
    const dotX = padX + dotR + 4;
    ctx.beginPath();
    ctx.arc(dotX, centerY, dotR + 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(dotX, centerY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    textX = padX + dotSpace;
  }

  ctx.lineJoin = "round";
  ctx.lineWidth = style.strokeWidth || 18;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.88)";
  ctx.strokeText(text, textX, centerY);

  ctx.fillStyle = style.color || "#ffffff";
  ctx.fillText(text, textX, centerY);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = maxAnisotropy;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false
  });

  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 20;
  sprite.userData = {
    aspect: canvas.width / canvas.height,
    vrHeight: style.vrHeight
  };
  return sprite;
}

function smoothRangeFade(alt, minOut, minFull, maxFull, maxOut) {
  if (alt <= minOut || alt >= maxOut) return 0;
  if (alt < minFull) {
    const t = (alt - minOut) / (minFull - minOut);
    return t * t * (3 - 2 * t);
  }
  if (alt > maxFull) {
    const t = (maxOut - alt) / (maxOut - maxFull);
    return t * t * (3 - 2 * t);
  }
  return 1;
}

function getFeatureCenter(feature) {
  const geom = feature.geometry;
  if (!geom) return null;

  let rings = [];
  if (geom.type === "Polygon") {
    rings = [geom.coordinates[0]];
  } else if (geom.type === "MultiPolygon") {
    rings = geom.coordinates.map((poly) => poly[0]);
  }
  if (rings.length === 0) return null;

  let bestRing = rings[0];
  let bestArea = -1;

  for (const ring of rings) {
    let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const spanLon = maxLon - minLon;
    if (spanLon > 180) continue;
    const area = spanLon * (maxLat - minLat);
    if (area > bestArea) {
      bestArea = area;
      bestRing = ring;
    }
  }

  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  for (const [lon, lat] of bestRing) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return {
    lat: (minLat + maxLat) / 2,
    lon: (minLon + maxLon) / 2,
    size: Math.hypot(maxLon - minLon, maxLat - minLat)
  };
}

const COUNTRY_CENTER_OVERRIDES = {
  "United States of America": { name: "United States", lat: 39.5, lon: -98.5 },
  "Russia": { name: "Russia", lat: 61.5, lon: 95.0 },
  "Canada": { name: "Canada", lat: 56.1, lon: -106.3 },
  "France": { name: "France", lat: 46.6, lon: 2.4 },
  "Norway": { name: "Norway", lat: 61.5, lon: 8.5 },
  "Indonesia": { name: "Indonesia", lat: -2.2, lon: 117.5 },
  "Japan": { name: "Japan", lat: 36.2, lon: 138.3 },
  "Chile": { name: "Chile", lat: -35.7, lon: -71.5 },
  "Malaysia": { name: "Malaysia", lat: 4.2, lon: 102.0 },
  "New Zealand": { name: "New Zealand", lat: -41.5, lon: 172.5 },
  "Dem. Rep. Congo": { name: "DR Congo", lat: -2.9, lon: 23.6 },
  "Central African Rep.": { name: "Central African Rep.", lat: 6.6, lon: 20.9 },
  "Bosnia and Herz.": { name: "Bosnia & Herz.", lat: 44.1, lon: 17.8 },
  "Dominican Rep.": { name: "Dominican Rep.", lat: 18.9, lon: -70.2 }
};

const US_STATES = [
  ["ALABAMA", 32.8, -86.8], ["ALASKA", 64.2, -152.5], ["ARIZONA", 34.3, -111.7],
  ["ARKANSAS", 34.9, -92.4], ["CALIFORNIA", 37.2, -119.5], ["COLORADO", 39.0, -105.5],
  ["CONNECTICUT", 41.6, -72.7], ["DELAWARE", 39.0, -75.5], ["FLORIDA", 28.6, -82.4],
  ["GEORGIA", 32.7, -83.4], ["HAWAII", 20.8, -156.3], ["IDAHO", 44.4, -114.6],
  ["ILLINOIS", 40.0, -89.2], ["INDIANA", 39.9, -86.3], ["IOWA", 42.0, -93.5],
  ["KANSAS", 38.5, -98.4], ["KENTUCKY", 37.5, -85.3], ["LOUISIANA", 31.0, -92.0],
  ["MAINE", 45.3, -69.2], ["MARYLAND", 39.0, -76.7], ["MASSACHUSETTS", 42.3, -71.8],
  ["MICHIGAN", 44.3, -85.4], ["MINNESOTA", 46.3, -94.3], ["MISSISSIPPI", 32.7, -89.7],
  ["MISSOURI", 38.4, -92.5], ["MONTANA", 47.0, -109.6], ["NEBRASKA", 41.5, -99.8],
  ["NEVADA", 39.3, -116.6], ["NEW HAMPSHIRE", 43.7, -71.6], ["NEW JERSEY", 40.1, -74.7],
  ["NEW MEXICO", 34.4, -106.1], ["NEW YORK", 42.9, -75.5], ["NORTH CAROLINA", 35.6, -79.4],
  ["NORTH DAKOTA", 47.4, -100.5], ["OHIO", 40.3, -82.8], ["OKLAHOMA", 35.6, -97.5],
  ["OREGON", 44.0, -120.5], ["PENNSYLVANIA", 40.9, -77.8], ["RHODE ISLAND", 41.7, -71.5],
  ["SOUTH CAROLINA", 33.9, -80.9], ["SOUTH DAKOTA", 44.4, -100.2], ["TENNESSEE", 35.8, -86.4],
  ["TEXAS", 31.5, -99.3], ["UTAH", 39.3, -111.7], ["VERMONT", 44.1, -72.7],
  ["VIRGINIA", 37.5, -78.8], ["WASHINGTON", 47.4, -120.5], ["WEST VIRGINIA", 38.6, -80.6],
  ["WISCONSIN", 44.6, -89.7], ["WYOMING", 43.0, -107.5]
];

export const CITIES = [
  ["New York", 40.71, -74.01, 1], ["Los Angeles", 34.05, -118.24, 1],
  ["Chicago", 41.88, -87.63, 1], ["Houston", 29.76, -95.37, 1],
  ["Phoenix", 33.45, -112.07, 1], ["San Francisco", 37.77, -122.42, 1],
  ["Seattle", 47.61, -122.33, 1], ["Denver", 39.74, -104.99, 1],
  ["Miami", 25.76, -80.19, 1], ["Atlanta", 33.75, -84.39, 1],
  ["Dallas", 32.78, -96.80, 1], ["Washington, D.C.", 38.91, -77.04, 1],
  ["Boston", 42.36, -71.06, 1], ["Las Vegas", 36.17, -115.14, 1],
  ["Minneapolis", 44.98, -93.27, 1], ["Anchorage", 61.22, -149.90, 1],
  ["Honolulu", 21.31, -157.86, 1], ["Toronto", 43.65, -79.38, 1],
  ["Vancouver", 49.28, -123.12, 1], ["Mexico City", 19.43, -99.13, 1],
  ["Havana", 23.11, -82.37, 1],

  ["Portland", 45.52, -122.68, 2], ["Salt Lake City", 40.76, -111.89, 2],
  ["Colorado Springs", 38.83, -104.82, 2], ["Sacramento", 38.58, -121.49, 2],
  ["San Diego", 32.72, -117.16, 2], ["Boise", 43.62, -116.20, 2],
  ["Spokane", 47.66, -117.43, 2], ["Billings", 45.78, -108.50, 2],
  ["Bozeman", 45.68, -111.04, 2], ["Albuquerque", 35.08, -106.65, 2],
  ["Austin", 30.27, -97.74, 2], ["San Antonio", 29.42, -98.49, 2],
  ["Kansas City", 39.10, -94.58, 2], ["St. Louis", 38.63, -90.20, 2],
  ["Nashville", 36.16, -86.78, 2], ["New Orleans", 29.95, -90.07, 2],
  ["Detroit", 42.33, -83.05, 2], ["Philadelphia", 39.95, -75.17, 2],
  ["Charlotte", 35.23, -80.84, 2], ["Orlando", 28.54, -81.38, 2],
  ["Tampa", 27.95, -82.46, 2], ["Pittsburgh", 40.44, -80.00, 2],
  ["Columbus", 39.96, -83.00, 2], ["Indianapolis", 39.77, -86.16, 2],
  ["Milwaukee", 43.04, -87.91, 2], ["Omaha", 41.26, -95.93, 2],
  ["Des Moines", 41.59, -93.62, 2], ["Oklahoma City", 35.47, -97.52, 2],
  ["Memphis", 35.15, -90.05, 2], ["Raleigh", 35.78, -78.64, 2],
  ["El Paso", 31.76, -106.49, 2], ["Tucson", 32.22, -110.97, 2],
  ["Reno", 39.53, -119.81, 2], ["Fargo", 46.88, -96.79, 2],
  ["Cheyenne", 41.14, -104.82, 2], ["Montreal", 45.50, -73.57, 2],
  ["Ottawa", 45.42, -75.70, 2], ["Calgary", 51.05, -114.07, 2],
  ["Edmonton", 53.54, -113.49, 2], ["Winnipeg", 49.90, -97.14, 2],
  ["Halifax", 44.65, -63.57, 2], ["Guadalajara", 20.66, -103.35, 2],
  ["Monterrey", 25.69, -100.32, 2], ["Cancún", 21.16, -86.85, 2],
  ["Guatemala City", 14.63, -90.51, 2], ["San José", 9.93, -84.09, 2],
  ["Panama City", 8.98, -79.52, 2], ["Santo Domingo", 18.49, -69.93, 2],
  ["San Juan", 18.47, -66.11, 2], ["Kingston", 18.00, -76.79, 2],

  ["São Paulo", -23.55, -46.63, 1], ["Rio de Janeiro", -22.91, -43.17, 1],
  ["Buenos Aires", -34.60, -58.38, 1], ["Lima", -12.05, -77.04, 1],
  ["Bogotá", 4.71, -74.07, 1], ["Santiago", -33.45, -70.67, 1],
  ["Caracas", 10.48, -66.90, 2], ["Quito", -0.18, -78.47, 2],
  ["La Paz", -16.50, -68.15, 2], ["Asunción", -25.26, -57.58, 2],
  ["Montevideo", -34.90, -56.16, 2], ["Brasília", -15.79, -47.88, 2],
  ["Salvador", -12.97, -38.50, 2], ["Manaus", -3.12, -60.02, 2],
  ["Medellín", 6.24, -75.58, 2], ["Córdoba", -31.42, -64.18, 2],

  ["London", 51.51, -0.13, 1], ["Paris", 48.86, 2.35, 1],
  ["Berlin", 52.52, 13.40, 1], ["Madrid", 40.42, -3.70, 1],
  ["Rome", 41.90, 12.50, 1], ["Amsterdam", 52.37, 4.90, 1],
  ["Moscow", 55.76, 37.62, 1], ["Istanbul", 41.01, 28.98, 1],
  ["Dublin", 53.35, -6.26, 2], ["Edinburgh", 55.95, -3.19, 2],
  ["Manchester", 53.48, -2.24, 2], ["Lisbon", 38.72, -9.14, 2],
  ["Barcelona", 41.39, 2.17, 2], ["Marseille", 43.30, 5.37, 2],
  ["Lyon", 45.76, 4.84, 2], ["Brussels", 50.85, 4.35, 2],
  ["Zurich", 47.37, 8.54, 2], ["Geneva", 46.20, 6.14, 2],
  ["Munich", 48.14, 11.58, 2], ["Hamburg", 53.55, 9.99, 2],
  ["Frankfurt", 50.11, 8.68, 2], ["Milan", 45.46, 9.19, 2],
  ["Naples", 40.85, 14.27, 2], ["Venice", 45.44, 12.32, 2],
  ["Vienna", 48.21, 16.37, 2], ["Prague", 50.08, 14.44, 2],
  ["Warsaw", 52.23, 21.01, 2], ["Kraków", 50.06, 19.94, 2],
  ["Budapest", 47.50, 19.04, 2], ["Bucharest", 44.43, 26.10, 2],
  ["Sofia", 42.70, 23.32, 2], ["Belgrade", 44.79, 20.45, 2],
  ["Zagreb", 45.81, 15.98, 2], ["Sarajevo", 43.86, 18.41, 2],
  ["Athens", 37.98, 23.73, 2], ["Thessaloniki", 40.64, 22.94, 2],
  ["Copenhagen", 55.68, 12.57, 2], ["Stockholm", 59.33, 18.07, 2],
  ["Oslo", 59.91, 10.75, 2], ["Helsinki", 60.17, 24.94, 2],
  ["Reykjavik", 64.15, -21.94, 2], ["Tallinn", 59.44, 24.75, 2],
  ["Riga", 56.95, 24.11, 2], ["Vilnius", 54.69, 25.28, 2],
  ["Minsk", 53.90, 27.56, 2], ["Kyiv", 50.45, 30.52, 2],
  ["Odesa", 46.48, 30.72, 2], ["Saint Petersburg", 59.93, 30.34, 2],

  ["Cairo", 30.04, 31.24, 1], ["Lagos", 6.52, 3.38, 1],
  ["Johannesburg", -26.20, 28.05, 1], ["Cape Town", -33.92, 18.42, 1],
  ["Nairobi", -1.29, 36.82, 1], ["Casablanca", 33.57, -7.59, 2],
  ["Algiers", 36.75, 3.06, 2], ["Tunis", 36.81, 10.18, 2],
  ["Tripoli", 32.89, 13.19, 2], ["Alexandria", 31.20, 29.92, 2],
  ["Khartoum", 15.50, 32.56, 2], ["Addis Ababa", 9.03, 38.74, 2],
  ["Dakar", 14.72, -17.47, 2], ["Accra", 5.60, -0.19, 2],
  ["Abidjan", 5.36, -4.01, 2], ["Kinshasa", -4.44, 15.27, 2],
  ["Luanda", -8.84, 13.23, 2], ["Dar es Salaam", -6.79, 39.21, 2],
  ["Kampala", 0.35, 32.58, 2], ["Kigali", -1.94, 30.06, 2],
  ["Lusaka", -15.39, 28.32, 2], ["Harare", -17.83, 31.05, 2],
  ["Maputo", -25.97, 32.57, 2], ["Antananarivo", -18.88, 47.51, 2],

  ["Dubai", 25.20, 55.27, 1], ["Riyadh", 24.71, 46.68, 1],
  ["Tehran", 35.69, 51.39, 1], ["Ankara", 39.93, 32.86, 2],
  ["Baghdad", 33.31, 44.37, 2], ["Damascus", 33.51, 36.29, 2],
  ["Amman", 31.95, 35.93, 2], ["Jerusalem", 31.77, 35.21, 2],
  ["Tel Aviv", 32.09, 34.78, 2], ["Beirut", 33.89, 35.50, 2],
  ["Jeddah", 21.49, 39.19, 2], ["Doha", 25.29, 51.53, 2],
  ["Kuwait City", 29.38, 47.98, 2], ["Muscat", 23.59, 58.38, 2],
  ["Baku", 40.41, 49.87, 2], ["Tbilisi", 41.72, 44.83, 2],
  ["Yerevan", 40.18, 44.51, 2], ["Almaty", 43.24, 76.89, 2],
  ["Tashkent", 41.30, 69.24, 2], ["Kabul", 34.56, 69.21, 2],

  ["Tokyo", 35.68, 139.69, 1], ["Seoul", 37.57, 126.98, 1],
  ["Beijing", 39.90, 116.41, 1], ["Shanghai", 31.23, 121.47, 1],
  ["Hong Kong", 22.32, 114.17, 1], ["Singapore", 1.35, 103.82, 1],
  ["Mumbai", 19.08, 72.88, 1], ["New Delhi", 28.61, 77.21, 1],
  ["Bangkok", 13.76, 100.50, 1], ["Jakarta", -6.21, 106.85, 1],
  ["Manila", 14.60, 120.98, 1], ["Karachi", 24.86, 67.00, 1],
  ["Osaka", 34.69, 135.50, 2], ["Sapporo", 43.06, 141.35, 2],
  ["Busan", 35.18, 129.08, 2], ["Taipei", 25.03, 121.57, 2],
  ["Guangzhou", 23.13, 113.26, 2], ["Shenzhen", 22.54, 114.06, 2],
  ["Chengdu", 30.57, 104.07, 2], ["Chongqing", 29.56, 106.55, 2],
  ["Xi'an", 34.34, 108.94, 2], ["Ulaanbaatar", 47.89, 106.91, 2],
  ["Hanoi", 21.03, 105.85, 2], ["Ho Chi Minh City", 10.82, 106.63, 2],
  ["Kuala Lumpur", 3.14, 101.69, 2], ["Yangon", 16.87, 96.20, 2],
  ["Phnom Penh", 11.56, 104.92, 2], ["Dhaka", 23.81, 90.41, 2],
  ["Kolkata", 22.57, 88.36, 2], ["Bengaluru", 12.97, 77.59, 2],
  ["Chennai", 13.08, 80.27, 2], ["Hyderabad", 17.39, 78.49, 2],
  ["Kathmandu", 27.72, 85.32, 2], ["Colombo", 6.93, 79.86, 2],
  ["Lahore", 31.52, 74.36, 2], ["Islamabad", 33.68, 73.05, 2],
  ["Novosibirsk", 55.01, 82.93, 2], ["Vladivostok", 43.12, 131.89, 2],

  ["Sydney", -33.87, 151.21, 1], ["Melbourne", -37.81, 144.96, 1],
  ["Auckland", -36.85, 174.76, 1], ["Brisbane", -27.47, 153.03, 2],
  ["Perth", -31.95, 115.86, 2], ["Adelaide", -34.93, 138.60, 2],
  ["Wellington", -41.29, 174.78, 2], ["Christchurch", -43.53, 172.64, 2],
  ["Port Moresby", -9.44, 147.18, 2], ["Suva", -18.14, 178.44, 2]
];

export function createBoundariesOverlay(maxAnisotropy = 8) {
  const group = new THREE.Group();
  let enabled = true;
  let forceHidden = false;

  let countryLines = null;
  let usStateLines = null;

  const labelGroups = {
    countriesLarge: [],
    countriesSmall: [],
    states: [],
    citiesT1: [],
    citiesT2: []
  };

  function addLabelItem(list, name, lat, lon, elev, style) {
    const sprite = createLabelSprite(name, style, maxAnisotropy);
    sprite.position.copy(latLonToECEF(lat, lon, elev));
    group.add(sprite);
    list.push({
      sprite,
      normal: latLonToUnit(lat, lon)
    });
  }

  for (const [name, lat, lon] of US_STATES) {
    addLabelItem(labelGroups.states, name, lat, lon, 9000, {
      fontSize: 84,
      fontWeight: "700",
      color: "#e2e8f0",
      strokeWidth: 18,
      vrHeight: 0.056,
      showDot: false
    });
  }

  for (const [name, lat, lon, tier] of CITIES) {
    const isT1 = tier === 1;
    addLabelItem(
      isT1 ? labelGroups.citiesT1 : labelGroups.citiesT2,
      name,
      lat,
      lon,
      6500,
      {
        fontSize: isT1 ? 92 : 82,
        fontWeight: isT1 ? "700" : "600",
        color: "#ffffff",
        strokeWidth: 18,
        vrHeight: isT1 ? 0.062 : 0.052,
        showDot: true
      }
    );
  }

  fetch(WORLD_TOPO_URL)
    .then((r) => r.json())
    .then((topo) => {
      const mesh = topojson.mesh(topo, topo.objects.countries);
      countryLines = buildLineSegmentsFromMultiLine(mesh, 6000, 0xffffff, 0.52);
      group.add(countryLines);

      const features = topojson.feature(topo, topo.objects.countries).features;
      const seenNames = new Set();

      for (const feat of features) {
        const rawName = feat.properties?.name;
        if (!rawName || rawName === "Antarctica" || seenNames.has(rawName)) continue;
        seenNames.add(rawName);

        const center = getFeatureCenter(feat);
        if (!center) continue;

        const override = COUNTRY_CENTER_OVERRIDES[rawName];
        const labelName = override ? override.name : rawName;
        const lat = override ? override.lat : center.lat;
        const lon = override ? override.lon : center.lon;

        const isLarge = center.size >= 5.0 || Boolean(override);
        addLabelItem(
          isLarge ? labelGroups.countriesLarge : labelGroups.countriesSmall,
          labelName,
          lat,
          lon,
          12000,
          {
            fontSize: isLarge ? 108 : 84,
            fontWeight: "700",
            color: "#f8fafc",
            strokeWidth: isLarge ? 22 : 18,
            vrHeight: isLarge ? 0.076 : 0.056,
            showDot: false
          }
        );
      }
    })
    .catch((err) => console.warn("Could not load world borders:", err));

  fetch(US_STATES_TOPO_URL)
    .then((r) => r.json())
    .then((topo) => {
      const mesh = topojson.mesh(topo, topo.objects.states, (a, b) => a !== b);
      usStateLines = buildLineSegmentsFromMultiLine(mesh, 4500, 0xe2e8f0, 0.36);
      group.add(usStateLines);
    })
    .catch((err) => console.warn("Could not load US state borders:", err));

  const centerNormal = new THREE.Vector3();

  function updateLabelList(list, opacity, alt, minDot) {
    const showAny = enabled && !forceHidden && opacity > 0.01;
    const meterScale = alt / SURFACE_DIST;

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!showAny) {
        item.sprite.visible = false;
        continue;
      }

      const dot = item.normal.dot(centerNormal);
      if (dot < minDot) {
        item.sprite.visible = false;
        continue;
      }

      const limbFade = THREE.MathUtils.clamp((dot - minDot) / 0.14, 0, 1);
      item.sprite.visible = true;
      item.sprite.material.opacity = opacity * limbFade;

      const h = item.sprite.userData.vrHeight * meterScale;
      item.sprite.scale.set(h * item.sprite.userData.aspect, h, 1);
    }
  }

  let lastUpdLat = null;
  let lastUpdLon = null;
  let lastUpdAlt = null;

  function update(lat, lon, alt, force = false) {
    const visible = enabled && !forceHidden && alt > 20000;
    const wasVisible = group.visible;
    group.visible = visible;
    if (!visible) {
      lastUpdLat = null;
      return;
    }

    if (
      !force &&
      wasVisible &&
      lastUpdLat !== null &&
      Math.hypot(lat - lastUpdLat, lon - lastUpdLon) < Math.max(0.08, alt / 60000000) &&
      Math.abs(alt - lastUpdAlt) < alt * 0.04
    ) {
      return;
    }
    lastUpdLat = lat;
    lastUpdLon = lon;
    lastUpdAlt = alt;

    const countryBorderAlpha =
      smoothRangeFade(alt, 25000, 90000, 20000000, 25000000) * 0.52;
    if (countryLines) {
      countryLines.visible = countryBorderAlpha > 0.01;
      countryLines.material.opacity = countryBorderAlpha;
    }

    const stateBorderAlpha =
      smoothRangeFade(alt, 20000, 70000, 4200000, 7000000) * 0.38;
    if (usStateLines) {
      usStateLines.visible = stateBorderAlpha > 0.01;
      usStateLines.material.opacity = stateBorderAlpha;
    }

    latLonToUnit(lat, lon, centerNormal);
    const horizonCos = WGS84_A / (WGS84_A + alt);
    const minDot = Math.max(0.36, horizonCos + 0.04);

    const largeCountryAlpha = smoothRangeFade(alt, 450000, 1200000, 18000000, 25000000);
    const smallCountryAlpha = smoothRangeFade(alt, 120000, 350000, 4500000, 7500000);
    const stateLabelAlpha = smoothRangeFade(alt, 150000, 380000, 2800000, 4800000);
    const cityT1Alpha = smoothRangeFade(alt, 35000, 100000, 5500000, 9000000);
    const cityT2Alpha = smoothRangeFade(alt, 25000, 70000, 1800000, 3200000);

    updateLabelList(labelGroups.countriesLarge, largeCountryAlpha, alt, minDot);
    updateLabelList(labelGroups.countriesSmall, smallCountryAlpha, alt, minDot);
    updateLabelList(labelGroups.states, stateLabelAlpha, alt, minDot);
    updateLabelList(labelGroups.citiesT1, cityT1Alpha, alt, minDot);
    updateLabelList(labelGroups.citiesT2, cityT2Alpha, alt, minDot);
  }

  function toggle() {
    enabled = !enabled;
    group.visible = enabled && !forceHidden;
    lastUpdLat = null;
    return enabled;
  }

  function setForceHidden(hidden) {
    forceHidden = hidden;
    group.visible = enabled && !forceHidden;
    lastUpdLat = null;
  }

  return { group, update, toggle, setForceHidden };
}
