let map;
let markersById = {};
let pinDropActive = false;
let dropMarker = null;

function initMap(center, mapId) {
  map = new google.maps.Map(document.getElementById('map'), {
    center,
    zoom: 14,
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
    setDropMarker(lat, lng);
    if (typeof onLocationPicked === 'function') onLocationPicked(lat, lng);
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

function setDropMarker(lat, lng) {
  if (!map) return;
  if (dropMarker) dropMarker.map = null;
  const div = document.createElement('div');
  div.className = 'marker marker--dropped';
  dropMarker = new google.maps.marker.AdvancedMarkerElement({
    map,
    position: { lat, lng },
    content: div,
    title: 'Search location'
  });
}

function clearDropMarker() {
  if (dropMarker) {
    dropMarker.map = null;
    dropMarker = null;
  }
}


function recenterMap(lat, lng) {
  if (map) map.setCenter({ lat, lng });
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
