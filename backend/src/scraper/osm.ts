/**
 * osm.ts — OpenStreetMap Overpass scraper for Cuba Libre
 *
 * Fetches all businesses, amenities, and POIs in Cuba via the Overpass API
 * and upserts them into the Listing table (keyed on osmid).
 *
 * Usage:
 *   npm run scrape:osm
 *   npm run scrape:osm -- --province "La Habana"
 *   npm run scrape:osm -- --type amenity --limit 5000
 *
 * Overpass rate limits: max 1 req/2s, respect the fair-use policy.
 */

import prisma from '../db';
import { CUBA_PROVINCES } from '../config';
import { ListingType } from '@prisma/client';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const FILTER_PROVINCE  = getArg('--province');
const FILTER_TYPE      = getArg('--type');     // amenity | shop | tourism | leisure
const LIMIT            = parseInt(getArg('--limit') ?? '50000', 10);
const DRY_RUN          = args.includes('--dry-run');

// ─── Province coordinate map (rough bounding-box assignment) ─────────────────
// Cuba is a thin east–west island; longitude alone covers ~90% of cases.

function coordsToProvince(lat: number, lon: number): string {
  // Isla de la Juventud — southwest island
  if (lat < 22.15 && lon < -81.5) return 'Isla de la Juventud';

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

// ─── OSM tag → listing category / type mapping ───────────────────────────────

interface OsmTags {
  [key: string]: string | undefined;
  name?: string;
  'name:es'?: string;
  'name:en'?: string;
  amenity?: string;
  shop?: string;
  tourism?: string;
  leisure?: string;
  office?: string;
  healthcare?: string;
  phone?: string;
  'contact:phone'?: string;
  'phone:mobile'?: string;
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

const CATEGORY_MAP: Record<string, { category: string; type: ListingType }> = {
  // Amenity
  restaurant:        { category: 'Restaurante',         type: 'BUSINESS' },
  cafe:              { category: 'Café',                type: 'BUSINESS' },
  bar:               { category: 'Bar',                 type: 'BUSINESS' },
  fast_food:         { category: 'Comida Rápida',       type: 'BUSINESS' },
  food_court:        { category: 'Patio de Comidas',    type: 'BUSINESS' },
  ice_cream:         { category: 'Heladería',           type: 'BUSINESS' },
  hotel:             { category: 'Hotel',               type: 'BUSINESS' },
  hostel:            { category: 'Hostal',              type: 'BUSINESS' },
  guest_house:       { category: 'Casa Particular',     type: 'BUSINESS' },
  hospital:          { category: 'Hospital',            type: 'BUSINESS' },
  clinic:            { category: 'Clínica',             type: 'BUSINESS' },
  pharmacy:          { category: 'Farmacia',            type: 'BUSINESS' },
  dentist:           { category: 'Dentista',            type: 'BUSINESS' },
  doctors:           { category: 'Médico',              type: 'BUSINESS' },
  bank:              { category: 'Banco',               type: 'BUSINESS' },
  bureau_de_change:  { category: 'Casa de Cambio',      type: 'BUSINESS' },
  atm:               { category: 'Cajero',              type: 'BUSINESS' },
  school:            { category: 'Escuela',             type: 'GOVERNMENT' },
  university:        { category: 'Universidad',         type: 'GOVERNMENT' },
  college:           { category: 'Instituto',           type: 'GOVERNMENT' },
  police:            { category: 'Policía',             type: 'GOVERNMENT' },
  fire_station:      { category: 'Bomberos',            type: 'GOVERNMENT' },
  post_office:       { category: 'Correo',              type: 'GOVERNMENT' },
  townhall:          { category: 'Ayuntamiento',        type: 'GOVERNMENT' },
  government:        { category: 'Gobierno',            type: 'GOVERNMENT' },
  place_of_worship:  { category: 'Iglesia / Templo',   type: 'BUSINESS' },
  arts_centre:       { category: 'Centro de Arte',      type: 'BUSINESS' },
  cinema:            { category: 'Cine',                type: 'BUSINESS' },
  theatre:           { category: 'Teatro',              type: 'BUSINESS' },
  nightclub:         { category: 'Discoteca',           type: 'BUSINESS' },
  library:           { category: 'Biblioteca',          type: 'GOVERNMENT' },
  marketplace:       { category: 'Mercado',             type: 'BUSINESS' },
  supermarket:       { category: 'Supermercado',        type: 'BUSINESS' },
  fuel:              { category: 'Gasolinera',          type: 'BUSINESS' },
  car_wash:          { category: 'Car Wash',            type: 'BUSINESS' },
  car_repair:        { category: 'Taller Mecánico',     type: 'BUSINESS' },
  bus_station:       { category: 'Terminal de Bus',     type: 'BUSINESS' },
  taxi:              { category: 'Taxi',                type: 'BUSINESS' },
  // Shop
  supermarket_shop:  { category: 'Supermercado',        type: 'BUSINESS' },
  bakery:            { category: 'Panadería',           type: 'BUSINESS' },
  butcher:           { category: 'Carnicería',          type: 'BUSINESS' },
  clothes:           { category: 'Ropa',                type: 'BUSINESS' },
  electronics:       { category: 'Electrónica',         type: 'BUSINESS' },
  hardware:          { category: 'Ferretería',          type: 'BUSINESS' },
  hairdresser:       { category: 'Peluquería',          type: 'BUSINESS' },
  beauty:            { category: 'Salón de Belleza',    type: 'BUSINESS' },
  // Tourism
  museum:            { category: 'Museo',               type: 'BUSINESS' },
  gallery:           { category: 'Galería',             type: 'BUSINESS' },
  attraction:        { category: 'Atracción',           type: 'BUSINESS' },
  artwork:           { category: 'Obra de Arte',        type: 'BUSINESS' },
  viewpoint:         { category: 'Mirador',             type: 'BUSINESS' },
  information:       { category: 'Información Turística', type: 'BUSINESS' },
  // Leisure
  park:              { category: 'Parque',              type: 'BUSINESS' },
  playground:        { category: 'Parque Infantil',     type: 'BUSINESS' },
  sports_centre:     { category: 'Centro Deportivo',    type: 'BUSINESS' },
  swimming_pool:     { category: 'Piscina',             type: 'BUSINESS' },
  beach_resort:      { category: 'Resort de Playa',     type: 'BUSINESS' },
  // Office
  ngo:               { category: 'ONG',                 type: 'NGO' },
  association:       { category: 'Asociación',          type: 'NGO' },
  diplomatic:        { category: 'Embajada',            type: 'GOVERNMENT' },
};

function getCategory(tags: OsmTags): { category: string; type: ListingType } {
  // Check each OSM primary tag in priority order
  for (const key of ['amenity', 'shop', 'tourism', 'leisure', 'healthcare', 'office'] as const) {
    const val = tags[key];
    if (!val) continue;
    const mapped = CATEGORY_MAP[val];
    if (mapped) return mapped;
    // Fallback: capitalize the raw value
    if (key === 'shop')     return { category: 'Tienda', type: 'BUSINESS' };
    if (key === 'tourism')  return { category: 'Turismo', type: 'BUSINESS' };
    if (key === 'leisure')  return { category: 'Ocio', type: 'BUSINESS' };
    if (key === 'healthcare') return { category: 'Salud', type: 'BUSINESS' };
    if (key === 'office')   return { category: 'Oficina', type: 'BUSINESS' };
  }
  return { category: 'Negocio', type: 'BUSINESS' };
}

function extractName(tags: OsmTags): string | null {
  return tags['name:es'] ?? tags.name ?? tags['name:en'] ?? tags.operator ?? tags.brand ?? null;
}

function extractPhone(tags: OsmTags): string | null {
  return tags.phone ?? tags['contact:phone'] ?? null;
}

function extractEmail(tags: OsmTags): string | null {
  return tags.email ?? tags['contact:email'] ?? null;
}

function extractWebsite(tags: OsmTags): string | null {
  return tags.website ?? tags['contact:website'] ?? null;
}

function extractWhatsapp(tags: OsmTags): string | null {
  return tags.whatsapp ?? tags['contact:whatsapp'] ?? null;
}

function extractAddress(tags: OsmTags): string | null {
  const parts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function extractDescription(tags: OsmTags): string | null {
  return tags['description:es'] ?? tags.description ?? null;
}

// ─── Overpass query builder ───────────────────────────────────────────────────

function buildOverpassQuery(types: string[]): string {
  // Cuba bounding box: south, west, north, east
  const bbox = '19.8,-85.0,23.3,-74.0';

  const nodeLines = types.map(t => `  node[${t}](${bbox});`).join('\n');
  const wayLines  = types.map(t => `  way[${t}](${bbox});`).join('\n');

  return `
[out:json][timeout:180][maxsize:536870912];
(
${nodeLines}
${wayLines}
);
out center tags ${LIMIT};
`.trim();
}

// ─── Fetch from Overpass (with retry) ────────────────────────────────────────

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function fetchOverpass(query: string): Promise<OsmElement[]> {
  let lastErr: Error | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`  → Querying ${endpoint.split('/')[2]}...`);
      const resp = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `data=${encodeURIComponent(query)}`,
        signal:  AbortSignal.timeout(200_000),  // 3.3 min
      });

      if (!resp.ok) {
        console.warn(`  ✗ ${resp.status} from ${endpoint}`);
        continue;
      }

      const json = await resp.json() as { elements: OsmElement[] };
      return json.elements ?? [];
    } catch (e: any) {
      lastErr = e;
      console.warn(`  ✗ ${endpoint}: ${e.message}`);
      // Small delay before trying next mirror
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw lastErr ?? new Error('All Overpass mirrors failed');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🗺️  Cuba Libre OSM Scraper');
  console.log(`   Province filter : ${FILTER_PROVINCE ?? 'all Cuba'}`);
  console.log(`   Type filter     : ${FILTER_TYPE ?? 'all'}`);
  console.log(`   Limit           : ${LIMIT}`);
  console.log(`   Dry run         : ${DRY_RUN}`);
  console.log('');

  // Build query for all main POI types
  const queryTypes = FILTER_TYPE
    ? [FILTER_TYPE]
    : ['amenity', 'shop', 'tourism', 'leisure', 'healthcare', 'office'];

  console.log('📡 Fetching from Overpass API...');
  const elements = await fetchOverpass(buildOverpassQuery(queryTypes));
  console.log(`   Raw elements : ${elements.length.toLocaleString()}`);

  // Filter by province if requested
  const filtered = FILTER_PROVINCE
    ? elements.filter(el => {
        const lat = el.type === 'node' ? el.lat : el.center.lat;
        const lon = el.type === 'node' ? el.lon : el.center.lon;
        return coordsToProvince(lat, lon) === FILTER_PROVINCE ||
               el.tags['addr:province'] === FILTER_PROVINCE;
      })
    : elements;

  // Skip elements without a usable name
  const named = filtered.filter(el => extractName(el.tags));
  console.log(`   After name filter: ${named.length.toLocaleString()}`);
  console.log('');

  if (DRY_RUN) {
    console.log('🔍 DRY RUN — first 10 elements:');
    named.slice(0, 10).forEach(el => {
      const lat = el.type === 'node' ? el.lat : el.center.lat;
      const lon = el.type === 'node' ? el.lon : el.center.lon;
      const province = el.tags['addr:province'] ?? coordsToProvince(lat, lon);
      const { category, type } = getCategory(el.tags);
      console.log(`  [${type}] ${extractName(el.tags)} — ${category} — ${province}`);
    });
    process.exit(0);
  }

  // Upsert in batches of 100
  const BATCH = 100;
  let created = 0, updated = 0, skipped = 0;
  const total = named.length;

  for (let i = 0; i < total; i += BATCH) {
    const batch = named.slice(i, i + BATCH);

    await Promise.all(batch.map(async el => {
      const lat = el.type === 'node' ? el.lat : el.center.lat;
      const lon = el.type === 'node' ? el.lon : el.center.lon;

      const tags    = el.tags;
      const osmid   = `osm:${el.type}:${el.id}`;
      const name    = extractName(tags);
      if (!name) { skipped++; return; }

      const province  = tags['addr:province'] ?? coordsToProvince(lat, lon);
      const { category, type } = getCategory(tags);

      // Validate province is one of ours
      const canonicalProvince = CUBA_PROVINCES.find(p =>
        p.toLowerCase() === province.toLowerCase()
      ) ?? 'La Habana';

      const data = {
        name,
        type,
        province:     canonicalProvince,
        category,
        latitude:     lat,
        longitude:    lon,
        phone:        extractPhone(tags),
        email:        extractEmail(tags),
        website:      extractWebsite(tags),
        whatsapp:     extractWhatsapp(tags),
        address:      extractAddress(tags),
        city:         tags['addr:city'] ?? null,
        description:  extractDescription(tags),
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
      } catch (e: any) {
        // Duplicate name/province combos or other constraints
        skipped++;
        if (process.env.VERBOSE) console.warn(`  skip ${osmid}: ${e.message}`);
      }
    }));

    // Progress report every 1000 records
    if ((i + BATCH) % 1000 === 0 || i + BATCH >= total) {
      const done = Math.min(i + BATCH, total);
      const pct  = Math.round((done / total) * 100);
      process.stdout.write(
        `\r   Progress: ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%) — ` +
        `created:${created} updated:${updated} skipped:${skipped}  `
      );
    }
  }

  console.log('\n');
  console.log('✅ OSM scrape complete');
  console.log(`   Created : ${created.toLocaleString()}`);
  console.log(`   Updated : ${updated.toLocaleString()}`);
  console.log(`   Skipped : ${skipped.toLocaleString()} (no name or constraint error)`);
  console.log(`   Total   : ${(created + updated).toLocaleString()} listings`);

  // Province breakdown
  if (created + updated > 0) {
    console.log('\n📊 Province breakdown:');
    const breakdown = await prisma.listing.groupBy({
      by:      ['province'],
      where:   { osmid: { startsWith: 'osm:' } },
      _count:  { id: true },
      orderBy: { _count: { id: 'desc' } },
    });
    breakdown.forEach(row =>
      console.log(`   ${row.province.padEnd(22)} ${row._count.id.toLocaleString()}`)
    );
  }

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
