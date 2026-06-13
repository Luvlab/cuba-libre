/**
 * osm.ts — CLI entry point for the OSM scraper
 *
 * Usage:
 *   npm run scrape:osm
 *   npm run scrape:osm -- --province "La Habana"
 *   npm run scrape:osm -- --type tourism --limit 5000
 *   npm run scrape:osm -- --dry-run
 *
 * Core logic lives in osmScrape.ts (also used by the Vercel cron endpoint).
 */

import { runOsmScrape } from './osmScrape';

const args    = process.argv.slice(2);
const getArg  = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };

runOsmScrape({
  province: getArg('--province'),
  type:     getArg('--type'),
  limit:    parseInt(getArg('--limit') ?? '50000', 10),
  dryRun:   args.includes('--dry-run'),
}).then(r => {
  console.log(`\nTotal upserted: ${r.total.toLocaleString()}`);
  process.exit(0);
}).catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
