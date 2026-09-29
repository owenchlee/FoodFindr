let map;
let markersById = {};
// Markers removed by a search, kept off-map for the next search to reuse
// (see renderMarkers) instead of constructing new AdvancedMarkerElements.
const markerPool = [];
let pickedMarkerId = null;
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

// Diffs against the currently-rendered set instead of tearing everything down
// and rebuilding it, so calling this a second time per search (phase-1 markers,
// then phase-2 topping up 20 -> ~57, see loadRestaurants) doesn't flicker or
// redo synchronous marker-construction work for the ~20 that didn't change.
// Markers that leave the set are parked in markerPool and re-pointed at new
// restaurants later, so a search in a new area moves existing marker
// elements rather than building ~60 fresh ones.
function renderMarkers(restaurants) {
  if (!map) return;

  const nextIds = new Set(restaurants.map(r => r.id));
  Object.entries(markersById).forEach(([id, marker]) => {
    if (!nextIds.has(id)) {
      marker.map = null;
      if (pickedMarkerId === id) {
        marker.content.classList.remove('marker--pick');
        marker.zIndex = null;
        pickedMarkerId = null;
      }
      delete markersById[id];
      markerPool.push(marker);
    }
  });

  restaurants.forEach(restaurant => {
    const existing = markersById[restaurant.id];
    if (existing) {
      existing.ffRestaurant = restaurant; // same place, possibly fresher data
      return;
    }
    let marker = markerPool.pop();
    if (marker) {
      marker.position = { lat: restaurant.lat, lng: restaurant.lng };
      marker.title = markerTitle(restaurant);
      marker.map = map;
    } else {
      marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: restaurant.lat, lng: restaurant.lng },
        content: markerContent(restaurant, false),
        title: markerTitle(restaurant),
        gmpClickable: true
      });
      // Reads the marker's current restaurant, since pooled markers get
      // re-pointed at different places over their lifetime.
      marker.addEventListener('gmp-click', () => {
        if (typeof haptics !== 'undefined') haptics.selection();
        showRestaurantInfo(marker.ffRestaurant);
      });
    }
    marker.ffRestaurant = restaurant;
    markersById[restaurant.id] = marker;
  });
}

function markerTitle(restaurant) {
  return `${restaurant.name} · ${'$'.repeat(restaurant.price)}`;
}

// Restyles just the previous and the new pick, instead of rebuilding the
// content element of every marker on the map.
function highlightPick(pickId) {
  if (!map) return;
  const previous = pickedMarkerId && markersById[pickedMarkerId];
  const next = markersById[pickId];
  if (previous && previous !== next) {
    previous.content.classList.remove('marker--pick');
    previous.zIndex = null;
  }
  if (next) {
    next.content.classList.add('marker--pick');
    next.zIndex = 1000; // keep the pick above its neighbours
  }
  pickedMarkerId = next ? pickId : null;
}
