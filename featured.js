// Curated Featured Places for Zinthorr's World
// Each entry has: name, category, lat, lon, alt (3D globe arrival altitude in meters), blurb
export const FEATURED_PLACES = [
  // Iconic Cities & Skylines
  { name: "Manhattan & Central Park, NY", category: "Cities", lat: 40.7685, lon: -73.9818, alt: 650, blurb: "Dense skyscrapers & park canopy" },
  { name: "Shibuya & Tokyo Tower, Japan", category: "Cities", lat: 35.6586, lon: 139.7454, alt: 550, blurb: "Massive 3D cityscape & Street View" },
  { name: "Eiffel Tower, Paris", category: "Cities", lat: 48.8584, lon: 2.2945, alt: 450, blurb: "Classic low-altitude flight spot" },
  { name: "Burj Khalifa, Dubai", category: "Cities", lat: 25.1972, lon: 55.2744, alt: 900, blurb: "Extreme vertical scale in VR" },
  { name: "Golden Gate Bridge, SF", category: "Cities", lat: 37.8199, lon: -122.4783, alt: 600, blurb: "Bay, bridge towers & headlands" },
  { name: "Sydney Opera House, Australia", category: "Cities", lat: -33.8568, lon: 151.2153, alt: 450, blurb: "Crisp waterfront 3D tiles" },
  { name: "St. Mark's Square, Venice", category: "Cities", lat: 45.4342, lon: 12.3388, alt: 350, blurb: "Intricate canals & rooftops" },
  { name: "Christ the Redeemer, Rio", category: "Cities", lat: -22.9519, lon: -43.2105, alt: 550, blurb: "Peak overlooking Guanabara Bay" },

  // Mountains, Canyons & Natural Wonders
  { name: "Grand Canyon (South Rim), AZ", category: "Nature", lat: 36.0544, lon: -112.1401, alt: 1400, blurb: "Huge vertical drop for Superman Flight" },
  { name: "Matterhorn & Zermatt, Switzerland", category: "Nature", lat: 45.9763, lon: 7.6586, alt: 1800, blurb: "Alpine peak & village below" },
  { name: "Yosemite Valley (Half Dome), CA", category: "Nature", lat: 37.7459, lon: -119.5332, alt: 1400, blurb: "Sheer granite cliffs" },
  { name: "Mount Fuji, Japan", category: "Nature", lat: 35.3606, lon: 138.7274, alt: 2800, blurb: "Iconic cone & surrounding lakes" },
  { name: "Santorini (Oia), Greece", category: "Nature", lat: 36.4618, lon: 25.3753, alt: 450, blurb: "Cliffside village over the caldera" },
  { name: "Niagara Falls, US / Canada", category: "Nature", lat: 43.0799, lon: -79.0747, alt: 550, blurb: "Great in 3D Earth & Street View" },

  // Historic Landmarks
  { name: "Pyramids of Giza, Egypt", category: "Historic", lat: 29.9792, lon: 31.1342, alt: 550, blurb: "Desert plateau next to Cairo" },
  { name: "The Colosseum, Rome", category: "Historic", lat: 41.8902, lon: 12.4922, alt: 380, blurb: "Ancient ruins & modern streets" },
  { name: "Machu Picchu, Peru", category: "Historic", lat: -13.1631, lon: -72.5450, alt: 700, blurb: "Mountain ridge Incan citadel" },
  { name: "Stonehenge, United Kingdom", category: "Historic", lat: 51.1789, lon: -1.8262, alt: 280, blurb: "Clean 3D terrain & walkable SV" }
];

export function getRandomLuckyPlace() {
  return FEATURED_PLACES[Math.floor(Math.random() * FEATURED_PLACES.length)];
}
