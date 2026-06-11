import { qs, qsr, qsn } from '../utils/query';
/**
 * events.ts — Community events for Cuba Libre
 * Submit events for admin approval. Approved/Featured events earn 25 Libre.
 * Supports province/category/date filters and RSVP management.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { CUBA_PROVINCES } from '../config';
import { creditLibre } from './libre';

const router = Router();

const EARN_EVENT_APPROVAL = 25n;

// ─── Schema ───────────────────────────────────────────────────────────────────

const EventSchema = z.object({
  title:       z.string().min(3),
  description: z.string().optional(),
  startdate:   z.string().datetime(),
  enddate:     z.string().datetime().optional(),
  venue:       z.string().optional(),
  city:        z.string().optional(),
  province:    z.enum(CUBA_PROVINCES as [string, ...string[]]).optional(),
  latitude:    z.number().optional(),
  longitude:   z.number().optional(),
  category:    z.string().optional(),
  imageurl:    z.string().url().optional(),
  ticketurl:   z.string().url().optional(),
  price:       z.number().optional(),
  currency:    z.string().default('LIBRE'),
  isfree:      z.boolean().default(true),
  listingid:   z.string().uuid().optional(),
});

// ─── GET /events ──────────────────────────────────────────────────────────────

router.get('/', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { province, category, from, to, page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = { status: { in: ['APPROVED', 'FEATURED'] } };
    if (province) where.province = province;
    if (category) where.category = category;
    if (from || to) {
      where.startdate = {};
      if (from) where.startdate.gte = new Date(from);
      if (to)   where.startdate.lte = new Date(to);
    }

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: [{ status: 'asc' }, { startdate: 'asc' }],
        include: { _count: { select: { attendees: true } } },
      }),
      prisma.event.count({ where }),
    ]);

    res.json({ events, total, page: parseInt(page) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /events ─────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = EventSchema.parse(req.body);
    const event = await prisma.event.create({
      data: {
        ...body,
        startdate:      new Date(body.startdate),
        enddate:        body.enddate ? new Date(body.enddate) : undefined,
        submittedbyid:  req.user!.id,
        status:         'PENDING',
      },
    });
    res.status(201).json(event);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /events/:id ──────────────────────────────────────────────────────────

router.get('/:id', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const event = await prisma.event.findUnique({
      where:   { id: qsr(req.params.id) },
      include: { _count: { select: { attendees: true } } },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    prisma.event.update({ where: { id: qsr(req.params.id) }, data: { views: { increment: 1 } } }).catch(() => {});

    res.json(event);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /events/:id/attend ──────────────────────────────────────────────────

router.post('/:id/attend', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.eventAttendee.upsert({
      where:  { eventid_userid: { eventid: qsr(req.params.id), userid: req.user!.id } },
      update: {},
      create: { eventid: qsr(req.params.id), userid: req.user!.id },
    });
    res.json({ attending: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /events/:id/attend ────────────────────────────────────────────────

router.delete('/:id/attend', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.eventAttendee.deleteMany({
      where: { eventid: qsr(req.params.id), userid: req.user!.id },
    });
    res.json({ attending: false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /events/:id/status ─────────────────────────────────────────────────

const StatusSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'FEATURED', 'CANCELLED']),
});

router.patch('/:id/status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });

    const { status } = StatusSchema.parse(req.body);
    const event = await prisma.event.findUnique({ where: { id: qsr(req.params.id) } });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const updated = await prisma.event.update({
      where: { id: qsr(req.params.id) },
      data:  { status: status as any, featuredbyid: status === 'FEATURED' ? req.user!.id : undefined },
    });

    // Credit submitter on approval
    if ((status === 'APPROVED' || status === 'FEATURED') && event.submittedbyid && event.status === 'PENDING') {
      await creditLibre(event.submittedbyid, EARN_EVENT_APPROVAL, 'EARN_LISTING', `Event approved: ${event.title}`, event.id);
    }

    res.json(updated);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
