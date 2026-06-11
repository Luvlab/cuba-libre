import { qs, qsr, qsn } from '../utils/query';
/**
 * news.ts — Cuban news RSS aggregator for Cuba Libre
 * Fetches from official Cuban media + independent / diaspora sources.
 * Caches 30 min in-memory. Persists articles to NewsArchive.
 * Filter by province, category, or language.
 */

import { Router, Request, Response } from 'express';
import prisma from '../db';

const router = Router();

// ─── Sources ──────────────────────────────────────────────────────────────────

const ALL_SOURCES = [
  // Cuba official
  { name: 'Granma',               url: 'https://www.granma.cu/rss.xml',                                           province: null, lang: 'es', category: 'politics' },
  { name: 'Cubadebate',           url: 'http://www.cubadebate.cu/feed/',                                          province: null, lang: 'es', category: null },
  { name: 'Juventud Rebelde',     url: 'https://www.juventudrebelde.cu/rss.xml',                                   province: null, lang: 'es', category: null },
  { name: 'Trabajadores',         url: 'https://www.trabajadores.cu/feed/',                                        province: null, lang: 'es', category: null },
  { name: 'ACN Cuba',             url: 'https://www.acn.cu/rss.xml',                                              province: null, lang: 'es', category: null },
  // Independent / diaspora
  { name: '14ymedio',             url: 'https://www.14ymedio.com/rss.xml',                                        province: null, lang: 'es', category: null },
  { name: 'El Toque',             url: 'https://eltoque.com/feed/',                                               province: null, lang: 'es', category: 'culture' },
  { name: 'CiberCuba',            url: 'https://www.cibercuba.com/feed',                                          province: null, lang: 'es', category: null },
  { name: 'Periódico Cubano',     url: 'https://www.periodicocubano.com/feed/',                                   province: null, lang: 'es', category: null },
  { name: 'Cuba en Resumen',      url: 'https://www.cubaenresumen.org/feed/',                                     province: null, lang: 'es', category: null },
  { name: 'Diario de Cuba',       url: 'https://diariodecuba.com/rss.xml',                                       province: null, lang: 'es', category: null },
  { name: 'OnCuba News',          url: 'https://oncubanews.com/feed/',                                           province: null, lang: 'es', category: null },
  { name: 'Radio Televisión Martí', url: 'https://www.radiotelevisionmarti.com/api/zn%24rssfeeder/',             province: null, lang: 'es', category: null },
  { name: 'Havana Times',         url: 'https://havanatimes.org/feed/',                                          province: null, lang: 'en', category: null },
  { name: 'Cuba Money Project',   url: 'https://cubamoneyproject.com/feed/',                                     province: null, lang: 'en', category: 'economy' },
  { name: 'Cuba News Agency',     url: 'http://www.cubanews.ain.cu/rss.xml',                                     province: null, lang: 'en', category: null },
];

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CachedItem {
  title:       string;
  link:        string;
  summary:     string | null;
  image:       string | null;
  source:      string;
  province:    string | null;
  category:    string | null;
  lang:        string;
  publishedat: Date | null;
}

let cache: CachedItem[] = [];
let cacheExpiry = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

// ─── RSS Parser (no external library, minimal approach) ───────────────────────

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]+${attr}="([^"]+)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

async function fetchFeed(source: typeof ALL_SOURCES[0]): Promise<CachedItem[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(source.url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!resp.ok) return [];
    const xml = await resp.text();

    const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
    const items: CachedItem[] = [];
    let match: RegExpExecArray | null;

    while ((match = itemPattern.exec(xml)) !== null) {
      const itemXml = match[1];
      const title   = extractTag(itemXml, 'title');
      const link    = extractTag(itemXml, 'link') ?? extractAttr(itemXml, 'link', 'href');
      if (!title || !link) continue;

      const pubDate = extractTag(itemXml, 'pubDate');
      const description = extractTag(itemXml, 'description');
      const imgMatch = itemXml.match(/url="([^"]+\.(jpg|jpeg|png|webp))"/i)
        ?? itemXml.match(/<img[^>]+src="([^"]+)"/i);

      items.push({
        title:       title.replace(/<[^>]+>/g, '').trim(),
        link:        link.trim(),
        summary:     description ? description.replace(/<[^>]+>/g, '').trim().substring(0, 500) : null,
        image:       imgMatch ? imgMatch[1] : null,
        source:      source.name,
        province:    source.province,
        category:    source.category ?? null,
        lang:        source.lang,
        publishedat: pubDate ? new Date(pubDate) : null,
      });
    }

    return items;
  } catch {
    return [];
  }
}

async function refreshCache(): Promise<CachedItem[]> {
  const results = await Promise.allSettled(ALL_SOURCES.map(fetchFeed));
  const all: CachedItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Deduplicate by link
  const seen = new Set<string>();
  const unique = all.filter(i => { if (seen.has(i.link)) return false; seen.add(i.link); return true; });

  // Sort newest first
  unique.sort((a, b) => {
    const at = a.publishedat?.getTime() ?? 0;
    const bt = b.publishedat?.getTime() ?? 0;
    return bt - at;
  });

  // Persist to DB (upsert by link)
  const toSave = unique.slice(0, 200);
  for (const item of toSave) {
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

async function getNews(): Promise<CachedItem[]> {
  if (Date.now() < cacheExpiry && cache.length > 0) return cache;
  return refreshCache();
}

// ─── GET /news ────────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const { province, category, lang, source, page = '1', limit = '30' } = req.query as Record<string, string>;
    let items = await getNews();

    if (province) items = items.filter(i => i.province === province);
    if (category) items = items.filter(i => i.category === category);
    if (lang)     items = items.filter(i => i.lang === lang);
    if (source)   items = items.filter(i => i.source === source);

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const paged = items.slice(skip, skip + parseInt(limit));

    res.json({ articles: paged, total: items.length, page: parseInt(page), limit: parseInt(limit) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /news/sources ────────────────────────────────────────────────────────

router.get('/sources', (_req: Request, res: Response) => {
  res.json(ALL_SOURCES.map(s => ({
    name:     s.name,
    url:      s.url,
    province: s.province,
    lang:     s.lang,
    category: s.category,
  })));
});

// ─── GET /news/refresh (admin trigger) ───────────────────────────────────────

router.post('/refresh', async (_req: Request, res: Response) => {
  try {
    cacheExpiry = 0;
    const items = await getNews();
    res.json({ refreshed: true, count: items.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
