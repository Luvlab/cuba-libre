// ===== PROVINCE PICKER =====
document.querySelectorAll('.province-card').forEach(card => {
  card.addEventListener('click', function () {
    document.querySelectorAll('.province-card').forEach(c => c.classList.remove('active-province'));
    this.classList.add('active-province');
    const name = this.querySelector('.prov-name').textContent;
    document.querySelector('.province-btn').innerHTML = `<span>🇨🇺</span> ${name} <span class="arrow">▾</span>`;
  });
});

// ===== NEWS FILTERS =====
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
  });
});

// ===== NAV ACTIVE STATE =====
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', function (e) {
    const href = this.getAttribute('href');
    if (href && href.startsWith('#')) return; // let anchor links scroll
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    this.classList.add('active');
  });
});

// ===== SMOOTH SCROLL FOR ANCHOR LINKS =====
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth' }); }
  });
});

// ===== HERO SEARCH =====
document.querySelector('.hero-search')?.addEventListener('keypress', e => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    // TODO: wire to search API
    console.log('Search:', e.target.value);
  }
});

// ===== LIBRE BALANCE (mock until backend ready) =====
function animateLibreCount() {
  // Simulate Libre in circulation counter
  const el = document.querySelector('.libre-count');
  if (!el) return;
  let count = 0;
  const target = 24800;
  const step = Math.ceil(target / 60);
  const interval = setInterval(() => {
    count = Math.min(count + step, target);
    el.textContent = count.toLocaleString();
    if (count >= target) clearInterval(interval);
  }, 30);
}

// ===== INTERSECTION OBSERVER — animate sections in =====
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
      if (entry.target.classList.contains('stats-bar')) animateLibreCount();
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.feature-card, .libre-card, .solidarity-card, .tier-card, .province-card, .news-card, .stats-bar').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(16px)';
  el.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
  observer.observe(el);
});

// ===== STICKY HEADER SHADOW =====
window.addEventListener('scroll', () => {
  document.querySelector('.header').style.boxShadow =
    window.scrollY > 10 ? '0 4px 28px rgba(0,0,0,0.4)' : '0 2px 20px rgba(0,0,0,0.3)';
}, { passive: true });

// ===== PWA INSTALL PROMPT =====
let deferredPrompt;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  // Could show a "Install App" banner here for Cuban users
  console.log('PWA install available');
});

// ===== SERVICE WORKER =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
