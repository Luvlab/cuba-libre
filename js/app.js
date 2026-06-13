/**
 * app.js — Cuba Libre frontend
 * Wires the UI to the real Express/Supabase API.
 *
 * API base is read from window.CUBA_API (set in index.html) or falls back to
 * the Vercel production URL. For local dev, add:
 *   <script>window.CUBA_API = 'http://localhost:3001';</script>
 * before this script tag.
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const API = window.CUBA_API || 'https://api.cuba.red';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  token:    localStorage.getItem('cuba_token'),
  user:     JSON.parse(localStorage.getItem('cuba_user') || 'null'),
  province: 'La Habana',
  lang:     localStorage.getItem('cuba_lang') || 'es',
};

// ─── API helper ───────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function setAuth(token, user) {
  state.token = token;
  state.user  = user;
  localStorage.setItem('cuba_token', token);
  localStorage.setItem('cuba_user', JSON.stringify(user));
  renderAuthState();
}

function clearAuth() {
  state.token = null;
  state.user  = null;
  localStorage.removeItem('cuba_token');
  localStorage.removeItem('cuba_user');
  renderAuthState();
}

function renderAuthState() {
  const loginBtn   = document.querySelector('.login-btn');
  const balanceBtn = document.querySelector('.libre-balance-btn');

  if (state.user) {
    loginBtn.textContent = state.user.name?.split(' ')[0] || 'Me';
    loadLibreBalance();
  } else {
    loginBtn.textContent = 'Login';
    if (balanceBtn) balanceBtn.textContent = '⚡ Libre';
  }
}

function loadLibreBalance() {
  if (!state.token) return;
  api('/api/libre/balance').then(data => {
    const btn = document.querySelector('.libre-balance-btn');
    if (btn) btn.textContent = `⚡ ${Number(data.balance).toLocaleString()} L`;
  }).catch(() => {});
}

// ─── Auth Modal ───────────────────────────────────────────────────────────────

function showAuthModal(mode = 'login') {
  const existing = document.getElementById('auth-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'auth-modal';
  modal.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop"></div>
    <div class="modal-box">
      <button class="modal-close" id="modal-close">✕</button>
      <div class="modal-tabs">
        <button class="modal-tab ${mode === 'login' ? 'active' : ''}" data-mode="login">Entrar</button>
        <button class="modal-tab ${mode === 'register' ? 'active' : ''}" data-mode="register">Registrarse</button>
      </div>
      <div id="auth-error" class="auth-error" style="display:none"></div>
      <form id="auth-form">
        <div id="register-fields" style="display:${mode === 'register' ? 'block' : 'none'}">
          <input type="text" id="auth-name" placeholder="Nombre completo" autocomplete="name">
          <input type="text" id="auth-province" placeholder="Provincia" list="province-list">
          <datalist id="province-list">
            ${['Pinar del Río','Artemisa','La Habana','Mayabeque','Matanzas','Cienfuegos','Villa Clara','Sancti Spíritus','Ciego de Ávila','Camagüey','Las Tunas','Holguín','Granma','Santiago de Cuba','Guantánamo','Isla de la Juventud'].map(p => `<option value="${p}">`).join('')}
          </datalist>
        </div>
        <input type="email" id="auth-email" placeholder="Correo electrónico" required autocomplete="email">
        <input type="password" id="auth-password" placeholder="Contraseña" required autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
        <button type="submit" class="auth-submit" id="auth-submit">
          ${mode === 'login' ? 'Entrar' : 'Crear cuenta (+100 Libre)'}
        </button>
      </form>
      <div class="auth-google">
        <span>o</span>
        <button class="google-btn" id="google-btn">Continuar con Google</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('visible'));

  let currentMode = mode;

  document.getElementById('modal-close').addEventListener('click', closeAuthModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeAuthModal);

  modal.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentMode = tab.dataset.mode;
      modal.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === currentMode));
      document.getElementById('register-fields').style.display = currentMode === 'register' ? 'block' : 'none';
      document.getElementById('auth-submit').textContent = currentMode === 'login' ? 'Entrar' : 'Crear cuenta (+100 Libre)';
      document.getElementById('auth-password').autocomplete = currentMode === 'login' ? 'current-password' : 'new-password';
    });
  });

  document.getElementById('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn   = document.getElementById('auth-submit');
    const errEl = document.getElementById('auth-error');
    btn.disabled = true;
    btn.textContent = '...';
    errEl.style.display = 'none';

    try {
      const body = {
        email:    document.getElementById('auth-email').value,
        password: document.getElementById('auth-password').value,
      };
      if (currentMode === 'register') {
        body.name     = document.getElementById('auth-name').value;
        body.province = document.getElementById('auth-province').value;
      }
      const data = await api(`/api/auth/${currentMode}`, { method: 'POST', body: JSON.stringify(body) });
      setAuth(data.token, data.user);
      closeAuthModal();
      if (currentMode === 'register') showToast('¡Bienvenido! +100 Libre acreditados 🎉');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = currentMode === 'login' ? 'Entrar' : 'Crear cuenta (+100 Libre)';
    }
  });

  document.getElementById('google-btn').addEventListener('click', () => {
    window.location.href = `${API}/api/auth/google`;
  });

  document.getElementById('auth-email').focus();
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  modal.classList.remove('visible');
  setTimeout(() => modal.remove(), 250);
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 300); }, 3500);
}

// ─── News ─────────────────────────────────────────────────────────────────────

const NEWS_CATEGORIES = ['All', 'Havana', 'Santiago', 'Camagüey', 'Diaspora', 'Economy', 'Culture'];

let currentNewsFilter = 'all';
let allNewsArticles   = [];

function timeAgo(dateStr) {
  const d    = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 3600)   return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400)  return `hace ${Math.floor(diff / 3600)}h`;
  if (diff < 172800) return 'ayer';
  return d.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' });
}

async function loadNews() {
  try {
    const params = new URLSearchParams({ limit: '12', lang: state.lang });
    if (currentNewsFilter !== 'all') params.set('category', currentNewsFilter);
    const data = await api(`/api/news?${params}`);
    allNewsArticles = data.articles || data || [];
    renderNews(allNewsArticles);
    updateNewsSources(data.sources || []);
  } catch {
    // Keep mock content visible if API is down
  }
}

function renderNews(articles) {
  const grid = document.querySelector('.news-grid');
  if (!grid || !articles.length) return;

  grid.innerHTML = articles.slice(0, 6).map((a, i) => {
    const tag      = a.category || a.province || (a.tier === 1 ? 'Independiente' : a.lang === 'es' ? 'Cuba' : 'Diaspora');
    const ageLabel = a.publishedat ? timeAgo(a.publishedat) : 'Reciente';
    const featured = i === 0 ? 'featured-news' : '';
    const tierCls  = a.tier === 1 ? 'tier-1' : a.tier === 2 ? 'tier-2' : 'tier-3';
    return `
      <div class="news-card ${featured}">
        <div class="news-tag ${tierCls}">${tag}</div>
        <h3><a href="${a.link || a.url || '#'}" target="_blank" rel="noopener noreferrer">${a.title}</a></h3>
        <p class="news-meta">${a.source || a.feed} · ${a.province ? a.province + ' · ' : ''}${ageLabel}</p>
      </div>
    `;
  }).join('');
}

function updateNewsSources(sources) {
  const container = document.querySelector('.news-sources');
  if (!container || !sources.length) return;
  const shown = sources.slice(0, 6);
  const rest  = sources.length - shown.length;
  container.innerHTML = `
    <span class="sources-label">Fuentes:</span>
    ${shown.map(s => `<span class="source-tag">${s.name || s}</span>`).join('')}
    ${rest > 0 ? `<span class="source-tag">+ ${rest} más</span>` : ''}
  `;
}

function setupNewsFilters() {
  const container = document.querySelector('.province-filter');
  if (!container) return;

  // Replace static buttons with dynamic ones
  container.innerHTML = NEWS_CATEGORIES.map((cat, i) =>
    `<button class="filter-btn${i === 0 ? ' active' : ''}" data-filter="${cat.toLowerCase()}">${cat}</button>`
  ).join('');

  container.addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentNewsFilter = btn.dataset.filter;
    loadNews();
  });
}

// ─── Stats bar ────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const data = await api('/api/libre/stats');
    const libEl = document.querySelector('.libre-count');
    if (libEl) {
      animateNumber(libEl, 0, Number(data.totalSupply || data.inCirculation || 0), 1200);
    }
  } catch {}

  // Update news sources count from news sources endpoint
  try {
    const data = await api('/api/news/sources');
    const el   = document.querySelectorAll('.stat-num')[2]; // 3rd stat = News Sources
    if (el && data.total) el.textContent = `${data.total}+`;
  } catch {}
}

function animateNumber(el, from, to, duration) {
  const start = performance.now();
  const update = now => {
    const p = Math.min((now - start) / duration, 1);
    el.textContent = Math.floor(from + (to - from) * p).toLocaleString();
    if (p < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

// ─── Province cards ───────────────────────────────────────────────────────────

async function loadProvinceStats() {
  try {
    // Try /api/geo/province-stats if it exists; fall back to individual counts
    const data = await api('/api/geo/province-stats').catch(() => null);
    if (!data) return;

    document.querySelectorAll('.province-card').forEach(card => {
      const name = card.querySelector('.prov-name')?.textContent?.trim();
      if (!name) return;
      const match = data.find(d => d.province?.toLowerCase() === name.toLowerCase());
      if (!match) return;
      const countEl = card.querySelector('.prov-count');
      if (countEl) countEl.textContent = `${Number(match._count?.id || match.count || 0).toLocaleString()} listings`;
    });
  } catch {}
}

// ─── Search ───────────────────────────────────────────────────────────────────

let searchTimer = null;

async function doSearch(query) {
  if (!query || query.length < 2) return;
  try {
    const params = new URLSearchParams({
      q:       query,
      limit:   '10',
      lang:    state.lang,
    });
    if (state.province) params.set('province', state.province);
    const data = await api(`/api/listings?${params}`);
    showSearchResults(data.listings || data || [], query);
  } catch (err) {
    console.error('Search error:', err.message);
  }
}

function showSearchResults(listings, query) {
  let panel = document.getElementById('search-results-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'search-results-panel';
    panel.className = 'search-results-panel';
    document.querySelector('.search-widget')?.appendChild(panel);
  }

  if (!listings.length) {
    panel.innerHTML = `<div class="sr-empty">No results for "${query}"</div>`;
    panel.classList.add('open');
    return;
  }

  panel.innerHTML = listings.map(l => `
    <div class="sr-item" data-id="${l.id}">
      <span class="sr-type">${l.category || l.type}</span>
      <span class="sr-name">${l.name}</span>
      <span class="sr-province">${l.province}</span>
      ${l.phone ? `<a class="sr-phone" href="tel:${l.phone}">${l.phone}</a>` : ''}
    </div>
  `).join('') + (listings.length >= 10 ? `<div class="sr-more" data-query="${query}">Ver todos los resultados →</div>` : '');

  panel.classList.add('open');
}

function closeSearchResults() {
  const panel = document.getElementById('search-results-panel');
  if (panel) panel.classList.remove('open');
}

function setupSearch() {
  const inputs = document.querySelectorAll('.hero-search, .top-search input');
  const btns   = document.querySelectorAll('.find-btn');

  inputs.forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSearchResults(); return; }
      if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(e.target.value.trim()); return; }
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(e.target.value.trim()), 350);
    });
  });

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.querySelector('.hero-search');
      if (input?.value.trim()) doSearch(input.value.trim());
    });
  });

  // Close search panel on click outside
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-widget') && !e.target.closest('.top-search')) {
      closeSearchResults();
    }
  });
}

// ─── Solidarity / Stripe checkout ─────────────────────────────────────────────

async function startSolidarityCheckout(tier) {
  if (!state.token) { showAuthModal('register'); return; }
  try {
    const data = await api('/api/solidarity/checkout', {
      method: 'POST',
      body:   JSON.stringify({ tier, successUrl: window.location.href, cancelUrl: window.location.href }),
    });
    if (data.url) window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Error al iniciar el pago', 'error');
  }
}

function setupSolidarityButtons() {
  // Tier buttons
  document.querySelectorAll('.tier-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const card = btn.closest('.tier-card');
      const tier = card?.querySelector('.tier-name')?.textContent?.toLowerCase()?.replace('ñ', 'n') || 'amigo';
      const tierMap = { amigo: 'amigo', companero: 'companero', patrocinador: 'patrocinador' };
      startSolidarityCheckout(tierMap[tier] || 'amigo');
    });
  });

  // Solidarity option buttons
  document.querySelectorAll('.s-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.token) showAuthModal('register');
      else showToast('Próximamente: envío directo a usuarios de Cuba 🇨🇺', 'info');
    });
  });
}

// ─── Province picker ─────────────────────────────────────────────────────────

function setupProvincePicker() {
  const provinceBtn = document.querySelector('.province-btn');
  if (!provinceBtn) return;

  document.querySelectorAll('.province-card').forEach(card => {
    card.addEventListener('click', function () {
      document.querySelectorAll('.province-card').forEach(c => c.classList.remove('active-province'));
      this.classList.add('active-province');
      const name = this.querySelector('.prov-name').textContent.trim();
      state.province = name;
      provinceBtn.innerHTML = `<span>🇨🇺</span> ${name.split(' ')[0]} <span class="arrow">▾</span>`;
      loadNews(); // reload news for this province
    });
  });
}

// ─── Language switcher ────────────────────────────────────────────────────────

function setupLangSwitcher() {
  const btn = document.querySelector('.lang-btn');
  if (!btn) return;
  btn.textContent = state.lang.toUpperCase();
  btn.addEventListener('click', () => {
    state.lang = state.lang === 'es' ? 'en' : 'es';
    localStorage.setItem('cuba_lang', state.lang);
    btn.textContent = state.lang.toUpperCase();
    loadNews(); // reload in new language
    showToast(state.lang === 'es' ? 'Idioma: Español' : 'Language: English', 'info');
  });
}

// ─── Auth button ─────────────────────────────────────────────────────────────

function setupAuthButton() {
  const loginBtn = document.querySelector('.login-btn');
  if (!loginBtn) return;
  loginBtn.addEventListener('click', () => {
    if (state.user) {
      // Show a tiny dropdown for logout
      let dropdown = document.getElementById('user-dropdown');
      if (dropdown) { dropdown.remove(); return; }
      dropdown = document.createElement('div');
      dropdown.id = 'user-dropdown';
      dropdown.className = 'user-dropdown';
      dropdown.innerHTML = `
        <div class="ud-name">${state.user.name || state.user.email}</div>
        <div class="ud-item" id="ud-profile">Mi perfil</div>
        <div class="ud-item" id="ud-logout">Cerrar sesión</div>
      `;
      loginBtn.parentElement.appendChild(dropdown);
      document.getElementById('ud-logout').addEventListener('click', () => {
        clearAuth();
        dropdown.remove();
        showToast('Sesión cerrada');
      });
      document.addEventListener('click', e => {
        if (!e.target.closest('.login-btn') && !e.target.closest('.user-dropdown')) {
          dropdown?.remove();
        }
      }, { once: true });
    } else {
      showAuthModal('login');
    }
  });
}

// ─── Libre balance button ─────────────────────────────────────────────────────

function setupLibreButton() {
  const btn = document.querySelector('.libre-balance-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!state.user) showAuthModal('register');
    else showToast('Panel Libre próximamente 🔜', 'info');
  });
}

// ─── Nav active state ─────────────────────────────────────────────────────────

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (href && href.startsWith('#')) return;
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      this.classList.add('active');
    });
  });
}

// ─── Smooth scroll ────────────────────────────────────────────────────────────

function setupSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth' }); }
    });
  });
}

// ─── Sticky header ────────────────────────────────────────────────────────────

function setupStickyHeader() {
  const header = document.querySelector('.header');
  if (!header) return;
  window.addEventListener('scroll', () => {
    header.style.boxShadow = window.scrollY > 10
      ? '0 4px 28px rgba(0,0,0,0.4)' : '0 2px 20px rgba(0,0,0,0.3)';
  }, { passive: true });
}

// ─── Animate on scroll ────────────────────────────────────────────────────────

function setupScrollAnimations() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.style.opacity  = '1';
      entry.target.style.transform = 'translateY(0)';
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.08 });

  document.querySelectorAll('.feature-card, .libre-card, .solidarity-card, .tier-card, .province-card, .news-card, .stats-bar').forEach(el => {
    el.style.opacity    = '0';
    el.style.transform  = 'translateY(18px)';
    el.style.transition = 'opacity 0.45s ease, transform 0.45s ease';
    observer.observe(el);
  });
}

// ─── Google OAuth callback handler ───────────────────────────────────────────

function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token');
  const user   = params.get('user');
  if (token && user) {
    try {
      setAuth(token, JSON.parse(decodeURIComponent(user)));
      showToast('¡Bienvenido! 🇨🇺');
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    } catch {}
  }
}

// ─── PWA ──────────────────────────────────────────────────────────────────────

let deferredInstallPrompt;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  handleOAuthCallback();
  renderAuthState();

  setupNav();
  setupSmoothScroll();
  setupStickyHeader();
  setupScrollAnimations();
  setupSearch();
  setupNewsFilters();
  setupProvincePicker();
  setupLangSwitcher();
  setupAuthButton();
  setupLibreButton();
  setupSolidarityButtons();

  // Async data loads — fire and forget (mock content stays visible until API responds)
  loadNews();
  loadStats();
  loadProvinceStats();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
