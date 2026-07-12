let currentFilters = { price: 2, cuisine: '', maxDistance: 3, groupSize: 1, sharing: false };
let lastFilteredRestaurants = [];
let userLocation = null;
let recentVisits = [];
let lastRecommendation = null;
let preferences = null;

function init() {
  document.getElementById('location-banner-dismiss').addEventListener('click', () => {
    document.getElementById('location-banner').hidden = true;
  });

  document.querySelectorAll('#price-filter-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#price-filter-toggle button').forEach(b => b.classList.remove('active'));
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

  document.getElementById('group-size-minus').addEventListener('click', () => {
    currentFilters.groupSize = Math.max(1, currentFilters.groupSize - 1);
    document.getElementById('group-size-value').textContent = currentFilters.groupSize;
  });
  document.getElementById('group-size-plus').addEventListener('click', () => {
    currentFilters.groupSize = Math.min(8, currentFilters.groupSize + 1);
    document.getElementById('group-size-value').textContent = currentFilters.groupSize;
  });

  document.querySelectorAll('#sharing-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#sharing-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilters.sharing = btn.dataset.sharing === 'true';
    });
  });

  document.querySelectorAll('.star-rating button').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = Number(btn.dataset.star);
      const container = document.getElementById('visit-rating');
      container.dataset.value = value;
      document.querySelectorAll('.star-rating button').forEach(b => {
        const filled = Number(b.dataset.star) <= value;
        b.classList.toggle('filled', filled);
        b.textContent = filled ? '★' : '☆';
      });
    });
  });

  document.getElementById('visit-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitVisit();
  });

  document.getElementById('ticket-log-btn').addEventListener('click', () => {
    prefillVisitForm(lastRecommendation);
  });

  document.getElementById('edit-preferences-btn').addEventListener('click', () => {
    openPreferencesDialog();
  });

  document.getElementById('prefs-skip-btn').addEventListener('click', skipPreferences);

  document.getElementById('prefs-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitPreferences();
  });

  const prefsDialog = document.getElementById('prefs-dialog');
  prefsDialog.addEventListener('click', (event) => {
    if (event.target === prefsDialog) prefsDialog.close();
  });

  document.querySelectorAll('#prefs-spice-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#prefs-spice-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.querySelectorAll('#prefs-price-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#prefs-price-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.querySelectorAll('#prefs-dietary-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  requestUserLocation();
  loadRecentVisits();
  loadPreferences();
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
      body: JSON.stringify({
        restaurants: lastFilteredRestaurants,
        price: currentFilters.price,
        groupSize: currentFilters.groupSize,
        sharing: currentFilters.sharing
      })
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
  lastRecommendation = data;
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

async function loadRecentVisits() {
  const response = await fetch('/api/visits');
  const data = await response.json();
  recentVisits = data.visits || [];
  renderVisitList();
}

function visitItemElement(visit) {
  const li = document.createElement('li');
  li.className = 'visit-item';

  const top = document.createElement('div');
  top.className = 'visit-item-top';

  const name = document.createElement('span');
  name.className = 'visit-item-name';
  name.textContent = visit.restaurantName;

  const rating = document.createElement('span');
  rating.className = 'visit-item-rating';
  rating.textContent = '★'.repeat(visit.rating);

  top.appendChild(name);
  top.appendChild(rating);
  li.appendChild(top);

  if (visit.dish) {
    const dish = document.createElement('div');
    dish.className = 'visit-item-dish';
    dish.textContent = visit.dish;
    li.appendChild(dish);
  }

  const date = document.createElement('div');
  date.className = 'visit-item-date';
  date.textContent = new Date(visit.loggedAt).toLocaleDateString();
  li.appendChild(date);

  return li;
}

function renderVisitList() {
  const list = document.getElementById('visit-list');
  const empty = document.getElementById('visit-empty');

  list.replaceChildren();
  recentVisits.forEach(visit => list.appendChild(visitItemElement(visit)));
  empty.hidden = recentVisits.length > 0;
}

function resetVisitForm() {
  document.getElementById('visit-restaurant').value = '';
  document.getElementById('visit-dish').value = '';
  const container = document.getElementById('visit-rating');
  container.dataset.value = 0;
  document.querySelectorAll('.star-rating button').forEach(b => {
    b.classList.remove('filled');
    b.textContent = '☆';
  });
}

function prefillVisitForm(data) {
  if (!data) return;
  document.getElementById('visit-restaurant').value = data.restaurant.name;
  document.getElementById('visit-dish').value = data.dish.name;
  document.getElementById('visit-restaurant').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitVisit() {
  const status = document.getElementById('visit-status');
  const restaurantName = document.getElementById('visit-restaurant').value.trim();
  const dish = document.getElementById('visit-dish').value.trim();
  const rating = Number(document.getElementById('visit-rating').dataset.value);

  if (!restaurantName || rating < 1) {
    status.textContent = 'Enter a restaurant name and pick a star rating.';
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
    return;
  }

  const response = await fetch('/api/visits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantName, dish, rating })
  });

  const data = await response.json();

  if (!response.ok) {
    status.textContent = data.error;
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
    return;
  }

  recentVisits.unshift(data.visit);
  renderVisitList();
  resetVisitForm();
  status.textContent = 'Visit logged!';
  status.className = 'visit-status visit-status--ok';
  status.hidden = false;
}

async function loadPreferences() {
  const response = await fetch('/api/preferences');
  const data = await response.json();
  preferences = data.preferences;

  if (!preferences && !localStorage.getItem('ff_prefs_skipped')) {
    openPreferencesDialog();
  }
}

function populateCuisineChips() {
  const container = document.getElementById('prefs-cuisine-chips');
  container.replaceChildren();

  const cuisineOptions = Array.from(document.getElementById('cuisine-select').options)
    .map(option => option.value)
    .filter(Boolean);

  const selected = new Set(preferences ? preferences.favoriteCuisines : []);

  cuisineOptions.forEach(cuisine => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.cuisine = cuisine;
    chip.textContent = cuisine;
    if (selected.has(cuisine)) chip.classList.add('active');
    chip.addEventListener('click', () => chip.classList.toggle('active'));
    container.appendChild(chip);
  });
}

function openPreferencesDialog() {
  populateCuisineChips();

  document.querySelectorAll('#prefs-dietary-chips .chip').forEach(chip => {
    const isSelected = preferences && preferences.dietaryRestrictions.includes(chip.dataset.restriction);
    chip.classList.toggle('active', Boolean(isSelected));
  });

  const spice = preferences ? preferences.spiceTolerance : 'medium';
  document.querySelectorAll('#prefs-spice-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.spice === spice);
  });

  const priceTolerance = preferences ? String(preferences.priceTolerance) : '2';
  document.querySelectorAll('#prefs-price-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.priceTolerance === priceTolerance);
  });

  document.getElementById('prefs-dialog').showModal();
}

function skipPreferences() {
  localStorage.setItem('ff_prefs_skipped', '1');
  document.getElementById('prefs-dialog').close();
}

async function submitPreferences() {
  const favoriteCuisines = Array.from(document.querySelectorAll('#prefs-cuisine-chips .chip.active'))
    .map(chip => chip.dataset.cuisine);
  const dietaryRestrictions = Array.from(document.querySelectorAll('#prefs-dietary-chips .chip.active'))
    .map(chip => chip.dataset.restriction);
  const spiceTolerance = document.querySelector('#prefs-spice-toggle button.active').dataset.spice;
  const priceTolerance = Number(document.querySelector('#prefs-price-toggle button.active').dataset.priceTolerance);

  const response = await fetch('/api/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favoriteCuisines, dietaryRestrictions, spiceTolerance, priceTolerance })
  });

  const data = await response.json();
  const status = document.getElementById('prefs-status');

  if (!response.ok) {
    status.textContent = data.error;
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
    return;
  }

  preferences = data.preferences;
  status.hidden = true;
  document.getElementById('prefs-dialog').close();
}

window.addEventListener('maps-loaded', init);
