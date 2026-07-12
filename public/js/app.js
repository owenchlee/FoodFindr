let currentFilters = { price: 2, cuisine: '', maxDistance: 3 };
let lastFilteredRestaurants = [];
let userLocation = null;

function init() {
  document.getElementById('location-banner-dismiss').addEventListener('click', () => {
    document.getElementById('location-banner').hidden = true;
  });

  document.querySelectorAll('.price-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.price-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilters.price = Number(btn.dataset.price);
      loadRestaurants();
    });
  });

  document.getElementById('cuisine-select').addEventListener('change', (event) => {
    currentFilters.cuisine = event.target.value;
    loadRestaurants();
  });

  const distanceInput = document.getElementById('distance-range');
  const distanceValue = document.getElementById('distance-value');
  distanceInput.addEventListener('input', (event) => {
    distanceValue.textContent = `${event.target.value} mi`;
  });
  distanceInput.addEventListener('change', (event) => {
    currentFilters.maxDistance = Number(event.target.value);
    loadRestaurants();
  });

  document.getElementById('recommend-btn').addEventListener('click', getRecommendation);

  requestUserLocation();
}

function requestUserLocation() {
  if (!navigator.geolocation) {
    showLocationBanner("Your browser doesn't support location — showing spots near Mock City.");
    loadRestaurants();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      userLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
      recenterMap(userLocation.lat, userLocation.lng);
      loadRestaurants();
    },
    () => {
      showLocationBanner('Location access denied — showing spots near Mock City.');
      loadRestaurants();
    },
    { timeout: 8000 }
  );
}

function showLocationBanner(message) {
  document.getElementById('location-banner-text').textContent = message;
  document.getElementById('location-banner').hidden = false;
}

async function loadRestaurants() {
  const params = new URLSearchParams();
  if (userLocation) {
    params.set('lat', userLocation.lat);
    params.set('lng', userLocation.lng);
  }
  if (currentFilters.price) params.set('price', currentFilters.price);
  if (currentFilters.cuisine) params.set('cuisine', currentFilters.cuisine);
  if (currentFilters.maxDistance) params.set('maxDistance', currentFilters.maxDistance);

  const response = await fetch(`/api/restaurants?${params.toString()}`);
  const data = await response.json();

  if (!response.ok) {
    showLocationBanner(data.error || "Couldn't load restaurants nearby. Try again in a moment.");
  }

  lastFilteredRestaurants = data.restaurants || [];
  renderMarkers(lastFilteredRestaurants);
  hideTicket();
}

async function getRecommendation() {
  if (lastFilteredRestaurants.length === 0) {
    showTicketError('No restaurants match your filters. Try widening your distance or price range.');
    return;
  }

  const button = document.getElementById('recommend-btn');
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = 'Thinking...';

  try {
    const response = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurants: lastFilteredRestaurants, price: currentFilters.price })
    });

    const data = await response.json();

    if (!response.ok) {
      showTicketError(data.error);
      return;
    }

    showTicket(data);
    highlightPick(data.restaurant.id, lastFilteredRestaurants);
  } catch (err) {
    showTicketError("Couldn't reach the server. Check your connection and try again.");
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function showTicket(data) {
  const ticket = document.getElementById('ticket');
  document.getElementById('ticket-name').textContent = data.restaurant.name;
  document.getElementById('ticket-cuisine').textContent = data.restaurant.cuisine;
  document.getElementById('ticket-price').textContent = '$'.repeat(data.restaurant.price);
  document.getElementById('ticket-rating').textContent = `★ ${data.restaurant.rating}`;
  document.getElementById('ticket-distance').textContent = `${data.restaurant.distance} mi`;
  document.getElementById('ticket-dish').textContent = `Order: ${data.dish.name}`;
  document.getElementById('ticket-reason').textContent = data.reason;
  ticket.classList.remove('ticket--error');
  ticket.classList.add('visible');
}

function showTicketError(message) {
  const ticket = document.getElementById('ticket');
  document.getElementById('ticket-name').textContent = 'No match';
  document.getElementById('ticket-reason').textContent = message;
  ticket.classList.add('visible', 'ticket--error');
}

function hideTicket() {
  document.getElementById('ticket').classList.remove('visible');
}

window.addEventListener('maps-loaded', init);
