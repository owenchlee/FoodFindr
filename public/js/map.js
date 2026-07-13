let map;
let markersById = {};

function initMap(center, mapId) {
  map = new google.maps.Map(document.getElementById('map'), {
    center,
    zoom: 14,
    mapId: mapId || undefined,
    colorScheme: google.maps.ColorScheme.DARK
  });
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
  div.textContent = isPick ? `${'$'.repeat(restaurant.price)} · pick` : '$'.repeat(restaurant.price);
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
      title: restaurant.name
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
