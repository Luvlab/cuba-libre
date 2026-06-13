/**
 * news.ts — Cuban news RSS aggregator for Cuba Libre
 *
 * Priority order:
 *   1. Spanish-language sources always ranked above English for same date window
 *   2. Independent / diaspora above state media (diversity of voices)
 *   3. Provincial newspapers surfaced when filtering by province
 *
 * Cache: 30 min in-memory. Persists newest 300 articles to NewsArchive DB.
 * Sources: 60+ Cuban RSS feeds across national, provincial, independent, diaspora.
 */

import { Router, Request, Response } from 'express';
import { qs, qsn } from '../utils/query';
import prisma from '../db';

const router = Router();

// ─── Source registry ──────────────────────────────────────────────────────────

type Source = {
  name:     string;
  url:      string;
  province: string | null;  // null = national
  lang:     'es' | 'en' | 'fr';
  category: string | null;
  tier:     1 | 2 | 3;     // 1 = independent/diaspora, 2 = state-adjacent, 3 = official state
};

const ALL_SOURCES: Source[] = [

  // ── INDEPENDENT / DIASPORA (tier 1 — highest priority) ────────────────────
  { name: '14ymedio',              url: 'https://www.14ymedio.com/rss.xml',                          province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'El Toque',             url: 'https://eltoque.com/feed/',                                  province: null,             lang: 'es', category: 'culture',  tier: 1 },
  { name: 'CiberCuba',            url: 'https://www.cibercuba.com/feed',                             province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'Periódico Cubano',     url: 'https://www.periodicocubano.com/feed/',                      province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'Diario de Cuba',       url: 'https://diariodecuba.com/rss.xml',                          province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'OnCuba News',          url: 'https://oncubanews.com/feed/',                               province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'Cuba en Resumen',      url: 'https://www.cubaenresumen.org/feed/',                        province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'El Estornudo',         url: 'https://medium.com/feed/periodismo-de-barrio',               province: null,             lang: 'es', category: 'culture',  tier: 1 },
  { name: 'La Joven Cuba',        url: 'https://jovencuba.com/feed/',                                province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'Tremenda Nota',        url: 'https://tremendanota.com/feed/',                             province: null,             lang: 'es', category: 'culture',  tier: 1 },
  { name: 'No te Rajes Cuba',     url: 'https://noterajescuba.com/feed/',                            province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'Havana Times',         url: 'https://havanatimes.org/feed/',                              province: null,             lang: 'en', category: null,       tier: 1 },
  { name: 'Radio Televisión Martí', url: 'https://www.radiotelevisionmarti.com/api/zn%24rssfeeder/', province: null,            lang: 'es', category: null,       tier: 1 },
  { name: 'Cuba Money Project',   url: 'https://cubamoneyproject.com/feed/',                         province: null,             lang: 'en', category: 'economy',  tier: 1 },
  { name: 'Cachivache Media',     url: 'https://cachivajemedia.com/feed/',                           province: null,             lang: 'es', category: 'culture',  tier: 1 },
  { name: 'El Toque Cultura',     url: 'https://eltoque.com/cultura/feed/',                          province: null,             lang: 'es', category: 'culture',  tier: 1 },
  { name: 'Periodismo de Barrio', url: 'https://periodismodebarrio.org/feed/',                       province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'La Historia Detrás',   url: 'https://lahistoriadetrasdela.com/feed/',                     province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'Alma Mater',           url: 'https://almamater.cu/feed/',                                 province: null,             lang: 'es', category: 'education',tier: 1 },
  { name: 'Cuba Headlines',       url: 'https://www.cubaheadlines.com/rss.xml',                      province: null,             lang: 'en', category: null,       tier: 1 },
  { name: 'Cuba News Agency',     url: 'http://www.cubanews.ain.cu/rss.xml',                         province: null,             lang: 'en', category: null,       tier: 1 },
  { name: 'CubaSí',              url: 'https://cubasi.cu/rss.xml',                                  province: null,             lang: 'es', category: null,       tier: 1 },
  { name: 'El Caiman Barbudo',    url: 'https://caimanbarbudocuba.com/feed/',                        province: null,             lang: 'es', category: 'culture',  tier: 1 },
  { name: 'Hypermedia Magazine',  url: 'https://hypermediamagazine.com/feed/',                       province: null,             lang: 'es', category: 'culture',  tier: 1 },

  // ── STATE-ADJACENT / SEMI-OFFICIAL (tier 2) ────────────────────────────────
  { name: 'Cubahora',             url: 'https://www.cubahora.cu/rss.xml',                            province: null,             lang: 'es', category: null,       tier: 2 },
  { name: 'Cubadebate',          url: 'http://www.cubadebate.cu/feed/',                              province: null,             lang: 'es', category: null,       tier: 2 },
  { name: 'Radio Rebelde',        url: 'https://www.radiorebelde.cu/rss.xml',                         province: null,             lang: 'es', category: null,       tier: 2 },
  { name: 'Radio Havana Cuba',    url: 'https://www.radiohc.cu/rss.xml',                             province: null,             lang: 'es', category: null,       tier: 2 },
  { name: 'Radio Habana Cuba EN', url: 'https://www.radiohc.cu/en/rss.xml',                          province: null,             lang: 'en', category: null,       tier: 2 },
  { name: 'Cubainformación',      url: 'https://www.cubainformacion.tv/index.php?format=feed',       province: null,             lang: 'es', category: null,       tier: 2 },
  { name: 'ICRT TV Cubana',       url: 'https://www.tvcubana.icrt.cu/rss.xml',                       province: null,             lang: 'es', category: null,       tier: 2 },
  { name: 'Ecured',               url: 'https://www.ecured.cu/api.php?action=featuredfeed&feed=onthisday&feedformat=rss', province: null, lang: 'es', category: 'education', tier: 2 },
  { name: 'Cuba Posible',         url: 'https://cubaposible.com/feed/',                              province: null,             lang: 'es', category: null,       tier: 2 },
  { name: 'OnCuba EN',            url: 'https://oncubanews.com/en/feed/',                            province: null,             lang: 'en', category: null,       tier: 2 },

  // ── OFFICIAL STATE MEDIA (tier 3) ──────────────────────────────────────────
  { name: 'Granma',               url: 'https://www.granma.cu/rss.xml',                              province: null,             lang: 'es', category: 'politics', tier: 3 },
  { name: 'Juventud Rebelde',     url: 'https://www.juventudrebelde.cu/rss.xml',                     province: null,             lang: 'es', category: null,       tier: 3 },
  { name: 'Trabajadores',         url: 'https://www.trabajadores.cu/feed/',                          province: null,             lang: 'es', category: 'economy',  tier: 3 },
  { name: 'ACN Cuba',             url: 'https://www.acn.cu/rss.xml',                                 province: null,             lang: 'es', category: null,       tier: 3 },
  { name: 'Agencia Cubana Noticias', url: 'https://www.ain.cu/rss.xml',                             province: null,             lang: 'es', category: null,       tier: 3 },
  { name: 'Bohemia',              url: 'https://bohemia.cu/feed/',                                   province: null,             lang: 'es', category: 'culture',  tier: 3 },
  { name: 'Opciones',             url: 'https://www.opciones.cu/feed/',                              province: null,             lang: 'es', category: 'economy',  tier: 3 },

  // ── PROVINCIAL NEWSPAPERS ──────────────────────────────────────────────────
  { name: 'Sierra Maestra',       url: 'https://sierramaestra.cu/feed/',                             province: 'Santiago de Cuba', lang: 'es', category: null,      tier: 2 },
  { name: 'Invasor Ciego Ávila',  url: 'https://invasor.cu/feed/',                                  province: 'Ciego de Ávila', lang: 'es', category: null,        tier: 2 },
  { name: 'Adelante Camagüey',    url: 'https://www.adelante.cu/feed/',                             province: 'Camagüey',        lang: 'es', category: null,        tier: 2 },
  { name: 'Ahora Holguín',        url: 'https://www.ahora.cu/feed/',                                province: 'Holguín',         lang: 'es', category: null,        tier: 2 },
  { name: 'Escambray Sancti',     url: 'https://www.escambray.cu/feed/',                            province: 'Sancti Spíritus', lang: 'es', category: null,        tier: 2 },
  { name: 'Vanguardia Villa Clara', url: 'https://vanguardia.cu/feed/',                             province: 'Villa Clara',     lang: 'es', category: null,        tier: 2 },
  { name: 'Granma Provincial',    url: 'https://www.granma.cu/granma/rss.xml',                       province: 'Granma',         lang: 'es', category: null,        tier: 3 },
  { name: 'Periódico Matanzas',   url: 'https://www.periodico26.cu/feed/',                          province: 'Matanzas',        lang: 'es', category: null,        tier: 2 },
  { name: 'Girón Matanzas',       url: 'https://www.giron.cu/feed/',                               province: 'Matanzas',        lang: 'es', category: null,        tier: 2 },
  { name: 'Cienfuegos Online',    url: 'https://www.5septiembre.cu/feed/',                          province: 'Cienfuegos',      lang: 'es', category: null,        tier: 2 },
  { name: 'Guerrillero P del Río', url: 'https://www.guerrillero.cu/feed/',                         province: 'Pinar del Río',   lang: 'es', category: null,        tier: 2 },
  { name: 'La Demajagua Granma',  url: 'https://www.lademajagua.cu/feed/',                          province: 'Granma',         lang: 'es', category: null,        tier: 2 },
  { name: 'Tribuna Las Tunas',    url: 'https://www.tribuna.cu/feed/',                              province: 'Las Tunas',       lang: 'es', category: null,        tier: 2 },
  { name: 'Periódico Guantánamo', url: 'https://www.venceremos.cu/feed/',                           province: 'Guantánamo',      lang: 'es', category: null,        tier: 2 },

  // ── THEMATIC ───────────────────────────────────────────────────────────────
  { name: 'Cubarte',              url: 'http://www.cubarte.cult.cu/rss.xml',                         province: null,             lang: 'es', category: 'culture',  tier: 2 },
  { name: 'Cubasolar',            url: 'http://www.cubasolar.cu/feed/',                              province: null,             lang: 'es', category: 'technology', tier: 2 },
  { name: 'MINREX Cuba',          url: 'http://www.minrex.gob.cu/rss.xml',                           province: null,             lang: 'es', category: 'politics', tier: 3 },
  { name: 'MINSAP Salud',         url: 'https://salud.msp.gob.cu/feed/',                            province: null,             lang: 'es', category: 'health',   tier: 3 },
  { name: 'Deportes Cuba',        url: 'https://www.inder.gob.cu/rss.xml',                           province: null,             lang: 'es', category: 'sports',   tier: 3 },
  { name: 'JIT Cuba Tech',        url: 'https://www.jit.cu/feed/',                                  province: null,             lang: 'es', category: 'technology', tier: 1 },
  { name: 'Razones de Cuba',      url: 'https://www.razonesdecuba.cu/feed/',                         province: null,             lang: 'es', category: null,       tier: 2 },
];

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface Article {
  title:       string;
  link:        string;
  summary:     string | null;
  image:       string | null;
  source:      string;
  province:    string | null;
  category:    string | null;
  lang:        string;
  tier:        number;
  publishedat: Date | null;
}

let cache: Article[] = [];
let cacheExpiry = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

// ─── Lightweight XML parser ───────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]+${attr}="([^"]+)"`, 'i');
  const m  = xml.match(re);
  return m ? m[1] : null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

async function fetchFeed(source: Source): Promise<Article[]> {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const resp  = await fetch(source.url, {
      signal:  ctrl.signal,
      headers: { 'User-Agent': 'CubaLibre/1.0 (+https://cuba.red) RSS Aggregator — free platform for the Cuban people' },
    });
    clearTimeout(timer);

    if (!resp.ok) return [];
    const xml = await resp.text();

    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    const items: Article[] = [];
    let m: RegExpExecArray | null;

    while ((m = itemRe.exec(xml)) !== null) {
      const it    = m[1];
      const title = extractTag(it, 'title');
      const link  = extractTag(it, 'link') ?? extractAttr(it, 'link', 'href');
      if (!title || !link) continue;

      const pubDate = extractTag(it, 'pubDate') ?? extractTag(it, 'dc:date') ?? extractTag(it, 'published');
      const desc    = extractTag(it, 'description') ?? extractTag(it, 'content:encoded') ?? extractTag(it, 'summary');
      const imgMatch = it.match(/url="([^"]+\.(?:jpg|jpeg|png|webp))"/i)
        ?? it.match(/<media:thumbnail[^>]+url="([^"]+)"/i)
        ?? it.match(/<img[^>]+src="([^"]+)"/i);

      // Extract province from enclosure or category if not already set at source level
      const catTag = extractTag(it, 'category');

      items.push({
        title:       stripHtml(title),
        link:        link.trim(),
        summary:     desc ? stripHtml(desc).substring(0, 600) : null,
        image:       imgMatch?.[1] ?? null,
        source:      source.name,
        province:    source.province,
        category:    source.category ?? (catTag ? stripHtml(catTag).toLowerCase() : null),
        lang:        source.lang,
        tier:        source.tier,
        publishedat: pubDate ? new Date(pubDate) : null,
      });
    }

    return items;
  } catch {
    return [];
  }
}

// ─── Scoring & sorting ────────────────────────────────────────────────────────
// Priority: (1) Spanish language, (2) lower tier number (more independent), (3) recency

function scoreArticle(a: Article): number {
  const ageMs  = Date.now() - (a.publishedat?.getTime() ?? 0);
  const ageH   = ageMs / (1000 * 60 * 60);
  const langBonus = a.lang === 'es' ? 50 : (a.lang === 'fr' ? 10 : 0);   // Spanish first
  const tierBonus = (4 - a.tier) * 20;                                     // Independent first
  const freshBonus = Math.max(0, 72 - ageH) * 2;                           // Last 72h gets boost
  return langBonus + tierBonus + freshBonus;
}

async function refreshCache(): Promise<Article[]> {
  const results = await Promise.allSettled(ALL_SOURCES.map(fetchFeed));
  const all: Article[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Deduplicate by link
  const seen   = new Set<string>();
  const unique = all.filter(i => { if (seen.has(i.link)) return false; seen.add(i.link); return true; });

  // Sort by score (Spanish + independent + fresh = highest)
  unique.sort((a, b) => scoreArticle(b) - scoreArticle(a));

  // Persist newest 300 to DB
  for (const item of unique.slice(0, 300)) {
    await prisma.newsArchive.upsert({
      where:  { link: item.link },
      update: {},
      create: {
        title:       item.title,
        link:        item.link,
        summary:     item.summary,
        image:       item.image,
        source:      item.source,
        province:    item.province,
        category:    item.category,
        lang:        item.lang,
        publishedat: item.publishedat ?? undefined,
      },
    }).catch(() => {});
  }

  cache       = unique;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return unique;
}

async function getNews(): Promise<Article[]> {
  if (Date.now() < cacheExpiry && cache.length > 0) return cache;
  return refreshCache();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /news — main feed
router.get('/', async (req: Request, res: Response) => {
  try {
    let items = await getNews();

    const province = qs(req.query.province);
    const category = qs(req.query.category);
    const lang     = qs(req.query.lang);
    const source   = qs(req.query.source);
    const tier     = qs(req.query.tier);
    const page     = qsn(req.query.page, 1);
    const limit    = qsn(req.query.limit, 30);

    if (province) items = items.filter(i => i.province === province);
    if (category) items = items.filter(i => i.category === category);
    if (lang)     items = items.filter(i => i.lang === lang);
    if (source)   items = items.filter(i => i.source === source);
    if (tier)     items = items.filter(i => i.tier === parseInt(tier));

    const skip  = (page - 1) * limit;
    const paged = items.slice(skip, skip + limit);

    res.json({
      articles:  paged,
      total:     items.length,
      page,
      limit,
      note:      'Spanish-language sources prioritised. tier=1 independent/diaspora, tier=2 semi-official, tier=3 state media.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /news/sources — list all configured sources
router.get('/sources', (_req, res) => {
  const byTier = {
    independent: ALL_SOURCES.filter(s => s.tier === 1).map(s => ({ name: s.name, lang: s.lang, province: s.province, category: s.category })),
    semiOfficial: ALL_SOURCES.filter(s => s.tier === 2).map(s => ({ name: s.name, lang: s.lang, province: s.province })),
    stateMedia:   ALL_SOURCES.filter(s => s.tier === 3).map(s => ({ name: s.name, lang: s.lang, province: s.province })),
  };
  res.json({
    total: ALL_SOURCES.length,
    spanish: ALL_SOURCES.filter(s => s.lang === 'es').length,
    english: ALL_SOURCES.filter(s => s.lang === 'en').length,
    provincial: ALL_SOURCES.filter(s => s.province !== null).length,
    byTier,
  });
});

// GET /news/categories — available categories
router.get('/categories', (_req, res) => {
  const cats = [...new Set(ALL_SOURCES.map(s => s.category).filter(Boolean))];
  res.json(cats);
});

// GET /news/provinces — provincial news available
router.get('/provinces', (_req, res) => {
  const provs = [...new Set(ALL_SOURCES.filter(s => s.province).map(s => s.province))];
  res.json(provs);
});

// POST /news/refresh — admin trigger to force cache refresh
router.post('/refresh', async (_req, res) => {
  try {
    cacheExpiry = 0;
    const items = await getNews();
    res.json({ refreshed: true, count: items.length, sources: ALL_SOURCES.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /news/archive — read from DB (persisted history)
router.get('/archive', async (req: Request, res: Response) => {
  try {
    const province = qs(req.query.province);
    const category = qs(req.query.category);
    const lang     = qs(req.query.lang);
    const page     = qsn(req.query.page, 1);
    const limit    = qsn(req.query.limit, 30);

    const where: Record<string, unknown> = {};
    if (province) where.province = province;
    if (category) where.category = category;
    if (lang)     where.lang     = lang;

    const [articles, total] = await Promise.all([
      prisma.newsArchive.findMany({
        where,
        orderBy: [{ lang: 'asc' }, { publishedat: 'desc' }], // 'es' sorts before 'en'
        skip:  (page - 1) * limit,
        take:  limit,
      }),
      prisma.newsArchive.count({ where }),
    ]);

    res.json({ articles, total, page, limit });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
