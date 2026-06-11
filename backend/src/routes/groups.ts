import { qs, qsr, qsn } from '../utils/query';
/**
 * groups.ts — Chat groups for Cuba Libre
 * Province-scoped community groups with join/leave mechanics.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── GET / — list groups ──────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const { province } = req.query as Record<string, string>;

    const where: any = {};
    if (province) where.province = province;

    const groups = await prisma.chatGroup.findMany({ where, orderBy: { createdat: 'desc' } });
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST / — create group ────────────────────────────────────────────────────

const CreateGroupSchema = z.object({
  name:     z.string().min(2),
  province: z.string().optional(),
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = CreateGroupSchema.parse(req.body);

    const group = await prisma.chatGroup.create({
      data: {
        name:      body.name,
        province:  body.province,
        creatorid: req.user!.id,
        memberids: [req.user!.id],
      },
    });

    res.status(201).json(group);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /:id — get single group ──────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const group = await prisma.chatGroup.findUnique({ where: { id: qsr(req.params.id) } });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(group);
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /:id/join — join group ──────────────────────────────────────────────

router.post('/:id/join', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const group = await prisma.chatGroup.findUnique({ where: { id: qsr(req.params.id) } });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const memberids = group.memberids as string[];
    if (memberids.includes(req.user!.id)) {
      return res.json({ joined: true, message: 'Already a member' });
    }

    await prisma.$executeRaw`
      UPDATE "ChatGroup"
      SET memberids = array_append(memberids, ${req.user!.id}::text)
      WHERE id = ${qsr(req.params.id)}::uuid
    `;

    res.json({ joined: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /:id/leave — leave group ───────────────────────────────────────────

router.post('/:id/leave', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const group = await prisma.chatGroup.findUnique({ where: { id: qsr(req.params.id) } });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    if ((group as any).creatorid === req.user!.id) {
      return res.status(400).json({ error: 'Creator cannot leave their own group. Delete it instead.' });
    }

    await prisma.$executeRaw`
      UPDATE "ChatGroup"
      SET memberids = array_remove(memberids, ${req.user!.id}::text)
      WHERE id = ${qsr(req.params.id)}::uuid
    `;

    res.json({ left: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DELETE /:id — delete group ───────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const group = await prisma.chatGroup.findUnique({ where: { id: qsr(req.params.id) } });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    if ((group as any).creatorid !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only the creator can delete this group' });
    }

    await prisma.chatGroup.delete({ where: { id: qsr(req.params.id) } });
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
