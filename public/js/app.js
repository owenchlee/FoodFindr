function apiErrorFallback(status) {
  if (status === 429) return "Too many requests, wait a minute and try again.";
  if (status >= 500) return "Something went wrong on our side, try again in a moment.";
  return "Something went wrong. Please try again.";
}

// Tolerates non-JSON bodies (proxy HTML, plain-text 429) so the server having answered is not reported as a network failure.
async function readApiJson(response) {
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON body */ }
  if (!data || typeof data !== "object") data = {};
  if (!response.ok && !data.error) data.error = apiErrorFallback(response.status);
  return data;
}

// A 401 from our API while signed in means the session was revoked or expired: go back to sign-in.
// Guests and the sign-in forms have no currentUser, so they are untouched; form contents stay as they are.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  const url = String(args[0] && args[0].url || args[0]);
  if (response.status === 401 && currentUser && url.startsWith('/api/') && !url.startsWith('/api/auth/logout')) {
    currentUser = null;
    try { localStorage.removeItem('ff-last-user'); } catch (e) { /* ignore */ }
    document.getElementById('rail-account').hidden = true;
    document.getElementById('rail-account-guest').hidden = false;
    showAuthGate();
    const status = document.getElementById('auth-status');
    status.textContent = 'You were signed out, sign in again.';
    status.hidden = false;
  }
  return response;
};

let currentFilters = { price: 2, cuisine: '', maxDistance: 3, groupSize: 1, sharing: false, dish: '' };
let allRestaurants = [];
let lastFilteredRestaurants = [];
let userLocation = null;
let usingCustomLocation = false;
let recentVisits = [];
let visitsHasMore = false;
let lastRecommendation = null;
let preferences = null;
let currentUser = null;
let mapsReady = false;
let appStarted = false;
let restaurantsLoading = false;
let pendingRecommendation = false;
let authMode = 'login';
let isGuest = false;
let groups = [];
let activeGroupId = null;

// ?perf=1 opt-in client-side timing (Tier 0, item 2). Off by default so it
// never shows up in a normal user's console.
const PERF = new URLSearchParams(location.search).has('perf');
function perfLog(label, t0) {
  if (PERF) console.log(`[perf] ${label}=${(performance.now() - t0).toFixed(0)}ms`);
}

// Debounce + abort + sequence-guard scheduler for loadRestaurants (item 6).
// A single filter-tuning burst (dragging the distance slider, tabbing through
// cuisines) used to fire one full search per intermediate value; this
// collapses that to one search per settled interaction while still feeling
// instant for a single deliberate change (a `change` event only fires once
// per settled interaction anyway).
let searchSeq = 0;
let searchTimer = null;
let lastChangeAt = 0;
let searchAbort = null;
// Resolves once the current search's background phase-2 fetch (if any)
// finishes - awaited by getRecommendation so a Surprise Me click doesn't
// sample from only the first 20 results (see loadRestaurants/getRecommendation).
let pendingRestPromise = null;
let searchStartedAt = 0;
const SEARCH_TIMEOUT_MS = 15000;

function scheduleSearch({ immediate = false } = {}) {
  clearTimeout(searchTimer);
  // Set synchronously, NOT inside the async loadRestaurants call. Enter on the
  // dish field relies on this being true immediately so getRecommendation()
  // queues itself via pendingRecommendation instead of racing the old results
  // (see the dish input's keydown handler in init()).
  restaurantsLoading = true;
  // Leading edge: the first change after a quiet window starts at once; only
  // follow-ups inside the window (keyboard arrowing through the select) debounce.
  const now = Date.now();
  const quiet = now - lastChangeAt > 300;
  lastChangeAt = now;
  if (immediate || quiet) { runSearch(); return; }
  searchTimer = setTimeout(runSearch, 300);
}

// Coming back to the app with a search still "in flight": iOS suspends the
// web view in the background and the request may never settle, so start it
// over rather than wait out the deadline.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && restaurantsLoading && searchTimer === null &&
      Date.now() - searchStartedAt > 3000) {
    runSearch();
  }
});

function runSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  loadRestaurants(++searchSeq, searchAbort.signal);
}

// Native haptics via the Capacitor Haptics plugin, only inside the iOS
// shell. window.Capacitor.Plugins is a proxy that hands back a stub for any
// plugin name and rejects when the native side isn't installed, so every
// call swallows its promise rejection; in a plain browser these are no-ops.
const haptics = (() => {
  const plugin = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
    ? window.Capacitor.Plugins.Haptics : null;
  const call = (method, arg) => {
    const p = plugin();
    if (!p) return;
    try {
      const result = p[method](arg);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Plugin missing from this build of the shell.
    }
  };
  return {
    selection: () => call('impact', { style: 'LIGHT' }),
    success: () => call('notification', { type: 'SUCCESS' }),
    warning: () => call('notification', { type: 'WARNING' })
  };
})();

// Selection-style controls get a light tick, like a native segmented
// control or picker. Delegated so dynamically built chips/buttons get it too.
const HAPTIC_SELECTION_SELECTOR = [
  '.price-toggle button', '.chip', '.star-rating button', '.rail-btn', '.tabs-toggle',
  '.filters-toggle', '.group-size-row button', '.group-search-btn', '#dish-clear-btn',
  '.tab-bar-btn', '.inset-row'
].join(',');
document.addEventListener('click', (event) => {
  if (event.target.closest && event.target.closest(HAPTIC_SELECTION_SELECTOR)) haptics.selection();
}, true);

// Every inline form error (auth, visits, groups, prefs) goes through one of
// the static .visit-status elements; buzz when one flips into its error style.
const hapticStatusObserver = new MutationObserver(records => {
  if (records.some(r => r.target.classList.contains('visit-status--error') && !r.target.hidden)) haptics.warning();
});
document.querySelectorAll('.visit-status').forEach(el =>
  hapticStatusObserver.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] }));

const LAST_LOCATION_KEY = 'ff_last_location';
const ACTIVE_GROUP_KEY = 'ff_active_group_id';

function saveActiveGroupId(groupId) {
  try {
    if (groupId) localStorage.setItem(ACTIVE_GROUP_KEY, String(groupId));
    else localStorage.removeItem(ACTIVE_GROUP_KEY);
  } catch {
    // Storage can fail (private browsing, quota); losing this is harmless.
  }
}

function getSavedActiveGroupId() {
  try {
    const raw = localStorage.getItem(ACTIVE_GROUP_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function saveLastLocation(lat, lng) {
  try {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ lat, lng }));
  } catch {
    // Storage can fail (private browsing, quota); losing this is harmless.
  }
}

function getLastLocation() {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.lat === 'number' && typeof parsed.lng === 'number') return parsed;
  } catch {
    // Ignore malformed/corrupted storage.
  }
  return null;
}

function showNoLocationState() {
  document.getElementById('no-location-state').hidden = false;
}

function hideNoLocationState() {
  document.getElementById('no-location-state').hidden = true;
}

// Never invents a location to search near. Falls back to the last real
// location we have (from a previous real fix or a manual search/pin-drop),
// and only if there's truly never been one, shows an honest empty state
// instead of silently loading restaurants near some arbitrary place.
function useLastLocationOrShowEmptyState(reason) {
  const last = getLastLocation();
  if (last) {
    userLocation = last;
    setOriginMarker(last.lat, last.lng);
    recenterMap(last.lat, last.lng);
    showLocationBanner(`${reason}, showing spots near your last searched area.`);
    scheduleSearch({ immediate: true });
  } else {
    showNoLocationState();
    cancelPendingRecommendation('Set a location first: allow location access or tap the pin to choose a spot.');
  }
}

// Runs immediately at script load (not gated behind init()/Maps readiness),
// since a real no-network state can happen before, during, or after the
// rest of the app has started, and the two external APIs this app depends
// on (Google Places, Claude) both need a network to be reachable at all.
function updateOfflineBanner() {
  document.getElementById('offline-banner').hidden = navigator.onLine;
}
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);
updateOfflineBanner();

function init() {

  // WKWebView (Capacitor's iOS engine) doesn't open target="_blank" links on
  // its own - there's no browser tab for them to go to, so they'd otherwise
  // just silently do nothing (e.g. the "View on Google Maps" ticket link).
  // Route them through the native Browser plugin instead, only when running
  // in the wrapped app; on the plain website this is a no-op and normal
  // target="_blank" behavior is unchanged.
  if (window.Capacitor?.isNativePlatform?.()) {
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[target="_blank"]');
      if (!link || !link.href) return;
      event.preventDefault();
      window.Capacitor.Plugins.Browser.open({ url: link.href });
    });
  }

  document.getElementById('location-banner-dismiss').addEventListener('click', () => {
    document.getElementById('location-banner').hidden = true;
    if (usingCustomLocation) {
      usingCustomLocation = false;
      clearOriginMarker();
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

  document.getElementById('no-location-search-btn').addEventListener('click', openLocationPicker);

  // Form submit (not keydown) so the iOS Search key works and an IME-confirming Enter does not search.
  document.getElementById('location-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('location-search-input');
    const query = input.value.trim();
    if (!query) return;
    searchLocation(query, input);
  });

  document.querySelectorAll('#price-filter-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#price-filter-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilters.price = Number(btn.dataset.price);
      // Price never reaches Google - it's filtered entirely client-side from
      // allRestaurants (item 4), so this is a pure local re-render, not a fetch.
      applyLocalFilters();
    });
  });

  document.getElementById('cuisine-select').addEventListener('change', (event) => {
    currentFilters.cuisine = event.target.value;
    scheduleSearch();
  });

  const dishInput = document.getElementById('dish-search');
  const dishClearBtn = document.getElementById('dish-clear-btn');
  const updateDishClearBtn = () => { dishClearBtn.hidden = !dishInput.value; };
  dishInput.addEventListener('change', (event) => {
    currentFilters.dish = event.target.value.trim();
    scheduleSearch();
  });
  dishInput.addEventListener('input', updateDishClearBtn);
  dishClearBtn.addEventListener('click', () => {
    dishInput.value = '';
    currentFilters.dish = '';
    updateDishClearBtn();
    scheduleSearch({ immediate: true });
    focusWithoutScroll(dishInput);
  });

  // A real form submit, not a keydown listener: it's what the iOS keyboard's
  // Search key (enterkeyhint="search") reliably fires, including when
  // autocorrect is mid-word, which a keydown 'Enter' check can miss.
  document.getElementById('dish-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    // Read the value here rather than relying on 'change': blur() only fires
    // 'change' if the value differs from the last committed one. The explicit
    // scheduleSearch({immediate:true}) - not the debounced one 'change' would
    // otherwise trigger - sets restaurantsLoading = true synchronously and
    // skips the 300ms debounce window, so getRecommendation() queues itself
    // via pendingRecommendation instead of racing the previous search's
    // results. Don't replace this with a plain scheduleSearch().
    currentFilters.dish = dishInput.value.trim();
    dishInput.blur();
    scheduleSearch({ immediate: true });
    getRecommendation();
  });
  // The whole search pill focuses the field, not just the text itself: on a
  // phone the pill's padding and the magnifier icon are where thumbs land.
  document.querySelector('.search-row').addEventListener('click', (event) => {
    if (event.target.closest('button, input, .location-picker, .filters-toggle, a')) return;
    focusWithoutScroll(dishInput);
  });

  const distanceInput = document.getElementById('distance-range');
  const distanceValue = document.getElementById('distance-value');
  distanceInput.addEventListener('input', (event) => {
    distanceValue.textContent = `${event.target.value} mi`;
  });
  distanceInput.addEventListener('change', (event) => {
    currentFilters.maxDistance = Number(event.target.value);
    scheduleSearch();
  });

  const recommendBtn = document.getElementById('recommend-btn');
  recommendBtn.addEventListener('click', getRecommendation);
  // Intent-triggered reviews prewarm (item 12): fires before the click, so the
  // review fan-out in /api/recommend has a head start. Only warms on actual
  // hover/focus intent, not on every search, since Place Details is billed
  // per call. Guarded to at most once per search (lastPrewarmedSeq) so
  // repeated hovering over the same result set doesn't re-request it.
  let lastPrewarmedSeq = -1;
  const prewarm = () => {
    if (lastFilteredRestaurants.length === 0 || lastPrewarmedSeq === searchSeq) return;
    lastPrewarmedSeq = searchSeq;
    // Same inputs as /api/recommend, so the server warms the place it will pick.
    fetch('/api/prewarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurants: lastFilteredRestaurants,
        price: currentFilters.price,
        dish: currentFilters.dish,
        groupId: activeGroupId,
        recentPickIds: recentPickIds.slice(-3)
      })
    }).catch(() => {});
  };
  recommendBtn.addEventListener('mouseenter', prewarm);
  recommendBtn.addEventListener('focus', prewarm);
  recommendBtn.addEventListener('touchstart', prewarm, { passive: true });

  document.getElementById('ticket-close-btn').addEventListener('click', () => {
    // Dismissing the card while a recommendation is still streaming in
    // means "not interested": don't pop it back open on the next event.
    ticketDismissed = true;
    hideTicket();
  });

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

  const restaurantInput = document.getElementById('visit-restaurant');
  restaurantInput.addEventListener('input', (event) => renderRestaurantSuggestions(event.target.value));
  restaurantInput.addEventListener('focus', (event) => renderRestaurantSuggestions(event.target.value));
  restaurantInput.addEventListener('blur', () => {
    document.getElementById('restaurant-suggestions').hidden = true;
  });

  document.getElementById('ticket-log-btn').addEventListener('click', () => {
    if (isGuest) {
      showAuthGate();
      return;
    }
    openDrawer('log-review');
    prefillVisitForm(lastRecommendation);
  });

  document.getElementById('edit-preferences-btn').addEventListener('click', () => {
    if (isGuest) {
      showAuthGate();
      return;
    }
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
  bindDrawerDrag();

  document.getElementById('tabs-toggle').addEventListener('click', toggleRailExpanded);
  // Side rail and bottom tab bar buttons (data-tab) toggle their panel;
  // rows inside a panel (data-open-tab) always switch to theirs.
  const openTabFromButton = (tab, { toggle }) => {
    // FAQ and the You panel need no account; the other tabs are all
    // account-only, so bounce a guest to sign up instead.
    if (isGuest && GUEST_LOCKED_TABS.has(tab)) {
      showAuthGate();
      return;
    }
    setRailExpanded(false);
    const drawer = document.getElementById('tab-drawer');
    if (!toggle && drawer.classList.contains('open') && drawer.dataset.activeTab === tab) return;
    openDrawer(tab);
    // Opened on demand instead of being fetched on every search (item 9);
    // force a refresh here since the location bucket may not have changed.
    if (tab === 'progress') loadProgress({ force: true });
  };
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => openTabFromButton(btn.dataset.tab, { toggle: true }));
  });
  document.querySelectorAll('[data-open-tab]').forEach(btn => {
    btn.addEventListener('click', () => openTabFromButton(btn.dataset.openTab, { toggle: false }));
  });
  document.querySelector('.tab-bar [data-action="explore"]').addEventListener('click', closeDrawer);
  document.querySelector('[data-action="taste-profile"]').addEventListener('click', () => {
    document.getElementById('edit-preferences-btn').click();
  });
  document.getElementById('more-signup-btn').addEventListener('click', showAuthGate);
  document.getElementById('more-logout-btn').addEventListener('click', logout);
  document.getElementById('more-password-btn').addEventListener('click', event => {
    const form = document.getElementById('change-password-form');
    form.hidden = !form.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
  });
  document.getElementById('change-password-form').addEventListener('submit', submitChangePassword);
  document.getElementById('display-name-form').addEventListener('submit', submitDisplayName);
  document.getElementById('more-delete-btn').addEventListener('click', event => {
    const form = document.getElementById('delete-account-form');
    form.hidden = !form.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
  });
  document.getElementById('delete-account-form').addEventListener('submit', deleteAccount);
  document.getElementById('sheet-backdrop').addEventListener('click', closeDrawer);
  document.getElementById('filters-toggle').addEventListener('click', () => {
    setRailExpanded(false);
    openDrawer('filters');
  });

  document.getElementById('active-group-banner-dismiss').addEventListener('click', () => setActiveGroup(null));

  document.getElementById('create-group-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitCreateGroup();
  });
  document.getElementById('join-group-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitJoinGroup();
  });
}

// Bound immediately (not gated behind maps-loaded/init) since a user can
// already be authenticated, or interacting with the login form, well before
// the Maps script (which can take a couple seconds) finishes loading.
function bindAuthEvents() {
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('auth-toggle-mode').addEventListener('click', toggleAuthMode);
  document.getElementById('auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuthForm();
  });
  document.getElementById('continue-as-guest-btn').addEventListener('click', continueAsGuest);
  document.getElementById('rail-guest-signup-btn').addEventListener('click', showAuthGate);
  document.getElementById('auth-password-toggle').addEventListener('click', togglePasswordVisibility);
}

function togglePasswordVisibility() {
  const input = document.getElementById('auth-password');
  const toggleBtn = document.getElementById('auth-password-toggle');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  toggleBtn.classList.toggle('showing', !showing);
  toggleBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  toggleBtn.setAttribute('aria-pressed', String(!showing));
}

function startAppData() {
  requestUserLocation();
  // Visits/preferences are account-only routes, and a guest hitting them would
  // just get a 401, so skip loading them entirely rather than let that fail.
  if (!isGuest) {
    loadRecentVisits();
    loadPreferences();
    loadStreaks();
    loadBadges();
    loadLeaderboard();
    loadGroups();
  }
}

function tryStartApp() {
  // Not gated on Maps: location + search run while the Maps script downloads;
  // map.js helpers no-op until the map exists and the maps-loaded handler paints.
  if ((currentUser || isGuest) && !appStarted) {
    appStarted = true;
    startAppData();
  }
}

async function checkAuth() {
  try {
    const response = await fetch('/api/auth/me');
    if (response.ok) {
      const data = await readApiJson(response);
      // Storage can throw (private mode, quota); that must not look like a network failure.
      try { localStorage.setItem('ff-last-user', JSON.stringify(data.user)); } catch (e) { /* ignore */ }
      onAuthenticated(data.user);
    } else {
      try { localStorage.removeItem('ff-last-user'); } catch (e) { /* ignore */ }
      showAuthGate();
    }
  } catch (err) {
    // Network failure is not a sign-out: keep the shell for the last known user.
    let last = null;
    try { last = JSON.parse(localStorage.getItem('ff-last-user')); } catch (e) { /* ignore */ }
    if (last && last.email) onAuthenticated(last);
    else showAuthGate();
  }
}

function onAuthenticated(user) {
  currentUser = user;
  flushVisitQueue();
  // A guest who signs up mid-session already has appStarted set, so
  // tryStartApp() below is a no-op for them, so load their account data here
  // instead of relying on startAppData(), which only runs once per session.
  const wasGuest = isGuest;
  isGuest = false;
  document.getElementById('auth-gate').hidden = true;
  document.getElementById('rail-account-guest').hidden = true;
  document.getElementById('rail-account').hidden = false;
  document.getElementById('account-email').textContent = user.email;
  setMoreAccount(user);
  tryStartApp();
  if (wasGuest && appStarted) {
    loadRecentVisits();
    loadPreferences();
    loadStreaks();
    loadBadges();
    loadLeaderboard();
    loadGroups();
    // Guest searches never recorded the area; a (cached, cheap) re-search now does.
    scheduleSearch({ immediate: true });
  }
}

function showAuthGate() {
  // A guest tapping a locked rail tab lands here with the rail still
  // expanded; left open, it sits over the drawer they land in after signing
  // up (e.g. covering the Log a Visit star rating).
  setRailExpanded(false);
  document.getElementById('auth-gate').hidden = false;
  focusWithoutScroll(document.getElementById('auth-email'));
}

function continueAsGuest() {
  isGuest = true;
  document.getElementById('auth-gate').hidden = true;
  document.getElementById('rail-account').hidden = true;
  document.getElementById('rail-account-guest').hidden = false;
  setMoreAccount(null);
  tryStartApp();
}

// Header and account buttons of the phone "You" panel.
function setMoreAccount(user) {
  document.getElementById('more-account-name').textContent = user ? (user.displayName || 'Set your name below') : 'Browsing as guest';
  document.getElementById('display-name-form').hidden = !user;
  if (user) document.getElementById('display-name-input').value = user.displayName || '';
  document.getElementById('more-account-sub').textContent = user ? user.email : 'Sign up to save visits and your taste';
  document.getElementById('more-signup-btn').parentElement.hidden = Boolean(user);
  document.getElementById('more-logout-btn').parentElement.hidden = !user;
  document.getElementById('more-export-row').hidden = !user;
  document.getElementById('more-delete-btn').parentElement.hidden = !user;
  document.getElementById('more-password-btn').parentElement.hidden = !user;
  if (!user) document.getElementById('change-password-form').hidden = true;
  if (!user) document.getElementById('delete-account-form').hidden = true;
}

async function submitDisplayName(event) {
  event.preventDefault();
  const status = document.getElementById('display-name-status');
  try {
    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: document.getElementById('display-name-input').value })
    });
    const data = await response.json().catch(() => ({}));
    status.hidden = false;
    if (!response.ok) {
      status.textContent = data.error || 'Could not save your name.';
      return;
    }
    currentUser.displayName = data.displayName;
    setMoreAccount(currentUser);
    status.textContent = 'Saved.';
    loadLeaderboard();
  } catch {
    status.hidden = false;
    status.textContent = 'Could not save your name.';
  }
}

async function submitChangePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('cp-status');
  const button = document.getElementById('cp-submit-btn');

  button.disabled = true;
  try {
    const response = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: document.getElementById('cp-current').value,
        newPassword: document.getElementById('cp-new').value
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      status.textContent = data.error || 'Could not change your password.';
      status.className = 'visit-status visit-status--error';
    } else {
      form.reset();
      status.textContent = 'Password updated. Your other devices were signed out.';
      status.className = 'visit-status';
    }
  } catch {
    status.textContent = 'Could not reach the server. Try again.';
    status.className = 'visit-status visit-status--error';
  } finally {
    status.hidden = false;
    button.disabled = false;
  }
}

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('auth-submit-btn').textContent = authMode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('auth-toggle-mode').textContent =
    authMode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in';
  document.getElementById('auth-password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
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
    const data = await readApiJson(response);

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
    try { localStorage.removeItem('ff-last-user'); } catch (e) { /* ignore */ }
    location.reload();
  }
}

async function deleteAccount(event) {
  event.preventDefault();
  // masked password field, not prompt(): prompt() shows the password in plain text
  const status = document.getElementById('da-status');
  const button = document.getElementById('da-submit-btn');
  const fail = message => {
    status.textContent = message;
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
  };
  button.disabled = true;
  try {
    const response = await fetch('/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('da-password').value })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      fail(data.error || 'Could not delete your account right now.');
      return;
    }
    // ff-last-user too, or an offline relaunch would restore the deleted account's shell.
    try {
      Object.keys(localStorage).filter(k => k.startsWith('ff_') || k.startsWith('ff-')).forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
    location.reload();
  } catch (err) {
    fail("Couldn't reach the server. Check your connection and try again.");
  } finally {
    button.disabled = false;
  }
}

const GUEST_LOCKED_TABS = new Set(['log-review', 'past-reviews', 'progress', 'group']);

const DRAWER_PANEL_TABS = ['filters', 'log-review', 'past-reviews', 'progress', 'group', 'faq', 'more'];
const DRAWER_TAB_LABELS = {
  filters: 'Filters',
  'log-review': 'Log a Visit',
  'past-reviews': 'Your Visits',
  progress: 'Your Progress',
  group: 'Friend Group',
  faq: 'How It Works',
  more: 'You'
};

// Phone layout (bottom tab bar + bottom sheet) vs the desktop side rail.
const phoneLayout = window.matchMedia('(max-width: 720px)');

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
  document.querySelectorAll('[data-tab]').forEach(btn => {
    const isActiveTab = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActiveTab);
    btn.setAttribute('aria-expanded', String(isActiveTab));
  });
  filtersToggle.classList.toggle('active', tab === 'filters');
  filtersToggle.setAttribute('aria-expanded', String(tab === 'filters'));

  document.getElementById('left-column').classList.add('hidden-by-drawer');
  document.getElementById('location-banner').classList.add('hidden-by-drawer');
  document.getElementById('active-group-banner').classList.add('hidden-by-drawer');
  drawer.closest('.shell').classList.add('drawer-open');
  // Force one style/layout pass for all the writes above so the transform
  // transition animates in from the off-screen start instead of jumping open.
  void drawer.offsetHeight;
  drawer.classList.add('open');

  // The phone sheet covers the page, so it is modal there; the desktop panel is not.
  drawer.setAttribute('aria-modal', String(phoneLayout.matches));
  focusWithoutScroll(document.getElementById('drawer-close-btn'));
}

// Sign-in gate is modal: keep Tab inside it. Escape closes the picker / side rail.
document.addEventListener('keydown', (event) => {
  const gate = document.getElementById('auth-gate');
  if (!gate.hidden) {
    if (event.key !== 'Tab') return;
    const items = [...gate.querySelectorAll('button, input')].filter(el => !el.disabled && el.offsetParent !== null);
    const first = items[0], last = items[items.length - 1];
    if (!gate.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    return;
  }
  if (event.key !== 'Escape') return;
  if (!document.getElementById('location-picker-popover').hidden) {
    closeLocationPicker();
    focusWithoutScroll(document.getElementById('pick-location-btn'));
  } else if (document.getElementById('side-rail').classList.contains('expanded') &&
             !document.getElementById('tab-drawer').classList.contains('open')) {
    setRailExpanded(false);
    focusWithoutScroll(document.getElementById('tabs-toggle'));
  }
});

document.addEventListener('keydown', (event) => {
  const drawer = document.getElementById('tab-drawer');
  if (!drawer || !drawer.classList.contains('open')) return;
  if (event.key === 'Escape') {
    closeDrawer();
  } else if (event.key === 'Tab' && phoneLayout.matches) {
    const items = [...drawer.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
      .filter(el => !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const outside = !drawer.contains(document.activeElement);
    if (outside || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

function closeDrawer() {
  const drawer = document.getElementById('tab-drawer');
  drawer.classList.remove('open');
  drawer.closest('.shell').classList.remove('drawer-open');
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  });
  const filtersToggle = document.getElementById('filters-toggle');
  filtersToggle.classList.remove('active');
  filtersToggle.setAttribute('aria-expanded', 'false');
  document.getElementById('left-column').classList.remove('hidden-by-drawer');
  document.getElementById('location-banner').classList.remove('hidden-by-drawer');
  document.getElementById('active-group-banner').classList.remove('hidden-by-drawer');

  // Finish on the drawer's own transform transition only: transitionend
  // bubbles, and the buttons inside have press-state transitions of their
  // own that would otherwise hide the drawer partway through its slide. The
  // timer covers reduced motion (no transition, so no transitionend at all)
  // and a close on an already-hidden drawer.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    drawer.removeEventListener('transitionend', onClosed);
    if (!drawer.classList.contains('open')) {
      drawer.hidden = true;
      if (drawerTriggerEl && document.body.contains(drawerTriggerEl)) focusWithoutScroll(drawerTriggerEl);
      drawerTriggerEl = null;
    }
  };
  function onClosed(event) {
    if (event.target === drawer && event.propertyName === 'transform') finish();
  }
  drawer.addEventListener('transitionend', onClosed);
  setTimeout(finish, 450);
}

// Drag-to-dismiss for the drawer, like an iOS sheet: a drag towards closed
// moves it 1:1 with the finger (transform only), and on release it closes if
// it was pulled far enough or flicked fast enough, otherwise springs back.
// Desktop side drawer: horizontal drag anywhere, with touch-action: pan-y
// (style.css) keeping vertical scrolling native. Phone bottom sheet: a
// downward drag on the header/grabber, which has touch-action: none, so the
// sheet's content still scrolls normally.
function bindDrawerDrag() {
  const drawer = document.getElementById('tab-drawer');
  const LOCK_PX = 8;
  const CLOSE_FRACTION = 0.35;
  const CLOSE_VELOCITY = 0.5; // px/ms, towards closed
  let drag = null;

  drawer.addEventListener('pointerdown', (event) => {
    if (!drawer.classList.contains('open') || event.button > 0) return;
    // Let form controls keep their own gestures (range slider, text selection).
    if (event.target.closest('input, select, textarea')) return;
    const axis = phoneLayout.matches ? 'y' : 'x';
    if (axis === 'y' && !event.target.closest('.drawer-header')) return;
    drag = { id: event.pointerId, axis, x0: event.clientX, y0: event.clientY, d: 0, locked: null, samples: [] };
  });

  drawer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x0;
    const dy = event.clientY - drag.y0;
    if (drag.locked === null) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
      drag.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.locked !== drag.axis) { drag = null; return; } // a scroll, not a dismiss
      drawer.setPointerCapture(event.pointerId);
      drawer.classList.add('dragging');
    }
    // Only towards closed (left for the side drawer, down for the sheet);
    // no rubber band outwards.
    drag.d = drag.axis === 'x' ? Math.min(0, dx) : Math.max(0, dy);
    drawer.style.transform = drag.axis === 'x' ? `translateX(${drag.d}px)` : `translateY(${drag.d}px)`;
    drag.samples.push({ t: event.timeStamp, p: drag.axis === 'x' ? -event.clientX : event.clientY });
    if (drag.samples.length > 6) drag.samples.shift();
  });

  const release = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const wasDragging = drag.locked === drag.axis;
    const { d, axis, samples } = drag;
    drag = null;
    if (!wasDragging) return;
    drawer.dataset.justDragged = '1';
    setTimeout(() => { delete drawer.dataset.justDragged; }, 60);
    const first = samples[0];
    const last = samples[samples.length - 1];
    const velocity = first && last && last.t > first.t ? (last.p - first.p) / (last.t - first.t) : 0;
    const size = axis === 'x' ? drawer.offsetWidth : drawer.offsetHeight;
    const shouldClose = Math.abs(d) > size * CLOSE_FRACTION || velocity > CLOSE_VELOCITY;
    // Hand back to the CSS transition from wherever the finger left it: the
    // inline transform and the class change land in the same style pass, so
    // the transition runs from the dragged position.
    drawer.classList.remove('dragging');
    drawer.style.transform = '';
    if (shouldClose) closeDrawer();
  };
  drawer.addEventListener('pointerup', release);
  drawer.addEventListener('pointercancel', release);
  // A drag that ended over a button shouldn't also activate it.
  drawer.addEventListener('click', (event) => {
    if (drawer.dataset.justDragged) { event.stopPropagation(); event.preventDefault(); }
  }, true);
}

function toggleRailExpanded() {
  const rail = document.getElementById('side-rail');
  const expanding = !rail.classList.contains('expanded');
  // Expanding the rail to 210px would otherwise overlap an already-open
  // drawer, which is still positioned assuming the rail's collapsed width.
  if (expanding) closeDrawer();
  setRailExpanded(expanding);
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

// Non-blocking equivalent of showLoading/hideLoading, used for filter
// refinements instead of the full-screen overlay (item 9) - the map and
// existing markers stay visible and pannable underneath it.
function showRefining() {
  document.getElementById('search-refining-pill').hidden = false;
}
function hideRefining() {
  document.getElementById('search-refining-pill').hidden = true;
}

// Dedupes redundant /api/progress calls: it was previously re-fetched on
// every single search (even ones that don't move the lat/lng bucket it keys
// on) for a panel the user usually isn't looking at. force:true is used when
// the Progress tab is actually opened, or right after logging a visit, since
// either can change the numbers without moving location.
let lastProgressLocationKey = null;
async function loadProgress({ force = false } = {}) {
  if (!userLocation) return;
  const key = `${userLocation.lat.toFixed(3)},${userLocation.lng.toFixed(3)}`;
  if (!force && key === lastProgressLocationKey) return;
  lastProgressLocationKey = key;

  const params = new URLSearchParams({ lat: userLocation.lat, lng: userLocation.lng });
  const block = document.getElementById('progress-block');
  const empty = document.getElementById('progress-empty');

  try {
    const response = await fetch(`/api/progress?${params.toString()}`);
    const data = await readApiJson(response);

    if (!response.ok || !data.city || data.discovered === 0) {
      block.hidden = true;
      empty.hidden = false;
      return;
    }

    const percent = Math.round((data.visited / data.discovered) * 100);
    document.getElementById('progress-city').textContent = `in ${data.city}`;
    document.getElementById('progress-bar-fill').style.width = `${percent}%`;
    document.getElementById('progress-count').textContent =
      `${data.visited} of ${data.discovered} restaurants you've searched up so far, not the whole city`;
    block.hidden = false;
    empty.hidden = true;
  } catch (err) {
    // No network (fetch itself throws rather than resolving) - fall back to
    // the same empty state as a non-ok response instead of leaving this tab
    // stuck mid-load with no explanation.
    block.hidden = true;
    empty.hidden = false;
  }
}

async function loadStreaks() {
  const block = document.getElementById('streak-block');
  const empty = document.getElementById('streak-empty');

  try {
    const response = await fetch('/api/streaks?tz=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone));
    if (!response.ok) {
      block.hidden = true;
      empty.hidden = false;
      return;
    }
    const data = await readApiJson(response);

    if (!data.lastVisitDate) {
      block.hidden = true;
      empty.hidden = false;
      return;
    }

    document.getElementById('streak-current-value').textContent = data.currentStreak;
    document.getElementById('streak-longest-value').textContent = data.longestStreak;
    document.getElementById('streak-hint').textContent = data.currentStreak > 0
      ? 'Log a visit tomorrow to keep it going.'
      : 'Your streak reset. Log a visit today to start a new one.';
    block.hidden = false;
    empty.hidden = true;
  } catch (err) {
    block.hidden = true;
    empty.hidden = false;
  }
}

function badgeElement(badge) {
  const div = document.createElement('div');
  div.className = badge.earned ? 'badge-card badge-card--earned' : 'badge-card';

  const name = document.createElement('span');
  name.className = 'badge-name';
  name.textContent = badge.name;
  div.appendChild(name);

  const description = document.createElement('span');
  description.className = 'badge-description';
  description.textContent = badge.description;
  div.appendChild(description);

  if (badge.progress && !badge.earned) {
    const progress = document.createElement('span');
    progress.className = 'badge-progress';
    progress.textContent = `${badge.progress.current}/${badge.progress.target}`;
    div.appendChild(progress);
  }

  return div;
}

async function loadBadges() {
  const grid = document.getElementById('badge-grid');
  try {
    const response = await fetch('/api/badges?tz=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone));
    if (!response.ok) return;
    const data = await readApiJson(response);

    grid.replaceChildren();
    (data.badges || []).forEach(badge => grid.appendChild(badgeElement(badge)));
  } catch (err) {
    // Leave whatever badges are already rendered from the last successful load.
  }
}

function leaderboardRowElement(row) {
  const li = document.createElement('li');
  li.className = row.isYou ? 'leaderboard-row leaderboard-row--you' : 'leaderboard-row';

  const rank = document.createElement('span');
  rank.className = 'leaderboard-rank';
  rank.textContent = `#${row.rank}`;
  li.appendChild(rank);

  const name = document.createElement('span');
  name.className = 'leaderboard-name';
  name.textContent = row.isYou ? `${row.displayName} (you)` : row.displayName;
  li.appendChild(name);

  const count = document.createElement('span');
  count.className = 'leaderboard-count';
  count.textContent = `${row.visitCount} visit${row.visitCount === 1 ? '' : 's'}`;
  li.appendChild(count);

  const streak = document.createElement('span');
  streak.className = 'leaderboard-streak';
  streak.textContent = row.currentStreak > 0 ? `🔥 ${row.currentStreak}` : '';
  li.appendChild(streak);

  return li;
}

async function loadLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  const empty = document.getElementById('leaderboard-empty');

  try {
    const response = await fetch('/api/leaderboard?tz=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone));
    if (!response.ok) return;
    const data = await readApiJson(response);
    const leaderboard = data.leaderboard || [];

    list.replaceChildren();
    leaderboard.forEach(row => list.appendChild(leaderboardRowElement(row)));
    const alone = leaderboard.length <= 1;
    document.getElementById('leaderboard-invite').hidden = !alone;
    empty.hidden = alone || leaderboard.some(row => row.visitCount > 0);
  } catch (err) {
    // Leave whatever leaderboard is already rendered from the last successful load.
  }
}

function groupItemElement(group) {
  const li = document.createElement('li');
  li.className = group.id === activeGroupId ? 'group-item group-item--active' : 'group-item';

  const top = document.createElement('div');
  top.className = 'group-item-top';
  const name = document.createElement('span');
  name.className = 'group-item-name';
  name.textContent = group.name;
  top.appendChild(name);
  const count = document.createElement('span');
  count.className = 'group-item-count';
  count.textContent = `${group.memberCount} member${group.memberCount === 1 ? '' : 's'}`;
  top.appendChild(count);
  li.appendChild(top);

  const code = document.createElement('span');
  code.className = 'group-item-code';
  code.textContent = `Code: ${group.code}`;
  li.appendChild(code);

  const actions = document.createElement('div');
  actions.className = 'group-item-actions';

  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'group-search-btn';
  const isActive = group.id === activeGroupId;
  searchBtn.classList.toggle('active', isActive);
  searchBtn.setAttribute('aria-pressed', String(isActive));
  searchBtn.textContent = isActive ? '✓ Searching with this group' : 'Search as this group';
  searchBtn.addEventListener('click', () => setActiveGroup(isActive ? null : group.id));
  actions.appendChild(searchBtn);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy code';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(group.code);
      copyBtn.textContent = 'Copied!';
    } catch (err) {
      copyBtn.textContent = group.code; // Clipboard blocked: show the code to copy by hand.
    }
    setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1800);
  });
  actions.appendChild(copyBtn);

  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.textContent = 'Leave';
  leaveBtn.addEventListener('click', () => leaveGroupClick(group.id));
  actions.appendChild(leaveBtn);

  li.appendChild(actions);
  return li;
}

function renderGroups() {
  const list = document.getElementById('group-list');
  const empty = document.getElementById('group-empty');
  list.replaceChildren();
  groups.forEach(group => list.appendChild(groupItemElement(group)));
  empty.hidden = groups.length > 0;
}

function updateActiveGroupBanner() {
  const banner = document.getElementById('active-group-banner');
  const active = groups.find(g => g.id === activeGroupId);
  if (!active) {
    banner.hidden = true;
    return;
  }
  const peopleLabel = active.memberCount === 1 ? 'person' : 'people';
  document.getElementById('active-group-banner-text').textContent =
    `Searching as a group: ${active.name} (${active.memberCount} ${peopleLabel}). Dismiss to search alone.`;
  banner.hidden = false;
}

function setActiveGroup(groupId) {
  // A group that's since been left/deleted shouldn't silently stay "active".
  activeGroupId = groupId && groups.some(g => g.id === groupId) ? groupId : null;
  saveActiveGroupId(activeGroupId);
  renderGroups();
  updateActiveGroupBanner();
  scheduleSearch({ immediate: true });
}

async function loadGroups() {
  try {
    const response = await fetch('/api/groups');
    if (!response.ok) return;
    const data = await readApiJson(response);
    groups = data.groups || [];

    const saved = getSavedActiveGroupId();
    activeGroupId = saved && groups.some(g => g.id === saved) ? saved : null;

    renderGroups();
    updateActiveGroupBanner();
  } catch (err) {
    // Group data is a nice-to-have on top of solo search; a failed load here
    // shouldn't block the rest of the app from working.
  }
}

async function submitCreateGroup() {
  const input = document.getElementById('create-group-name');
  const status = document.getElementById('group-status');
  const name = input.value.trim();
  if (!name) return;

  try {
    const response = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await readApiJson(response);
    if (!response.ok) {
      status.textContent = data.error;
      status.className = 'visit-status visit-status--error';
      status.hidden = false;
      return;
    }
    input.value = '';
    status.hidden = true;
    await loadGroups();
  } catch (err) {
    status.textContent = "Couldn't reach the server. Check your connection and try again.";
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
  }
}

async function submitJoinGroup() {
  const input = document.getElementById('join-group-code');
  const status = document.getElementById('group-status');
  const code = input.value.trim();
  if (!code) return;

  try {
    const response = await fetch('/api/groups/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await readApiJson(response);
    if (!response.ok) {
      status.textContent = data.error;
      status.className = 'visit-status visit-status--error';
      status.hidden = false;
      return;
    }
    input.value = '';
    status.hidden = true;
    await loadGroups();
    loadLeaderboard();
  } catch (err) {
    status.textContent = "Couldn't reach the server. Check your connection and try again.";
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
  }
}

async function leaveGroupClick(groupId) {
  if (!confirm('Leave this group? If you are the last member, the group is deleted.')) return;
  try {
    await fetch(`/api/groups/${groupId}/leave`, { method: 'POST' });
    if (activeGroupId === groupId) setActiveGroup(null);
    await loadGroups();
    loadLeaderboard();
  } catch (err) {
    // A failed leave just means the group is still in the list; the user can retry.
  }
}

function requestUserLocation() {
  if (!navigator.geolocation) {
    useLastLocationOrShowEmptyState("Your browser doesn't support location");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      // A custom pin may have been dropped while this request was still
      // pending (geolocation can take a few seconds to resolve), so don't let
      // a stale result silently override the user's explicit choice.
      if (usingCustomLocation) return;
      userLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
      saveLastLocation(userLocation.lat, userLocation.lng);
      setOriginMarker(userLocation.lat, userLocation.lng);
      recenterMap(userLocation.lat, userLocation.lng);
      scheduleSearch({ immediate: true });
    },
    () => {
      if (usingCustomLocation) return;
      useLastLocationOrShowEmptyState('Location access denied');
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
  focusWithoutScroll(document.getElementById('location-search-input'));
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
  geocodePending = true;
  try {
    const bias = userLocation ? `&lat=${userLocation.lat}&lng=${userLocation.lng}` : '';
    const response = await fetch(`/api/geocode?address=${encodeURIComponent(query)}${bias}`);
    const data = await readApiJson(response);

    if (!response.ok) {
      showLocationBanner(data.error || `Couldn't find "${query}". Try a different search.`);
      return;
    }

    inputEl.value = '';
    setOriginMarker(data.lat, data.lng);
    recenterMap(data.lat, data.lng);
    geocodePending = false;
    onLocationPicked(data.lat, data.lng, 'search');
  } catch (err) {
    showLocationBanner("Couldn't reach the server. Check your connection and try again.");
  } finally {
    inputEl.disabled = false;
    if (geocodePending) {
      geocodePending = false;
      // Failed geocode: a tap queued behind it would otherwise spin forever.
      if (pendingRecommendation && !restaurantsLoading) {
        pendingRecommendation = false;
        getRecommendation();
      }
    }
  }
}

function onLocationPicked(lat, lng, source) {
  // A recommendation from the area being left must not land on the new one.
  if (!pendingRecommendation) {
    invalidateRecommendation();
    setRecommendButtonThinking(false);
  }
  userLocation = { lat, lng };
  usingCustomLocation = true;
  saveLastLocation(lat, lng);
  closeLocationPicker();
  const message = source === 'search'
    ? 'Searching near your chosen location. Dismiss to switch back to your current location.'
    : 'Searching near your dropped pin. Dismiss to switch back to your current location.';
  showLocationBanner(message);
  scheduleSearch({ immediate: true });
}

// Price is intentionally NOT a query param (see item 4): it never reaches
// Google, so a price-tier change can be a pure client-side re-filter of
// allRestaurants with zero network round trip (see applyLocalFilters).
function applyLocalFilters() {
  lastFilteredRestaurants = currentFilters.price
    ? allRestaurants.filter(r => r.price == null || r.price <= currentFilters.price)
    : allRestaurants.slice();
  renderMarkers(lastFilteredRestaurants);
  showNoResults(lastFilteredRestaurants.length === 0, allRestaurants.length > 0);
}

// Reuses the no-location empty-state card; a separate element so it never
// touches the location/error banners.
function showNoResults(empty, hiddenByPrice) {
  const el = document.getElementById('no-results-state');
  if (empty) {
    document.getElementById('no-results-title').textContent = hiddenByPrice
      ? 'No restaurants match your price filter'
      : 'No restaurants found nearby';
    document.getElementById('no-results-hint').textContent = hiddenByPrice
      ? 'Try a higher price range to see more places.'
      : 'Try a wider distance, a different cuisine, or search another area.';
  }
  el.hidden = !empty;
}

// Client-side result cache for stale-while-revalidate (see loadRestaurants).
// Keyed like the server's placesCache (3-decimal lat/lng, ~110m) plus every
// filter that changes what the server returns, and the account, since the
// server folds a signed-in user's dietary restrictions into the query.
const SEARCH_CACHE_KEY = 'ff_search_cache_v1';
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
const SEARCH_CACHE_MAX = 8;

function searchCacheKey(params) {
  return [
    Number(params.get('lat')).toFixed(3), Number(params.get('lng')).toFixed(3),
    params.get('cuisine') || '', params.get('maxDistance') || '', (params.get('dish') || '').toLowerCase(),
    params.get('groupId') || '', currentUser ? currentUser.id : 'guest'
  ].join('|');
}

function readSearchCacheStore() {
  try {
    const store = JSON.parse(localStorage.getItem(SEARCH_CACHE_KEY) || '{}');
    return store && typeof store === 'object' ? store : {};
  } catch {
    return {};
  }
}

function readSearchCache(key) {
  const entry = readSearchCacheStore()[key];
  if (!entry || Date.now() - entry.at > SEARCH_CACHE_TTL_MS || !Array.isArray(entry.restaurants)) return null;
  return entry.restaurants.length > 0 ? entry.restaurants : null;
}

function writeSearchCache(key, restaurants) {
  if (!restaurants || restaurants.length === 0) return;
  try {
    const store = readSearchCacheStore();
    store[key] = { at: Date.now(), restaurants };
    const keys = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
    keys.slice(SEARCH_CACHE_MAX).forEach(k => delete store[k]);
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(store));
  } catch {
    // Quota or private mode: the cache is an optimisation, losing it is fine.
  }
}

// seq/signal come from scheduleSearch's sequence guard (item 6): every render
// path below bails out if a newer search has since started, so an
// out-of-order response can never overwrite fresher results.
async function loadRestaurants(seq, signal) {
  if (!userLocation) {
    showNoLocationState();
    restaurantsLoading = false;
    cancelPendingRecommendation('Set a location first: allow location access or tap the pin to choose a spot.');
    return;
  }
  hideNoLocationState();

  const params = new URLSearchParams();
  params.set('lat', userLocation.lat);
  params.set('lng', userLocation.lng);
  if (currentFilters.cuisine) params.set('cuisine', currentFilters.cuisine);
  if (currentFilters.maxDistance) params.set('maxDistance', currentFilters.maxDistance);
  if (currentFilters.dish) params.set('dish', currentFilters.dish);
  if (activeGroupId) params.set('groupId', activeGroupId);

  // Stale-while-revalidate: if this exact search (same ~110m spot, same
  // filters, same account) ran recently, paint its markers now and let the
  // fresh response below reconcile them (renderMarkers diffs, so unchanged
  // markers don't flicker). restaurantsLoading stays true until the fresh
  // data lands, so Surprise Me never picks from the cached copy.
  const cacheKey = searchCacheKey(params);
  const cached = readSearchCache(cacheKey);
  if (cached) {
    allRestaurants = cached;
    applyLocalFilters();
    if (PERF) console.log(`[perf] search cached-paint n=${cached.length}`);
  }

  // The very first load has nothing on screen yet, so the full blocking
  // overlay is fine; every refinement after that uses the non-blocking pill
  // instead so the map and existing markers stay visible (item 9).
  const isInitialLoad = allRestaurants.length === 0;
  const t0 = performance.now();
  if (isInitialLoad) showLoading('Scanning nearby spots…');
  else showRefining();
  pendingRestPromise = null;
  searchStartedAt = Date.now();

  // Deadline for this request. iOS can freeze a fetch forever when the app is
  // backgrounded mid-request; without this, restaurantsLoading would stay
  // true and every Surprise Me after it would queue behind a search that
  // never finishes.
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), SEARCH_TIMEOUT_MS);
  const fetchSignal = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline.signal]) : signal;

  try {
    const response = await fetch(`/api/restaurants?${params.toString()}`, { signal: fetchSignal });
    const data = await readApiJson(response);
    if (seq !== searchSeq) return; // superseded by a newer search while this was in flight

    if (!response.ok) {
      showLocationBanner(data.error || "Couldn't load restaurants nearby. Try again in a moment.");
    }

    if (response.ok && !Array.isArray(data.restaurants)) showLocationBanner(apiErrorFallback(500));
    allRestaurants = Array.isArray(data.restaurants) ? data.restaurants : [];
    if (response.ok) writeSearchCache(cacheKey, allRestaurants);
    applyLocalFilters();
    fitToResults(lastFilteredRestaurants, userLocation);
    if (!pendingRecommendation) hideTicket(); // a queued Surprise Me keeps its skeleton card
    loadProgress();
    perfLog('search phase1', t0);

    if (isInitialLoad) hideLoading(); else hideRefining();
    restaurantsLoading = false;
    // A "Surprise Me" click that landed while this search was still in
    // flight (e.g. right after dropping a pin) previously got silently
    // swallowed by the loading overlay. This replays it now that fresh
    // restaurant data for the new location is actually in lastFilteredRestaurants.
    if (pendingRecommendation) {
      pendingRecommendation = false;
      getRecommendation();
    }

    if (data.searchId && !data.complete) {
      // Phase 2: pages 2-3 filling in the background on the server. Not
      // awaited here - additive re-render (item 13, in renderMarkers) when it
      // lands, or silently kept at phase-1 results if it fails/times out.
      const restParams = new URLSearchParams(params);
      restParams.set('searchId', data.searchId);
      pendingRestPromise = fetch(`/api/restaurants/rest?${restParams.toString()}`, { signal })
        .then(r => (r.ok || r.status === 410) ? r.json() : null)
        .then(more => {
          if (!more || seq !== searchSeq) return;
          if (more.restaurants && more.restaurants.length > 0) {
            allRestaurants = more.restaurants;
            writeSearchCache(cacheKey, allRestaurants);
            applyLocalFilters();
            if (!pickedMarkerId) fitToResults(lastFilteredRestaurants, userLocation); // do not yank the map off a shown pick
            perfLog('search phase2', t0);
          }
        })
        .catch(() => {}) // aborted or failed: keep phase-1 results
        .finally(() => { pendingRestPromise = null; });
    }
  } catch (err) {
    // Superseded by a newer search, which owns the loading state now. A
    // deadline abort is a real failure and falls through.
    if (err.name === 'AbortError' && !deadline.signal.aborted) return;
    if (seq === searchSeq) {
      const message = deadline.signal.aborted
        ? 'Finding restaurants took too long. Try again in a moment.'
        : "Couldn't reach the server. Check your connection and try again.";
      showLocationBanner(message);
      restaurantsLoading = false;
      cancelPendingRecommendation(message);
      if (isInitialLoad) hideLoading(); else hideRefining();
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function renderRestaurantSuggestions(query) {
  const list = document.getElementById('restaurant-suggestions');
  const trimmed = query.trim().toLowerCase();

  if (!trimmed) {
    list.replaceChildren();
    list.hidden = true;
    return;
  }

  const matches = lastFilteredRestaurants
    .filter(r => r.name.toLowerCase().includes(trimmed))
    .slice(0, 6);

  list.replaceChildren();
  matches.forEach(restaurant => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = restaurant.name;
    // mousedown (not click) fires before the input's blur, and
    // preventDefault() there stops focus from ever leaving the input,
    // so the list doesn't get hidden by the blur handler before this runs.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      document.getElementById('visit-restaurant').value = restaurant.name;
      list.replaceChildren();
      list.hidden = true;
    });
    li.appendChild(button);
    list.appendChild(li);
  });

  list.hidden = matches.length === 0;
}

function setRecommendButtonThinking(thinking) {
  const button = document.getElementById('recommend-btn');
  // Only the text span changes, so the sparkle icon stays (and spins).
  const label = button.querySelector('.cta-label') || button;
  if (!label.dataset.idleLabel) label.dataset.idleLabel = label.textContent;
  button.disabled = thinking;
  label.textContent = thinking ? 'Thinking…' : label.dataset.idleLabel;
  button.classList.toggle('is-thinking', thinking);
}

// A Surprise Me that was queued behind a search (pendingRecommendation) when
// that search then failed: say so instead of leaving the button spinning.
function cancelPendingRecommendation(message) {
  if (!pendingRecommendation) return;
  pendingRecommendation = false;
  setRecommendButtonThinking(false);
  showTicketError(message);
}

const RECOMMEND_TIMEOUT_MS = 30000;
let recommendSeq = 0;
let recommendAbort = null;
let lastStaleRetryAt = 0; // limits the quiet search-and-replay to once per 30 s
let geocodePending = false; // a typed location is still being geocoded

function invalidateRecommendation() {
  recommendSeq++;
  if (recommendAbort) recommendAbort.abort();
  recommendAbort = null;
}

async function getRecommendation() {
  // Skeleton card instead of the old full-screen overlay: the map stays
  // visible and pannable, and the card appears exactly where the answer will
  // land, so the streamed restaurant/dish fill in place instead of popping in.
  // Shown right away even when queued behind a search, so a tap always
  // visibly does something.
  ticketDismissed = false;
  setRecommendButtonThinking(true);
  showTicketSkeleton();

  // The newest request wins: drop whatever older one is still in flight.
  invalidateRecommendation();
  const seq = recommendSeq;

  // !appStarted: Maps (and so the first search) hasn't loaded yet; replay once it has.
  // geocodePending: a typed location is still resolving; replay once it lands.
  if (restaurantsLoading || !appStarted || geocodePending) {
    pendingRecommendation = true;
    return;
  }

  const t0 = performance.now();
  const finish = () => {
    if (seq !== recommendSeq) return; // a newer request owns the button now
    setRecommendButtonThinking(false);
    hideLoading();
  };

  if (pendingRestPromise && lastFilteredRestaurants.length === 0) {
    // Only wait for the phase-2 background fetch (pages 2-3) when phase 1
    // found nothing. Otherwise phase 1's top 20 is plenty to pick from, and
    // waiting cost seconds (Google makes the next page wait ~2s to exist).
    // Capped: a request stalled by iOS suspending the app must not hang this.
    await Promise.race([pendingRestPromise, new Promise(r => setTimeout(r, 6000))]);
    if (seq !== recommendSeq) return;
  }

  if (lastFilteredRestaurants.length === 0) {
    showTicketError('No restaurants match your filters. Try widening your distance or price range.');
    finish();
    return;
  }

  // Without a deadline, a stream that iOS froze (app backgrounded mid-answer)
  // would leave the button stuck on "Thinking…" for good.
  const timeout = new AbortController();
  recommendAbort = timeout;
  const timeoutTimer = setTimeout(() => timeout.abort(), RECOMMEND_TIMEOUT_MS);
  try {
    const response = await fetch('/api/recommend', {
      method: 'POST',
      signal: timeout.signal,
      // Asks for the streamed variant (see /api/recommend): the restaurant
      // shows up as soon as Claude has picked it, and the dish/reason fill in
      // as they're written. A server that doesn't stream (or an error before
      // streaming starts) just answers with plain JSON, handled below.
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
      body: JSON.stringify({
        restaurants: lastFilteredRestaurants,
        price: currentFilters.price,
        groupSize: currentFilters.groupSize,
        sharing: currentFilters.sharing,
        dish: currentFilters.dish,
        groupId: activeGroupId,
        recentPickIds: recentPickIds.slice(-3)
      })
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const data = await readApiJson(response);
      if (seq !== recommendSeq) return;
      if (!response.ok) {
        // 400 = the server no longer recognises these places (restart/deploy
        // lost its memory). Re-run the search once to re-register them, then replay.
        if (response.status === 400 && Date.now() - lastStaleRetryAt > 30000) {
          lastStaleRetryAt = Date.now();
          pendingRecommendation = true;
          scheduleSearch({ immediate: true });
          return;
        }
        showTicketError(data.error);
        return;
      }
      showRecommendation(data);
      perfLog('recommend', t0);
      return;
    }

    let finished = false;
    await readEventStream(response, (event, data) => {
      if (ticketDismissed || seq !== recommendSeq) return;
      if (event === 'pick') {
        hideLoading();
        showTicketStreaming(data.restaurant);
        haptics.success();
        highlightPick(data.restaurant.id, lastFilteredRestaurants);
        centerOnPick(data.restaurant.lat, data.restaurant.lng);
        perfLog('recommend first-pick', t0);
      } else if (event === 'partial') {
        updateTicketStreaming(data);
      } else if (event === 'result') {
        finished = true;
        showRecommendation(data);
        perfLog('recommend', t0);
      } else if (event === 'error') {
        finished = true;
        showTicketError((data && data.error) || apiErrorFallback(500));
      }
    });
    if (!finished && seq === recommendSeq) showTicketError("The recommendation got cut off. Try again in a moment.");
  } catch (err) {
    if (seq !== recommendSeq) return; // superseded (aborted), not a failure
    showTicketError(timeout.signal.aborted
      ? 'That took too long. Tap Surprise Me to try again.'
      : "Couldn't reach the server. Check your connection and try again.");
  } finally {
    clearTimeout(timeoutTimer);
    finish();
  }
}

// Minimal SSE reader over a fetch() body (EventSource can't POST).
async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffered.indexOf('\n\n')) !== -1) {
      const raw = buffered.slice(0, sep);
      buffered = buffered.slice(sep + 2);
      let event = 'message';
      let data = '';
      raw.split('\n').forEach(line => {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      });
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

// Ids of the last few picked places, sent so Surprise Me avoids repeating them.
const recentPickIds = [];

function showRecommendation(data) {
  if (data.restaurant && typeof data.restaurant.id === 'string') {
    recentPickIds.push(data.restaurant.id);
    if (recentPickIds.length > 3) recentPickIds.shift();
  }
  const previousPickId = lastRecommendation && lastRecommendation.restaurant.id;
  // The streamed path already fired this at the reveal (the pick event).
  if (!streamedPickId) haptics.success();
  showTicket(data);
  // The streamed `pick` already highlighted and centred this restaurant; only
  // redo it if the validated result ended up naming a different one.
  if (previousPickId !== data.restaurant.id || !streamedPickId) {
    highlightPick(data.restaurant.id, lastFilteredRestaurants);
    centerOnPick(data.restaurant.lat, data.restaurant.lng);
  }
  streamedPickId = null;
}

function setTicketRestaurant(restaurant) {
  const nameEl = document.getElementById('ticket-name');
  nameEl.classList.remove('skeleton-line');
  nameEl.textContent = restaurant.name;
  document.getElementById('ticket').classList.remove('is-skeleton');
  document.getElementById('ticket-cuisine').textContent = restaurant.cuisine;
  document.getElementById('ticket-price').textContent = restaurant.price ? '$'.repeat(restaurant.price) : '';
  document.getElementById('ticket-rating').textContent = restaurant.rating != null ? `★ ${restaurant.rating}` : '';
  document.getElementById('ticket-distance').textContent = `${restaurant.distance} mi`;
}

// Streaming state of the card: the restaurant is known (and its place_id
// already checked against the candidates server-side), the rest is still
// being written. Placeholder lines hold the space so nothing jumps around
// when the text lands; the Maps/log links stay hidden until the validated
// result arrives, since the result can still swap in a different pick.
let streamedPickId = null;
function showTicketStreaming(restaurant) {
  streamedPickId = restaurant.id;
  lastRecommendation = { restaurant, dish: { name: '', flavorTags: [], sharedItems: [] }, reason: '' };
  const ticket = document.getElementById('ticket');
  setTicketRestaurant(restaurant);
  document.getElementById('ticket-shared-items').replaceChildren();
  document.getElementById('ticket-flavors').replaceChildren();
  const dishEl = document.getElementById('ticket-dish');
  dishEl.textContent = '';
  dishEl.classList.add('skeleton-line');
  const reasonEl = document.getElementById('ticket-reason');
  reasonEl.textContent = '';
  reasonEl.classList.add('skeleton-block');
  ticket.classList.remove('ticket--error');
  ticket.classList.add('visible', 'is-streaming');
}

function updateTicketStreaming({ dish, reason }) {
  const dishEl = document.getElementById('ticket-dish');
  const reasonEl = document.getElementById('ticket-reason');
  if (dish) {
    dishEl.classList.remove('skeleton-line');
    dishEl.textContent = `Order: ${dish}`;
  }
  if (reason) {
    reasonEl.classList.remove('skeleton-block');
    reasonEl.textContent = reason;
  }
}

function showTicket(data) {
  lastRecommendation = data;
  const ticket = document.getElementById('ticket');
  ticket.classList.remove('is-streaming');
  document.getElementById('ticket-dish').classList.remove('skeleton-line');
  document.getElementById('ticket-reason').classList.remove('skeleton-block');
  setTicketRestaurant(data.restaurant);

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
  haptics.warning();
  const ticket = document.getElementById('ticket');
  document.getElementById('ticket-name').classList.remove('skeleton-line');
  document.getElementById('ticket-name').textContent = 'No match';
  ticket.classList.remove('is-skeleton');
  document.getElementById('ticket-reason').textContent = message;
  document.getElementById('ticket-dish').classList.remove('skeleton-line');
  document.getElementById('ticket-reason').classList.remove('skeleton-block');
  ticket.classList.remove('is-streaming');
  ticket.classList.add('visible', 'ticket--error');
}

let ticketDismissed = false;

function showTicketSkeleton() {
  const ticket = document.getElementById('ticket');
  const nameEl = document.getElementById('ticket-name');
  nameEl.textContent = '';
  nameEl.classList.add('skeleton-line');
  ['ticket-cuisine', 'ticket-price', 'ticket-rating', 'ticket-distance'].forEach(id => {
    document.getElementById(id).textContent = '';
  });
  document.getElementById('ticket-shared-items').replaceChildren();
  document.getElementById('ticket-flavors').replaceChildren();
  const dishEl = document.getElementById('ticket-dish');
  dishEl.textContent = '';
  dishEl.classList.add('skeleton-line');
  const reasonEl = document.getElementById('ticket-reason');
  reasonEl.textContent = '';
  reasonEl.classList.add('skeleton-block');
  ticket.classList.remove('ticket--error');
  ticket.classList.add('visible', 'is-streaming', 'is-skeleton');
}

function hideTicket() {
  const ticket = document.getElementById('ticket');
  const hadFocus = ticket.contains(document.activeElement);
  ticket.classList.remove('visible');
  if (hadFocus) focusWithoutScroll(document.getElementById('recommend-btn'));
}

async function loadRecentVisits() {
  try {
    const response = await fetch('/api/visits');
    const data = await readApiJson(response);
    recentVisits = data.visits || [];
    visitsHasMore = recentVisits.length >= 50;
    renderVisitList();
  } catch (err) {
    // Leave whatever visit list is already rendered from the last successful load.
  }
}

async function loadOlderVisits() {
  const last = recentVisits[recentVisits.length - 1];
  if (!last) return;
  try {
    const q = new URLSearchParams({ beforeLoggedAt: last.loggedAt, beforeId: last.id });
    const response = await fetch('/api/visits?' + q);
    const data = await response.json();
    const seen = new Set(recentVisits.map(v => v.id));
    const older = (data.visits || []).filter(v => !seen.has(v.id));
    recentVisits.push(...older);
    visitsHasMore = (data.visits || []).length >= 50;
    renderVisitList();
  } catch (err) {
    // Keep the button so the user can retry.
  }
}
document.getElementById('visit-more').addEventListener('click', loadOlderVisits);

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

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'visit-item-delete';
  del.textContent = 'Delete';
  del.setAttribute('aria-label', `Delete visit to ${visit.restaurantName}`);
  del.addEventListener('click', () => deleteVisitAction(visit));
  li.appendChild(del);

  return li;
}

async function deleteVisitAction(visit) {
  if (!confirm(`Delete your visit to ${visit.restaurantName}?`)) return;
  try {
    const response = await fetch(`/api/visits/${visit.id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      alert("Couldn't delete that visit. Try again.");
      return;
    }
  } catch (err) {
    alert("Couldn't reach the server. Check your connection and try again.");
    return;
  }
  recentVisits = recentVisits.filter(v => v.id !== visit.id);
  renderVisitList();
  loadProgress({ force: true });
  loadStreaks();
  loadBadges();
  loadLeaderboard();
}

function renderVisitList() {
  const list = document.getElementById('visit-list');
  const empty = document.getElementById('visit-empty');

  list.replaceChildren();
  recentVisits.forEach(visit => list.appendChild(visitItemElement(visit)));
  empty.hidden = recentVisits.length > 0;
  document.getElementById('visit-more').hidden = !visitsHasMore;
}

function resetVisitForm() {
  document.getElementById('visit-restaurant').value = '';
  document.getElementById('restaurant-suggestions').hidden = true;
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
  const input = document.getElementById('visit-restaurant');
  input.value = data.restaurant.name;
  document.getElementById('visit-dish').value = data.dish.name;
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

let visitSaving = false;
let visitAttempt = null;

async function submitVisit() {
  const status = document.getElementById('visit-status');
  const restaurantName = document.getElementById('visit-restaurant').value.trim();
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

  if (visitSaving) return;
  visitSaving = true;
  const tappedAt = new Date().toISOString();
  const saveButton = document.querySelector('#visit-form button[type="submit"]');
  saveButton.disabled = true;
  saveButton.setAttribute('aria-busy', 'true');

  // Same key until the save succeeds or the form content changes, so a retry after a lost response is deduped by the server.
  const signature = JSON.stringify([restaurantName, dish, rating]);
  if (!visitAttempt || visitAttempt.signature !== signature) {
    const key = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    visitAttempt = { signature, key };
  }

  try {
    const response = await fetch('/api/visits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantName, dish, rating, flavorTags, idempotencyKey: visitAttempt.key })
    });

    const data = await readApiJson(response);

    if (!response.ok) {
      status.textContent = data.error;
      status.className = 'visit-status visit-status--error';
      status.hidden = false;
      return;
    }

    visitAttempt = null;
    recentVisits.unshift(data.visit);
    renderVisitList();
    resetVisitForm();
    status.textContent = 'Visit logged!';
    haptics.success();
    status.className = 'visit-status visit-status--ok';
    status.hidden = false;
    loadProgress({ force: true });
    loadStreaks();
    loadBadges();
    loadLeaderboard();
  } catch (err) {
    // No signal: keep the visit (with the tap time) and sync it later with the same idempotency key.
    const queued = enqueueVisit({ restaurantName, dish, rating, flavorTags, idempotencyKey: visitAttempt.key, loggedAt: tappedAt });
    if (queued) {
      visitAttempt = null;
      resetVisitForm();
      status.textContent = 'Saved offline. It will sync when you are back online.';
      status.className = 'visit-status';
    } else {
      status.textContent = "Couldn't reach the server. Check your connection and try again.";
      status.className = 'visit-status visit-status--error';
    }
    status.hidden = false;
  } finally {
    visitSaving = false;
    saveButton.disabled = false;
    saveButton.removeAttribute('aria-busy');
  }
}

const VISIT_QUEUE_KEY = 'ff-visit-queue';
let flushingVisits = false;

function readVisitQueue() {
  try { return JSON.parse(localStorage.getItem(VISIT_QUEUE_KEY)) || []; } catch (e) { return []; }
}

function enqueueVisit(item) {
  try {
    localStorage.setItem(VISIT_QUEUE_KEY, JSON.stringify([...readVisitQueue(), item]));
    return true;
  } catch (e) { return false; }
}

async function flushVisitQueue() {
  if (flushingVisits) return;
  flushingVisits = true;
  let synced = false;
  try {
    for (const item of readVisitQueue()) {
      let response;
      try {
        response = await fetch('/api/visits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item)
        });
      } catch (e) { break; }
      // Keep on 5xx and on 401 (signed out, not a bad visit); drop on other 2xx/4xx.
      if (response.status >= 500 || response.status === 401) break;
      try {
        localStorage.setItem(VISIT_QUEUE_KEY, JSON.stringify(readVisitQueue().filter(q => q.idempotencyKey !== item.idempotencyKey)));
      } catch (e) { break; }
      if (response.ok) synced = true;
    }
  } finally {
    flushingVisits = false;
  }
  if (synced) {
    loadRecentVisits();
    loadProgress({ force: true });
    loadStreaks();
    loadBadges();
  }
}

window.addEventListener('online', flushVisitQueue);

async function loadPreferences() {
  try {
    const response = await fetch('/api/preferences');
    const data = await readApiJson(response);
    preferences = data.preferences;

    if (!preferences && !localStorage.getItem(`ff_prefs_skipped_${currentUser.id}`)) {
      openPreferencesDialog();
    }
  } catch (err) {
    // No network - skip the preferences prompt rather than leaving it hanging.
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
    const data = await readApiJson(response);
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
  const status = document.getElementById('prefs-status');

  try {
    const response = await fetch('/api/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favoriteCuisines, dietaryRestrictions, spiceTolerance })
    });

    const data = await readApiJson(response);

    if (!response.ok) {
      status.textContent = data.error;
      status.className = 'visit-status visit-status--error';
      status.hidden = false;
      return;
    }

    // The server folds restrictions into the Places query, so refetch if they changed.
    const restrictionsChanged = JSON.stringify(((preferences && preferences.dietaryRestrictions) || []).slice().sort()) !==
      JSON.stringify((data.preferences.dietaryRestrictions || []).slice().sort());
    preferences = data.preferences;
    status.hidden = true;
    document.getElementById('prefs-dialog').close();
    if (restrictionsChanged) scheduleSearch({ immediate: true });
  } catch (err) {
    status.textContent = "Couldn't reach the server. Check your connection and try again.";
    status.className = 'visit-status visit-status--error';
    status.hidden = false;
  }
}

window.addEventListener('maps-loaded', () => {
  mapsReady = true;
  tryStartApp();
  // Results/location may have arrived before the map existed; paint them now.
  if (userLocation) {
    setOriginMarker(userLocation.lat, userLocation.lng);
    recenterMap(userLocation.lat, userLocation.lng);
  }
  renderMarkers(lastFilteredRestaurants);
});

// Handlers bind as soon as the (deferred) script runs so taps work while the
// Maps script is still loading; map.js helpers no-op until `map` exists.
init();

// Native shell setup (iOS/Capacitor only; a no-op in a browser). Runs as
// soon as this script does rather than in init(), which waits for the ~480KB
// Maps script: the sign-in screen / top bar are already painted by now, so
// holding the splash until Maps loaded just hid a usable UI for no reason.
// Every plugin call is feature-detected and its rejection swallowed, since
// Capacitor.Plugins hands back a stub for plugins the build doesn't include.
// The page never scrolls (html/body are fixed), so any scroll position iOS
// leaves behind is an offset between where things draw and where taps land.
function focusWithoutScroll(el) {
  el.focus({ preventScroll: true });
}

function resetPageScroll() {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

function setupNativeShell() {
  if (!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) return;
  const plugins = window.Capacitor.Plugins;
  const safely = (fn) => {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Plugin not in this build of the shell.
    }
  };

  // launchAutoHide is off (capacitor.config.json) so the native splash covers
  // the remote page load instead of a blank flash. Two frames = the first
  // frame with real content has actually been committed to the screen.
  requestAnimationFrame(() => requestAnimationFrame(() => safely(() => plugins.SplashScreen.hide())));

  // Light status bar content on the dark theme. Also set in
  // capacitor.config.json; repeated here for shells built before that.
  safely(() => plugins.SystemBars.setStyle({ style: 'DARK' }));

  // Keyboard. The plugin's "native" resize mode shrinks the web view's frame
  // and, on iOS 18 with contentInset "never", never gives the safe-area
  // height back: after the keyboard opens once the page draws 47px lower
  // than where WebKit hit-tests taps, so everything in the top bar goes dead.
  // Turn resizing off (capacitor.config.json says the same for new builds;
  // this covers shells already installed) and leave room for the keyboard
  // in CSS instead, via --kb-height.
  safely(() => plugins.Keyboard.setResizeMode({ mode: 'none' }));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  safely(() => plugins.Keyboard.addListener('keyboardWillShow', (info) => {
    document.documentElement.style.setProperty('--kb-height', `${Math.round(info?.keyboardHeight || 0)}px`);
    document.body.classList.add('keyboard-open');
    // Keep a field lower in the sheet (Log a Visit, groups) above the keyboard.
    const el = document.activeElement;
    if (el && el.matches('input, textarea, select') && el.closest('#tab-drawer')) {
      setTimeout(() => el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' }), 50);
    }
  }));
  safely(() => plugins.Keyboard.addListener('keyboardWillHide', () => {
    document.documentElement.style.setProperty('--kb-height', '0px');
    document.body.classList.remove('keyboard-open');
    resetPageScroll();
  }));
  safely(() => plugins.Keyboard.addListener('keyboardDidHide', resetPageScroll));
  window.visualViewport?.addEventListener('resize', () => {
    if (!document.body.classList.contains('keyboard-open')) resetPageScroll();
  });

  // App builds from before Sept 27 2026 have contentInset "always" (and no
  // Keyboard plugin). Once the keyboard has opened, iOS insets the web view
  // by the safe areas itself and never takes it back, so the page's own
  // safe-area padding doubles up: a black band under the status bar and the
  // whole UI pushed down. Spot that state (the viewport is short by exactly
  // the safe areas) and drop our top padding while it lasts.
  const insetProbe = document.createElement('div');
  insetProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(insetProbe);
  const syncNativeInset = () => {
    const cs = getComputedStyle(insetProbe);
    const safeTop = parseFloat(cs.paddingTop) || 0;
    const safeBottom = parseFloat(cs.paddingBottom) || 0;
    const portrait = window.innerHeight > window.innerWidth;
    const missing = Math.max(screen.width, screen.height) - window.innerHeight;
    const insetByIOS = portrait && safeTop > 0 && Math.abs(missing - (safeTop + safeBottom)) <= 4;
    document.documentElement.classList.toggle('native-top-inset', insetByIOS);
  };
  syncNativeInset();
  window.addEventListener('resize', syncNativeInset);
  window.visualViewport?.addEventListener('resize', syncNativeInset);
  document.addEventListener('focusout', () => setTimeout(syncNativeInset, 600));

}

setupNativeShell();
bindAuthEvents();
checkAuth();

// App-shell cache (public/sw.js). Feature-detected: WKWebView only exposes
// navigator.serviceWorker for App-Bound Domains, so inside the iOS shell this
// is a no-op until that's configured. Registered after load so it never
// competes with first paint or the Maps download.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Unsupported or blocked (private mode, policy): the app works without it.
    });
  });
}
