// News filter tabs
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
  });
});

// Main nav active state
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', function () {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    this.classList.add('active');
  });
});

// Province card click
document.querySelectorAll('.province-card').forEach(card => {
  card.addEventListener('click', function () {
    document.querySelectorAll('.province-card').forEach(c => c.classList.remove('active-province'));
    this.classList.add('active-province');
    const name = this.querySelector('.prov-name').textContent;
    document.querySelector('.province-btn').innerHTML =
      `<span>🇨🇺</span> ${name} <span class="arrow">▾</span>`;
  });
});

// Search on Enter
document.querySelector('.hero-search')?.addEventListener('keypress', e => {
  if (e.key === 'Enter') {
    const val = e.target.value.trim();
    if (val) alert(`Searching for: "${val}"`);
  }
});

// Smooth scroll for #support links
document.querySelectorAll('a[href="#support"]').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    document.querySelector('#support')?.scrollIntoView({ behavior: 'smooth' });
  });
});

// Sticky header shadow on scroll
window.addEventListener('scroll', () => {
  const header = document.querySelector('.header');
  if (window.scrollY > 10) {
    header.style.boxShadow = '0 4px 24px rgba(0,0,0,0.35)';
  } else {
    header.style.boxShadow = '0 2px 16px rgba(0,0,0,0.25)';
  }
});
