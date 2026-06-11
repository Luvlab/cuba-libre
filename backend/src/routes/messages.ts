import { qs, qsr, qsn } from '../utils/query';
/**
 * messages.ts — Channel-based direct messaging for Cuba Libre
 * Messages are grouped by channelId. Supports pagination (newest first).
 * Users can only delete their own messages.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Schema ───────────────────────────────────────────────────────────────────

const SendMessageSchema = z.object({
  channelid:    z.string(),
  channeltype:  z.string().default('dm'),
  content:      z.string().min(1),
  messagetype:  z.string().default('text'),
  metadata:     z.any().optional(),
});

// ─── POST /messages ───────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = SendMessageSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where:  { id: req.user!.id },
      select: { name: true, role: true },
    });

    const message = await prisma.directMessage.create({
      data: {
        channelid:   body.channelid,
        channeltype: body.channeltype,
        senderid:    req.user!.id,
        sendername:  user?.name,
        senderrole:  user?.role,
        content:     body.content,
        messagetype: body.messagetype,
        metadata:    body.metadata,
        readby:      [req.user!.id],
      },
    });

    res.status(201).json(message);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /messages/:channelId ─────────────────────────────────────────────────

router.get('/:channelId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '50' } = req.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [messages, total] = await Promise.all([
      prisma.directMessage.findMany({
        where:   { channelid: qsr(req.params.channelId) },
        skip,
        take:    parseInt(limit),
        orderBy: { createdat: 'desc' },
      }),
      prisma.directMessage.count({ where: { channelid: qsr(req.params.channelId) } }),
    ]);

    // Mark as read
    await prisma.directMessage.updateMany({
      where: {
        channelid: qsr(req.params.channelId),
      },
      data: { readby: { push: req.user!.id } },
    });

    res.json({ messages, total, page: parseInt(page) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /messages/:id ─────────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const message = await prisma.directMessage.findUnique({ where: { id: qsr(req.params.id) } });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.senderid !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Cannot delete someone else\'s message' });
    }

    await prisma.directMessage.delete({ where: { id: qsr(req.params.id) } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
