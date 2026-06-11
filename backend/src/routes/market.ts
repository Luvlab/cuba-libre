import { qs, qsr, qsn } from '../utils/query';
/**
 * market.ts — Product marketplace for Cuba Libre
 * All prices stored in Libre (BigInt). Supports province + category filtering.
 * Only listing owners can create/update products for their listings.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const ProductSchema = z.object({
  listingid:   z.string().uuid().optional(),
  name:        z.string().min(2),
  description: z.string().optional(),
  imageurl:    z.string().url().optional(),
  price:       z.number().int().nonnegative(),
  currency:    z.string().default('LIBRE'),
  instock:     z.boolean().default(true),
  contacturl:  z.string().optional(),
});

// ─── GET /market ──────────────────────────────────────────────────────────────

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, category, search, page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = { active: true };

    if (province || category || search) {
      const listingWhere: any = { active: true };
      if (province) listingWhere.province = province;
      if (category) listingWhere.category = category;
      if (search)   listingWhere.name     = { contains: search, mode: 'insensitive' };

      const listings = await prisma.listing.findMany({
        where:  listingWhere,
        select: { id: true },
      });
      where.listingid = { in: listings.map(l => l.id) };
    }

    if (search && !province && !category) {
      where.OR = [
        { name:        { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [products, total] = await Promise.all([
      prisma.marketProduct.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
        include: { listing: { select: { id: true, name: true, province: true, category: true, logourl: true } } },
      }),
      prisma.marketProduct.count({ where }),
    ]);

    res.json({
      products: products.map(p => ({ ...p, price: p.price.toString() })),
      total,
      page: parseInt(page),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /market ─────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = ProductSchema.parse(req.body);

    // Verify listing ownership if listingid provided
    if (body.listingid) {
      const listing = await prisma.listing.findUnique({ where: { id: body.listingid } });
      if (!listing) return res.status(404).json({ error: 'Listing not found' });
      if (listing.submittedbyid !== req.user!.id && req.user!.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Not your listing' });
      }
    }

    const product = await prisma.marketProduct.create({
      data: { ...body, price: BigInt(body.price) },
    });

    res.status(201).json({ ...product, price: product.price.toString() });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /market/:id ──────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const product = await prisma.marketProduct.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { listing: { select: { id: true, name: true, province: true, category: true, phone: true, email: true } } },
    });

    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ ...product, price: product.price.toString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /market/:id ──────────────────────────────────────────────────────────

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const product = await prisma.marketProduct.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { listing: true },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const isOwner = product.listing?.submittedbyid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const body = ProductSchema.partial().parse(req.body);
    const updated = await prisma.marketProduct.update({
      where: { id: qsr(req.params.id) },
      data:  { ...body, price: body.price !== undefined ? BigInt(body.price) : undefined },
    });

    res.json({ ...updated, price: updated.price.toString() });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /market/:id ───────────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const product = await prisma.marketProduct.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { listing: true },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const isOwner = product.listing?.submittedbyid === req.user!.id;
    const isAdmin = req.user!.role === 'ADMIN';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    await prisma.marketProduct.update({ where: { id: qsr(req.params.id) }, data: { active: false } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /market/:id/contact ─────────────────────────────────────────────────

router.post('/:id/contact', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    // Log a click event for analytics
    await prisma.userEvent.create({
      data: {
        userid:    req.user?.id,
        eventtype: 'market_contact_click',
        target:    qsr(req.params.id),
        province:  (qs(req.query.province)) ?? undefined,
      },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
