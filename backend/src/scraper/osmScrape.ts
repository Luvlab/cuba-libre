/**
 * osmScrape.ts — reusable OSM scrape logic
 *
 * Imported by:
 *   - src/scraper/osm.ts   (CLI: `npm run scrape:osm`)
 *   - src/routes/cron.ts   (Vercel cron: GET /api/cron/scrape-osm)
 *   - .github/workflows/scrape.yml (GitHub Actions — runs this file directly)
 */

import prisma from '../db';
import { CUBA_PROVINCES } from '../config';
import { ListingType } from '@prisma/client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OsmTags {
  [key: string]: string | undefined;
  'name:es'?: string;
  name?: string;
  'name:en'?: string;
  amenity?: string;
  shop?: string;
  tourism?: string;
  leisure?: string;
  office?: string;
  healthcare?: string;
  phone?: string;
  'contact:phone'?: string;
  email?: string;
  'contact:email'?: string;
  website?: string;
  'contact:website'?: string;
  'addr:street'?: string;
  'addr:housenumber'?: string;
  'addr:city'?: string;
  'addr:province'?: string;
  description?: string;
  'description:es'?: string;
  opening_hours?: string;
  whatsapp?: string;
  'contact:whatsapp'?: string;
  operator?: string;
  brand?: string;
}

interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags: OsmTags;
}

interface OsmWay {
  type: 'way';
  id: number;
  center: { lat: number; lon: number };
  tags: OsmTags;
}

type OsmElement = OsmNode | OsmWay;

export interface ScrapeOptions {
  /** Restrict to one province (by canonical name). Default: all Cuba. */
  province?: string;
  /** Restrict to one OSM primary tag type. Default: all. */
  type?: string;
  /** Max elements to request from Overpass. Default: 50 000. */
  limit?: number;
  /** Skip DB writes, just log. Default: false. */
  dryRun?: boolean;
  /** Called with each progress log line. Default: console.log. */
  log?: (msg: string) => void;
}

export interface ScrapeResult {
  created: number;
  updated: number;
  skipped: number;
  total:   number;
}

// ─── Province coordinate map ─────────────────────────────────────────────────

export function coordsToProvince(lat: number, lon: number): string {
  if (lat < 22.15 && lon < -81.5)  return 'Isla de la Juventud';
  if (lon < -83.10) return 'Pinar del Río';
  if (lon < -82.60) return 'Artemisa';
  if (lon < -82.20) return 'La Habana';
  if (lon < -81.90) return 'Mayabeque';
  if (lon < -80.90) return 'Matanzas';
  if (lon < -80.40) return lat > 22.20 ? 'Villa Clara' : 'Cienfuegos';
  if (lon < -79.50) return 'Sancti Spíritus';
  if (lon < -78.70) return 'Ciego de Ávila';
  if (lon < -77.00) return 'Camagüey';
  if (lon < -76.40) return lat > 20.50 ? 'Las Tunas' : 'Granma';
  if (lon < -75.60) return lat > 20.30 ? 'Holguín' : 'Granma';
  if (lon < -75.10) return 'Santiago de Cuba';
  return 'Guantánamo';
}

// ─── Category map ────────────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, { category: string; type: ListingType }> = {
  restaurant:       { category: 'Restaurante',          type: 'BUSINESS' },
  cafe:             { category: 'Café',                 type: 'BUSINESS' },
  bar:              { category: 'Bar',                  type: 'BUSINESS' },
  fast_food:        { category: 'Comida Rápida',        type: 'BUSINESS' },
  food_court:       { category: 'Patio de Comidas',     type: 'BUSINESS' },
  ice_cream:        { category: 'Heladería',            type: 'BUSINESS' },
  hotel:            { category: 'Hotel',                type: 'BUSINESS' },
  hostel:           { category: 'Hostal',               type: 'BUSINESS' },
  guest_house:      { category: 'Casa Particular',      type: 'BUSINESS' },
  hospital:         { category: 'Hospital',             type: 'BUSINESS' },
  clinic:           { category: 'Clínica',              type: 'BUSINESS' },
  pharmacy:         { category: 'Farmacia',             type: 'BUSINESS' },
  dentist:          { category: 'Dentista',             type: 'BUSINESS' },
  doctors:          { category: 'Médico',               type: 'BUSINESS' },
  bank:             { category: 'Banco',                type: 'BUSINESS' },
  bureau_de_change: { category: 'Casa de Cambio',       type: 'BUSINESS' },
  atm:              { category: 'Cajero',               type: 'BUSINESS' },
  school:           { category: 'Escuela',              type: 'GOVERNMENT' },
  university:       { category: 'Universidad',          type: 'GOVERNMENT' },
  college:          { category: 'Instituto',            type: 'GOVERNMENT' },
  police:           { category: 'Policía',              type: 'GOVERNMENT' },
  fire_station:     { category: 'Bomberos',             type: 'GOVERNMENT' },
  post_office:      { category: 'Correo',               type: 'GOVERNMENT' },
  townhall:         { category: 'Ayuntamiento',         type: 'GOVERNMENT' },
  government:       { category: 'Gobierno',             type: 'GOVERNMENT' },
  place_of_worship: { category: 'Iglesia / Templo',     type: 'BUSINESS' },
  arts_centre:      { category: 'Centro de Arte',       type: 'BUSINESS' },
  cinema:           { category: 'Cine',                 type: 'BUSINESS' },
  theatre:          { category: 'Teatro',               type: 'BUSINESS' },
  nightclub:        { category: 'Discoteca',            type: 'BUSINESS' },
  library:          { category: 'Biblioteca',           type: 'GOVERNMENT' },
  marketplace:      { category: 'Mercado',              type: 'BUSINESS' },
  supermarket:      { category: 'Supermercado',         type: 'BUSINESS' },
  fuel:             { category: 'Gasolinera',           type: 'BUSINESS' },
  car_wash:         { category: 'Car Wash',             type: 'BUSINESS' },
  car_repair:       { category: 'Taller Mecánico',      type: 'BUSINESS' },
  bus_station:      { category: 'Terminal de Bus',      type: 'BUSINESS' },
  taxi:             { category: 'Taxi',                 type: 'BUSINESS' },
  bakery:           { category: 'Panadería',            type: 'BUSINESS' },
  butcher:          { category: 'Carnicería',           type: 'BUSINESS' },
  clothes:          { category: 'Ropa',                 type: 'BUSINESS' },
  electronics:      { category: 'Electrónica',          type: 'BUSINESS' },
  hardware:         { category: 'Ferretería',           type: 'BUSINESS' },
  hairdresser:      { category: 'Peluquería',           type: 'BUSINESS' },
  beauty:           { category: 'Salón de Belleza',     type: 'BUSINESS' },
  museum:           { category: 'Museo',                type: 'BUSINESS' },
  gallery:          { category: 'Galería',              type: 'BUSINESS' },
  attraction:       { category: 'Atracción',            type: 'BUSINESS' },
  artwork:          { category: 'Obra de Arte',         type: 'BUSINESS' },
  viewpoint:        { category: 'Mirador',              type: 'BUSINESS' },
  information:      { category: 'Información Turística',type: 'BUSINESS' },
  park:             { category: 'Parque',               type: 'BUSINESS' },
  playground:       { category: 'Parque Infantil',      type: 'BUSINESS' },
  sports_centre:    { category: 'Centro Deportivo',     type: 'BUSINESS' },
  swimming_pool:    { category: 'Piscina',              type: 'BUSINESS' },
  beach_resort:     { category: 'Resort de Playa',      type: 'BUSINESS' },
  ngo:              { category: 'ONG',                  type: 'NGO' },
  association:      { category: 'Asociación',           type: 'NGO' },
  diplomatic:       { category: 'Embajada',             type: 'GOVERNMENT' },
};

export function getCategory(tags: OsmTags): { category: string; type: ListingType } {
  for (const key of ['amenity', 'shop', 'tourism', 'leisure', 'healthcare', 'office'] as const) {
    const val = tags[key];
    if (!val) continue;
    const mapped = CATEGORY_MAP[val];
    if (mapped) return mapped;
    if (key === 'shop')      return { category: 'Tienda',   type: 'BUSINESS' };
    if (key === 'tourism')   return { category: 'Turismo',  type: 'BUSINESS' };
    if (key === 'leisure')   return { category: 'Ocio',     type: 'BUSINESS' };
    if (key === 'healthcare')return { category: 'Salud',    type: 'BUSINESS' };
    if (key === 'office')    return { category: 'Oficina',  type: 'BUSINESS' };
  }
  return { category: 'Negocio', type: 'BUSINESS' };
}

// ─── Tag extractors ───────────────────────────────────────────────────────────

export const extractName     = (t: OsmTags) => t['name:es'] ?? t.name ?? t['name:en'] ?? t.operator ?? t.brand ?? null;
export const extractPhone    = (t: OsmTags) => t.phone ?? t['contact:phone'] ?? null;
export const extractEmail    = (t: OsmTags) => t.email ?? t['contact:email'] ?? null;
export const extractWebsite  = (t: OsmTags) => t.website ?? t['contact:website'] ?? null;
export const extractWhatsapp = (t: OsmTags) => t.whatsapp ?? t['contact:whatsapp'] ?? null;
export const extractDesc     = (t: OsmTags) => t['description:es'] ?? t.description ?? null;
export const extractAddress  = (t: OsmTags) => {
  const parts = [t['addr:housenumber'], t['addr:street']].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
};

// ─── Overpass ─────────────────────────────────────────────────────────────────

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function buildQuery(types: string[], limit: number): string {
  const bbox = '19.8,-85.0,23.3,-74.0';   // Cuba bounding box
  const nodeLines = types.map(t => `  node[${t}](${bbox});`).join('\n');
  const wayLines  = types.map(t => `  way[${t}](${bbox});`).join('\n');
  return `[out:json][timeout:180][maxsize:536870912];\n(\n${nodeLines}\n${wayLines}\n);\nout center tags ${limit};`;
}

async function fetchOverpass(query: string, log: (m: string) => void): Promise<OsmElement[]> {
  let lastErr: Error | null = null;
  for (const endpoint of OVERPASS_MIRRORS) {
    try {
      log(`  → ${endpoint.split('/')[2]}...`);
      const resp = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `data=${encodeURIComponent(query)}`,
        signal:  AbortSignal.timeout(200_000),
      });
      if (!resp.ok) { log(`  ✗ HTTP ${resp.status}`); continue; }
      const json = await resp.json() as { elements: OsmElement[] };
      return json.elements ?? [];
    } catch (e: any) {
      lastErr = e;
      log(`  ✗ ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr ?? new Error('All Overpass mirrors failed');
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runOsmScrape(opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  const {
    province:   filterProvince = undefined,
    type:       filterType     = undefined,
    limit                      = 50_000,
    dryRun                     = false,
    log                        = console.log,
  } = opts;

  const queryTypes = filterType
    ? [filterType]
    : ['amenity', 'shop', 'tourism', 'leisure', 'healthcare', 'office'];

  log(`🗺️  OSM scrape — province:${filterProvince ?? 'all'} type:${filterType ?? 'all'} limit:${limit}${dryRun ? ' DRY-RUN' : ''}`);

  const elements = await fetchOverpass(buildQuery(queryTypes, limit), log);
  log(`   Raw elements: ${elements.length.toLocaleString()}`);

  // Province filter
  const filtered = filterProvince
    ? elements.filter(el => {
        const lat = el.type === 'node' ? el.lat : el.center.lat;
        const lon = el.type === 'node' ? el.lon : el.center.lon;
        return coordsToProvince(lat, lon) === filterProvince ||
               el.tags['addr:province'] === filterProvince;
      })
    : elements;

  // Must have a name
  const named = filtered.filter(el => extractName(el.tags));
  log(`   After name filter: ${named.length.toLocaleString()}`);

  if (dryRun) {
    named.slice(0, 5).forEach(el => {
      const lat = el.type === 'node' ? el.lat : el.center.lat;
      const lon = el.type === 'node' ? el.lon : el.center.lon;
      const prov = el.tags['addr:province'] ?? coordsToProvince(lat, lon);
      const { category, type } = getCategory(el.tags);
      log(`  [${type}] ${extractName(el.tags)} — ${category} — ${prov}`);
    });
    return { created: 0, updated: 0, skipped: 0, total: 0 };
  }

  // Upsert in batches of 100
  let created = 0, updated = 0, skipped = 0;

  for (let i = 0; i < named.length; i += 100) {
    const batch = named.slice(i, i + 100);

    await Promise.all(batch.map(async el => {
      const lat   = el.type === 'node' ? el.lat : el.center.lat;
      const lon   = el.type === 'node' ? el.lon : el.center.lon;
      const tags  = el.tags;
      const osmid = `osm:${el.type}:${el.id}`;
      const name  = extractName(tags);
      if (!name) { skipped++; return; }

      const rawProvince     = tags['addr:province'] ?? coordsToProvince(lat, lon);
      const canonProvince   = CUBA_PROVINCES.find(p =>
        p.toLowerCase() === rawProvince.toLowerCase()
      ) ?? 'La Habana';
      const { category, type } = getCategory(tags);

      const data = {
        name,
        type,
        province:     canonProvince,
        category,
        latitude:     lat,
        longitude:    lon,
        phone:        extractPhone(tags),
        email:        extractEmail(tags),
        website:      extractWebsite(tags),
        whatsapp:     extractWhatsapp(tags),
        address:      extractAddress(tags),
        city:         tags['addr:city'] ?? null,
        description:  extractDesc(tags),
        openinghours: tags.opening_hours ?? null,
        language:     'es',
        active:       true,
        verified:     false,
      };

      try {
        const existing = await prisma.listing.findUnique({ where: { osmid } });
        if (existing) {
          await prisma.listing.update({ where: { osmid }, data });
          updated++;
        } else {
          await prisma.listing.create({ data: { ...data, osmid } });
          created++;
        }
      } catch {
        skipped++;
      }
    }));

    // Log progress every 1 000 records
    if ((i + 100) % 1000 === 0 || i + 100 >= named.length) {
      const done = Math.min(i + 100, named.length);
      log(`   ${done.toLocaleString()}/${named.length.toLocaleString()} — +${created} ~${updated} ✗${skipped}`);
    }
  }

  const total = created + updated;
  log(`✅ done — created:${created} updated:${updated} skipped:${skipped}`);

  await prisma.$disconnect();
  return { created, updated, skipped, total };
}
