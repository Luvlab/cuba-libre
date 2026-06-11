import { qs, qsr, qsn } from '../utils/query';
/**
 * follows.ts — Follow system for Cuba Libre
 * Users can follow other users or listings. Public follower counts.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const FollowSchema = z.object({
  followinguserid:    z.string().uuid().optional(),
  followinglistingid: z.string().uuid().optional(),
}).refine(d => d.followinguserid || d.followinglistingid, {
  message: 'Must provide followinguserid or followinglistingid',
});

// ─── POST /follows ────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = FollowSchema.parse(req.body);

    // Prevent self-follow
    if (body.followinguserid === req.user!.id) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    const follow = await prisma.follow.upsert({
      where: {
        followerid_followinguserid: body.followinguserid
          ? { followerid: req.user!.id, followinguserid: body.followinguserid }
          : undefined as any,
      },
      update: {},
      create: {
        followerid:         req.user!.id,
        followinguserid:    body.followinguserid,
        followinglistingid: body.followinglistingid,
      },
    });

    res.status(201).json(follow);
  } catch (err: any) {
    // Handle unique constraint violations gracefully
    if (err.code === 'P2002') return res.status(409).json({ error: 'Already following' });
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /follows/:targetId ────────────────────────────────────────────────

router.delete('/:targetId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.follow.deleteMany({
      where: {
        followerid: req.user!.id,
        OR: [
          { followinguserid:    qsr(req.params.targetId) },
          { followinglistingid: qsr(req.params.targetId) },
        ],
      },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /follows/my ─────────────────────────────────────────────────────────

router.get('/my', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const follows = await prisma.follow.findMany({
      where:   { followerid: req.user!.id },
      orderBy: { createdat: 'desc' },
    });
    res.json(follows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /follows/:userId/followers ───────────────────────────────────────────

router.get('/:userId/followers', async (req, res) => {
  try {
    const count = await prisma.follow.count({
      where: { followinguserid: qsr(req.params.userId) },
    });
    res.json({ userId: qsr(req.params.userId), followers: count });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
