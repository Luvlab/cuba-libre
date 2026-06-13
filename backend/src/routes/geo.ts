/**
 * geo.ts — Cuba geocoding routes for Cuba Libre
 * Returns all 15 provinces with coordinates, Nominatim search restricted
 * to Cuba, and reverse geocoding (lat/lng → province + city).
 */

import { Router, Request, Response } from 'express';
import prisma from '../db';

const router = Router();

// ─── Cuba provinces with coordinates ─────────────────────────────────────────

const PROVINCES = [
  { name: 'Pinar del Río',    lat: 22.4159,  lng: -83.6767, capital: 'Pinar del Río'    },
  { name: 'Artemisa',         lat: 22.8129,  lng: -82.7632, capital: 'Artemisa'          },
  { name: 'La Habana',        lat: 23.1136,  lng: -82.3666, capital: 'La Habana'         },
  { name: 'Mayabeque',        lat: 22.8892,  lng: -81.9629, capital: 'San José de las Lajas' },
  { name: 'Matanzas',         lat: 23.0411,  lng: -81.5779, capital: 'Matanzas'          },
  { name: 'Cienfuegos',       lat: 22.1496,  lng: -80.4469, capital: 'Cienfuegos'        },
  { name: 'Villa Clara',      lat: 22.4069,  lng: -79.9673, capital: 'Santa Clara'       },
  { name: 'Sancti Spíritus',  lat: 21.9295,  lng: -79.4443, capital: 'Sancti Spíritus'  },
  { name: 'Ciego de Ávila',   lat: 21.8495,  lng: -78.7659, capital: 'Ciego de Ávila'   },
  { name: 'Camagüey',         lat: 21.3800,  lng: -77.9167, capital: 'Camagüey'          },
  { name: 'Las Tunas',        lat: 20.9606,  lng: -76.9533, capital: 'Las Tunas'         },
  { name: 'Holguín',          lat: 20.8849,  lng: -76.2613, capital: 'Holguín'           },
  { name: 'Granma',           lat: 20.3862,  lng: -76.6511, capital: 'Bayamo'            },
  { name: 'Santiago de Cuba', lat: 20.0247,  lng: -75.8219, capital: 'Santiago de Cuba'  },
  { name: 'Guantánamo',       lat: 20.1453,  lng: -74.8913, capital: 'Guantánamo'        },
  { name: 'Isla de la Juventud', lat: 21.7283, lng: -82.8325, capital: 'Nueva Gerona'   },
];

// ─── GET /geo/provinces ───────────────────────────────────────────────────────

router.get('/provinces', (_req: Request, res: Response) => {
  res.json(PROVINCES);
});

// ─── GET /geo/search — Nominatim search restricted to Cuba ───────────────────

router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q, limit = '10' } = req.query as Record<string, string>;
    if (!q) return res.status(400).json({ error: 'q required' });

    const params = new URLSearchParams({
      q,
      countrycodes: 'cu',
      format:       'json',
      addressdetails: '1',
      limit,
    });

    const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'CubaLibre/1.0 (https://cuba.libre)' },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Nominatim unavailable' });
    const results = await resp.json() as any[];

    const mapped = results.map(r => ({
      displayName: r.display_name,
      lat:         parseFloat(r.lat),
      lng:         parseFloat(r.lon),
      type:        r.type,
      province:    r.address?.state ?? null,
      city:        r.address?.city ?? r.address?.town ?? r.address?.village ?? null,
    }));

    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /geo/reverse — Reverse geocode lat/lng → province + city ────────────

router.get('/reverse', async (req: Request, res: Response) => {
  try {
    const { lat, lng } = req.query as Record<string, string>;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    const params = new URLSearchParams({
      lat,
      lon:            lng,
      format:         'json',
      addressdetails: '1',
    });

    const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      headers: { 'User-Agent': 'CubaLibre/1.0 (https://cuba.libre)' },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Nominatim unavailable' });
    const result = await resp.json() as any;

    // Match to a known province
    const stateName = result.address?.state ?? '';
    const matched   = PROVINCES.find(p =>
      p.name.toLowerCase() === stateName.toLowerCase() ||
      stateName.toLowerCase().includes(p.name.toLowerCase().split(' ')[0].toLowerCase())
    );

    res.json({
      displayName: result.display_name,
      lat:         parseFloat(lat),
      lng:         parseFloat(lng),
      province:    matched?.name ?? stateName ?? null,
      city:        result.address?.city ?? result.address?.town ?? result.address?.village ?? null,
      country:     result.address?.country ?? 'Cuba',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /geo/province-stats — public listing counts per province ─────────────

router.get('/province-stats', async (_req: Request, res: Response) => {
  try {
    const counts = await prisma.listing.groupBy({
      by:      ['province'],
      where:   { active: true },
      _count:  { id: true },
      orderBy: { _count: { id: 'desc' } },
    });
    res.json(counts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
