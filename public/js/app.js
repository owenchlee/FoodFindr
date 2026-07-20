let currentFilters = { price: 2, cuisine: '', maxDistance: 3, groupSize: 1, sharing: false, dish: '' };
let lastFilteredRestaurants = [];
let userLocation = null;
let usingCustomLocation = false;
let recentVisits = [];
let lastRecommendation = null;
let preferences = null;
let currentUser = null;
let mapsReady = false;
let appStarted = false;
let restaurantsLoading = false;
let pendingRecommendation = false;
let authMode = 'login';

function init() {
  document.getElementById('location-banner-dismiss').addEventListener('click', () => {
    document.getElementById('location-banner').hidden = true;
    if (usingCustomLocation) {
      usingCustomLocation = false;
      clearDropMarker();
      requestUserLocation();
    }
  });

  document.getElementById('pick-location-btn').addEventListener('click', () => {
    if (pinDropActive) {
      closeLocationPicker();
    } else {
      openLocationPicker();
    }
  });

  document.getElementById('location-search-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const query = event.target.value.trim();
    if (!query) return;
    searchLocation(query, event.target);
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

  const dishInput = document.getElementById('dish-search');
  dishInput.addEventListener('change', (event) => {
    currentFilters.dish = event.target.value.trim();
    loadRestaurants();
  });
  dishInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      dishInput.blur();
    }
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

  document.getElementById('visit-restaurant').addEventListener('change', (event) => {
    const otherInput = document.getElementById('visit-restaurant-other');
    otherInput.hidden = event.target.value !== '__other__';
    if (!otherInput.hidden) otherInput.focus();
  });

  document.getElementById('ticket-log-btn').addEventListener('click', () => {
    openDrawer('log-review');
    prefillVisitForm(lastRecommendation);
  });

  document.getElementById('edit-preferences-btn').addEventListener('click', () => {
    setRailExpanded(false);
    closeDrawer();
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

  document.querySelectorAll('#prefs-dietary-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  document.getElementById('drawer-close-btn').addEventListener('click', closeDrawer);

  document.getElementById('tabs-toggle').addEventListener('click', toggleRailExpanded);
  document.querySelectorAll('.rail-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      setRailExpanded(false);
      openDrawer(btn.dataset.tab);
    });
  });
  document.getElementById('filters-toggle').addEventListener('click', () => openDrawer('filters'));
}

// Bound immediately (not gated behind maps-loaded/init) since a user can
// already be authenticated, or interacting with the login form, well before
// the Maps script — which can take a couple seconds — finishes loading.
function bindAuthEvents() {
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('auth-toggle-mode').addEventListener('click', toggleAuthMode);
  document.getElementById('auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuthForm();
  });
}

function startAppData() {
  requestUserLocation();
  loadRecentVisits();
  loadPreferences();
}

function tryStartApp() {
  if (currentUser && mapsReady && !appStarted) {
    appStarted = true;
    startAppData();
  }
}

async function checkAuth() {
  try {
    const response = await fetch('/api/auth/me');
    if (response.ok) {
      const data = await response.json();
      onAuthenticated(data.user);
    } else {
      showAuthGate();
    }
  } catch (err) {
    showAuthGate();
  }
}

function onAuthenticated(user) {
  currentUser = user;
  document.getElementById('auth-gate').hidden = true;
  document.getElementById('rail-account').hidden = false;
  document.getElementById('account-email').textContent = user.email;
  tryStartApp();
}

function showAuthGate() {
  document.getElementById('auth-gate').hidden = false;
}

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('auth-submit-btn').textContent = authMode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('auth-toggle-mode').textContent =
    authMode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in';
  document.getElementById('auth-status').hidden = true;
}

async function submitAuthForm() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const status = document.getElementById('auth-status');
  const button = document.getElementById('auth-submit-btn');

  button.disabled = true;
  try {
    const response = await fetch(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();

    if (!response.ok) {
      status.textContent = data.error;
      status.className = 'visit-status visit-status--error';
      status.hidden = false;
      return;
    }

    status.hidden = true;
    onAuthenticated(data.user);
  } catch (err) {
    status.textContent = "Couldn't reach the server. Check your connection and try again.";
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    location.reload();
  }
}

const DRAWER_PANEL_TABS = ['filters', 'log-review', 'past-reviews', 'progress', 'faq'];
const DRAWER_TAB_LABELS = {
  filters: 'Filters',
  'log-review': 'Log a Review',
  'past-reviews': 'Past Reviews',
  progress: 'Game Progress',
  faq: 'How It Works & FAQ'
};

let drawerTriggerEl = null;

function openDrawer(tab) {
  const drawer = document.getElementById('tab-drawer');
  const filtersToggle = document.getElementById('filters-toggle');
  const alreadyShowingThis = drawer.classList.contains('open') && drawer.dataset.activeTab === tab;

  if (alreadyShowingThis) {
    closeDrawer();
    return;
  }

  drawerTriggerEl = document.activeElement;

  DRAWER_PANEL_TABS.forEach(panelTab => {
    document.getElementById(`tab-panel-${panelTab}`).hidden = panelTab !== tab;
  });
  drawer.dataset.activeTab = tab;
  document.getElementById('drawer-title').textContent = DRAWER_TAB_LABELS[tab] || '';

  drawer.hidden = false;
  // Force a layout pass so the transform transition animates in from the
  // off-screen starting position instead of jumping straight to open.
  void drawer.offsetHeight;
  drawer.classList.add('open');

  document.querySelectorAll('.rail-btn[data-tab]').forEach(btn => {
    const isActiveTab = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActiveTab);
    btn.setAttribute('aria-expanded', String(isActiveTab));
  });
  filtersToggle.classList.toggle('active', tab === 'filters');
  filtersToggle.setAttribute('aria-expanded', String(tab === 'filters'));

  document.getElementById('left-column').classList.add('hidden-by-drawer');
  document.getElementById('location-banner').classList.add('hidden-by-drawer');
}

function closeDrawer() {
  const drawer = document.getElementById('tab-drawer');
  drawer.classList.remove('open');
  document.querySelectorAll('.rail-btn[data-tab]').forEach(btn => {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  });
  const filtersToggle = document.getElementById('filters-toggle');
  filtersToggle.classList.remove('active');
  filtersToggle.setAttribute('aria-expanded', 'false');
  document.getElementById('left-column').classList.remove('hidden-by-drawer');
  document.getElementById('location-banner').classList.remove('hidden-by-drawer');

  drawer.addEventListener('transitionend', function onClosed() {
    drawer.removeEventListener('transitionend', onClosed);
    if (!drawer.classList.contains('open')) {
      drawer.hidden = true;
      if (drawerTriggerEl && document.body.contains(drawerTriggerEl)) drawerTriggerEl.focus();
      drawerTriggerEl = null;
    }
  });
}

function toggleRailExpanded() {
  const rail = document.getElementById('side-rail');
  setRailExpanded(!rail.classList.contains('expanded'));
}

function setRailExpanded(expanded) {
  document.getElementById('side-rail').classList.toggle('expanded', expanded);
  const toggle = document.getElementById('tabs-toggle');
  toggle.classList.toggle('active', expanded);
  toggle.setAttribute('aria-expanded', String(expanded));
}

function showLoading(message) {
  const overlay = document.getElementById('loading-overlay');
  document.querySelector('.loading-text').textContent = message;
  overlay.hidden = false;
}

function hideLoading() {
  document.getElementById('loading-overlay').hidden = true;
}

async function loadProgress() {
  if (!userLocation) return;

  const params = new URLSearchParams({ lat: userLocation.lat, lng: userLocation.lng });
  const response = await fetch(`/api/progress?${params.toString()}`);
  const data = await response.json();

  const block = document.getElementById('progress-block');
  const empty = document.getElementById('progress-empty');

  if (!response.ok || !data.city || data.discovered === 0) {
    block.hidden = true;
    empty.hidden = false;
    return;
  }

  const percent = Math.round((data.visited / data.discovered) * 100);
  document.getElementById('progress-city').textContent = `in ${data.city}`;
  document.getElementById('progress-bar-fill').style.width = `${percent}%`;
  document.getElementById('progress-count').textContent =
    `${data.visited} of ${data.discovered} restaurants you've searched up so far — not the whole city`;
  block.hidden = false;
  empty.hidden = true;
}

function requestUserLocation() {
  if (!navigator.geolocation) {
    showLocationBanner("Your browser doesn't support location — showing spots near Mock City.");
    loadRestaurants();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      // A custom pin may have been dropped while this request was still
      // pending (geolocation can take a few seconds to resolve) — don't let
      // a stale result silently override the user's explicit choice.
      if (usingCustomLocation) return;
      userLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
      recenterMap(userLocation.lat, userLocation.lng);
      loadRestaurants();
    },
    () => {
      if (usingCustomLocation) return;
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

function openLocationPicker() {
  enablePinDrop();
  document.getElementById('pick-location-btn').classList.add('active');
  document.getElementById('pick-location-btn').setAttribute('aria-expanded', 'true');
  document.getElementById('location-picker-popover').hidden = false;
  document.getElementById('location-search-input').focus();
  showLocationBanner('Search a location, or click anywhere on the map.');
}

function closeLocationPicker() {
  disablePinDrop();
  document.getElementById('pick-location-btn').classList.remove('active');
  document.getElementById('pick-location-btn').setAttribute('aria-expanded', 'false');
  document.getElementById('location-picker-popover').hidden = true;
  document.getElementById('location-banner').hidden = true;
}

async function searchLocation(query, inputEl) {
  inputEl.disabled = true;
  try {
    const response = await fetch(`/api/geocode?address=${encodeURIComponent(query)}`);
    const data = await response.json();

    if (!response.ok) {
      showLocationBanner(data.error || `Couldn't find "${query}" — try a different search.`);
      return;
    }

    inputEl.value = '';
    setDropMarker(data.lat, data.lng);
    recenterMap(data.lat, data.lng);
    onLocationPicked(data.lat, data.lng);
  } catch (err) {
    showLocationBanner("Couldn't reach the server. Check your connection and try again.");
  } finally {
    inputEl.disabled = false;
  }
}

function onLocationPicked(lat, lng) {
  userLocation = { lat, lng };
  usingCustomLocation = true;
  closeLocationPicker();
  showLocationBanner('Searching near your dropped pin — dismiss to switch back to your current location.');
  loadRestaurants();
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
  if (currentFilters.dish) params.set('dish', currentFilters.dish);

  restaurantsLoading = true;
  showLoading('Scanning nearby spots…');
  try {
    const response = await fetch(`/api/restaurants?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      showLocationBanner(data.error || "Couldn't load restaurants nearby. Try again in a moment.");
    }

    lastFilteredRestaurants = data.restaurants || [];
    renderMarkers(lastFilteredRestaurants);
    populateVisitRestaurantOptions();
    hideTicket();
    loadProgress();
  } finally {
    restaurantsLoading = false;
    hideLoading();
    // A "Get Recommendation" click that landed while this search was still in
    // flight (e.g. right after dropping a pin) previously got silently
    // swallowed by the loading overlay — this replays it now that fresh
    // restaurant data for the new location is actually in lastFilteredRestaurants.
    if (pendingRecommendation) {
      pendingRecommendation = false;
      getRecommendation();
    }
  }
}

function populateVisitRestaurantOptions() {
  const select = document.getElementById('visit-restaurant');
  const previousValue = select.value;
  select.replaceChildren();

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a restaurant…';
  select.appendChild(placeholder);

  lastFilteredRestaurants.forEach(restaurant => {
    const option = document.createElement('option');
    option.value = restaurant.name;
    option.textContent = restaurant.name;
    select.appendChild(option);
  });

  const other = document.createElement('option');
  other.value = '__other__';
  other.textContent = 'Other (not listed)';
  select.appendChild(other);

  if (Array.from(select.options).some(o => o.value === previousValue)) {
    select.value = previousValue;
  }
}

async function getRecommendation() {
  if (restaurantsLoading) {
    pendingRecommendation = true;
    return;
  }

  if (lastFilteredRestaurants.length === 0) {
    showTicketError('No restaurants match your filters. Try widening your distance or price range.');
    return;
  }

  const button = document.getElementById('recommend-btn');
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = 'Thinking...';
  showLoading('Reading reviews and picking a spot…');

  try {
    const response = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurants: lastFilteredRestaurants,
        price: currentFilters.price,
        groupSize: currentFilters.groupSize,
        sharing: currentFilters.sharing,
        dish: currentFilters.dish
      })
    });

    const data = await response.json();

    if (!response.ok) {
      showTicketError(data.error);
      return;
    }

    showTicket(data);
    highlightPick(data.restaurant.id, lastFilteredRestaurants);
    centerOnPick(data.restaurant.lat, data.restaurant.lng);
  } catch (err) {
    showTicketError("Couldn't reach the server. Check your connection and try again.");
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
    hideLoading();
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

  const dishEl = document.getElementById('ticket-dish');
  const sharedList = document.getElementById('ticket-shared-items');
  sharedList.replaceChildren();
  const sharedItems = Array.isArray(data.dish.sharedItems) ? data.dish.sharedItems : [];
  if (sharedItems.length > 0) {
    dishEl.textContent = 'Order for the table:';
    sharedItems.forEach(itemName => {
      const li = document.createElement('li');
      li.textContent = itemName;
      sharedList.appendChild(li);
    });
  } else {
    dishEl.textContent = `Order: ${data.dish.name}`;
  }

  const flavorsContainer = document.getElementById('ticket-flavors');
  flavorsContainer.replaceChildren();
  (data.dish.flavorTags || []).forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = tag;
    flavorsContainer.appendChild(chip);
  });

  document.getElementById('ticket-reason').textContent = data.reason;
  const mapLink = document.getElementById('ticket-map-link');
  const query = `${data.restaurant.lat},${data.restaurant.lng}`;
  mapLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}&query_place_id=${encodeURIComponent(data.restaurant.id)}`;
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
  const otherInput = document.getElementById('visit-restaurant-other');
  otherInput.value = '';
  otherInput.hidden = true;
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
  const select = document.getElementById('visit-restaurant');
  const otherInput = document.getElementById('visit-restaurant-other');
  const isListed = Array.from(select.options).some(o => o.value === data.restaurant.name);

  if (isListed) {
    select.value = data.restaurant.name;
    otherInput.hidden = true;
  } else {
    select.value = '__other__';
    otherInput.hidden = false;
    otherInput.value = data.restaurant.name;
  }

  document.getElementById('visit-dish').value = data.dish.name;
  select.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitVisit() {
  const status = document.getElementById('visit-status');
  const select = document.getElementById('visit-restaurant');
  const otherInput = document.getElementById('visit-restaurant-other');
  const restaurantName = (select.value === '__other__' ? otherInput.value : select.value).trim();
  const dish = document.getElementById('visit-dish').value.trim();
  const rating = Number(document.getElementById('visit-rating').dataset.value);

  if (!restaurantName || rating < 1) {
    status.textContent = 'Pick a restaurant and a star rating.';
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
    return;
  }

  const matchesRecommendation = lastRecommendation && restaurantName === lastRecommendation.restaurant.name;
  const flavorTags = matchesRecommendation ? lastRecommendation.dish.flavorTags : [];

  const response = await fetch('/api/visits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantName, dish, rating, flavorTags })
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
  loadProgress();
}

async function loadPreferences() {
  const response = await fetch('/api/preferences');
  const data = await response.json();
  preferences = data.preferences;

  if (!preferences && !localStorage.getItem(`ff_prefs_skipped_${currentUser.id}`)) {
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

  loadTopFlavors();
  document.getElementById('prefs-dialog').showModal();
}

async function loadTopFlavors() {
  const container = document.getElementById('top-flavors-chips');
  const empty = document.getElementById('top-flavors-empty');

  try {
    const response = await fetch('/api/flavors');
    const data = await response.json();
    const topFlavors = data.topFlavors || [];

    container.replaceChildren();
    topFlavors.forEach(({ tag, count }) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${tag} (${count})`;
      container.appendChild(chip);
    });

    empty.hidden = topFlavors.length > 0;
  } catch (err) {
    container.replaceChildren();
    empty.hidden = false;
  }
}

function skipPreferences() {
  localStorage.setItem(`ff_prefs_skipped_${currentUser.id}`, '1');
  document.getElementById('prefs-dialog').close();
}

async function submitPreferences() {
  const favoriteCuisines = Array.from(document.querySelectorAll('#prefs-cuisine-chips .chip.active'))
    .map(chip => chip.dataset.cuisine);
  const dietaryRestrictions = Array.from(document.querySelectorAll('#prefs-dietary-chips .chip.active'))
    .map(chip => chip.dataset.restriction);
  const spiceTolerance = document.querySelector('#prefs-spice-toggle button.active').dataset.spice;

  const response = await fetch('/api/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favoriteCuisines, dietaryRestrictions, spiceTolerance })
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

window.addEventListener('maps-loaded', () => {
  mapsReady = true;
  init();
  tryStartApp();
});

bindAuthEvents();
checkAuth();
