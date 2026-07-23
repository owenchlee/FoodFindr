let map;
let markersById = {};
let pinDropActive = false;
let originMarker = null;
let infoWindow = null;

// Matches the default search radius (3 mi) closely enough that a fresh
// search's results land within the viewport without the user having to
// manually zoom out.
const DEFAULT_ZOOM = 14;

function initMap(center, mapId) {
  map = new google.maps.Map(document.getElementById('map'), {
    center,
    zoom: DEFAULT_ZOOM,
    mapId: mapId || undefined,
    colorScheme: google.maps.ColorScheme.DARK,
    mapTypeControl: false,
    fullscreenControl: false
  });

  map.addListener('click', (event) => {
    if (!pinDropActive) return;
    const lat = event.latLng.lat();
    const lng = event.latLng.lng();
    disablePinDrop();
    setOriginMarker(lat, lng);
    if (typeof onLocationPicked === 'function') onLocationPicked(lat, lng, 'pin');
  });
}

function enablePinDrop() {
  if (!map) return;
  pinDropActive = true;
  map.setOptions({ draggableCursor: 'crosshair' });
}

function disablePinDrop() {
  if (!map) return;
  pinDropActive = false;
  map.setOptions({ draggableCursor: null });
}

// The one persistent "you are here" marker, set from every path that
// establishes a real search location: GPS fix, a remembered last location,
// or a manually searched/dropped one. Always the same blue dot so it reads
// as one consistent concept regardless of how the location was obtained.
function setOriginMarker(lat, lng) {
  if (!map) return;
  if (originMarker) originMarker.map = null;
  const div = document.createElement('div');
  div.className = 'marker marker--origin';
  originMarker = new google.maps.marker.AdvancedMarkerElement({
    map,
    position: { lat, lng },
    content: div,
    title: 'Your search location'
  });
}

function clearOriginMarker() {
  if (originMarker) {
    originMarker.map = null;
    originMarker = null;
  }
}


// Called whenever a new search location is established (GPS fix, geocoded
// search, or falling back to the last remembered location). Always resets
// zoom back to DEFAULT_ZOOM, since a previous recommendation pick
// (centerOnPick, below) may have left the map zoomed in tight on a single
// restaurant; without this, switching locations afterward would silently
// keep that tight zoom and hide most of the new search's results offscreen.
function recenterMap(lat, lng) {
  if (!map) return;
  map.setCenter({ lat, lng });
  map.setZoom(DEFAULT_ZOOM);
}

function centerOnPick(lat, lng) {
  if (!map) return;
  map.panTo({ lat, lng });
  if (map.getZoom() < 16) map.setZoom(16);
}

function markerContent(restaurant, isPick) {
  const div = document.createElement('div');
  div.className = isPick ? 'marker marker--pick' : 'marker';
  return div;
}

// The native `title` attribute's hover tooltip is browser/OS-rendered, so we
// can't restyle it, and it comes out small and low-contrast, especially on
// mobile. This builds a fully custom-styled popup instead, shown on click.
function showRestaurantInfo(restaurant) {
  if (!infoWindow) infoWindow = new google.maps.InfoWindow({ disableAutoPan: false });

  const div = document.createElement('div');
  div.className = 'map-info-window';

  const name = document.createElement('div');
  name.className = 'map-info-name';
  name.textContent = restaurant.name;
  div.appendChild(name);

  const metaParts = [];
  if (restaurant.cuisine) metaParts.push(restaurant.cuisine);
  if (restaurant.price) metaParts.push('$'.repeat(restaurant.price));
  if (restaurant.rating) metaParts.push(`★ ${restaurant.rating}`);
  if (metaParts.length > 0) {
    const meta = document.createElement('div');
    meta.className = 'map-info-meta';
    meta.textContent = metaParts.join(' · ');
    div.appendChild(meta);
  }

  infoWindow.setContent(div);
  infoWindow.setPosition({ lat: restaurant.lat, lng: restaurant.lng });
  infoWindow.open(map);
}

function renderMarkers(restaurants) {
  if (!map) return;

  Object.values(markersById).forEach(marker => { marker.map = null; });
  markersById = {};

  restaurants.forEach(restaurant => {
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position: { lat: restaurant.lat, lng: restaurant.lng },
      content: markerContent(restaurant, false),
      title: `${restaurant.name} · ${'$'.repeat(restaurant.price)}`
    });
    marker.addListener('click', () => showRestaurantInfo(restaurant));
    markersById[restaurant.id] = marker;
  });
}

function highlightPick(pickId, restaurants) {
  if (!map) return;

  Object.entries(markersById).forEach(([id, marker]) => {
    const restaurant = restaurants.find(r => r.id === id);
    if (restaurant) {
      marker.content = markerContent(restaurant, id === pickId);
    }
  });
}
