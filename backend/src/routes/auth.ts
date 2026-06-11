import { qs, qsr, qsn } from '../utils/query';
/**
 * auth.ts — Authentication routes for Cuba Libre
 * Handles registration (with LibreWallet creation + 100 Libre signup bonus),
 * email/phone login, Google OAuth, password change, and /me endpoint.
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { config, CUBA_PROVINCES } from '../config';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  name:     z.string().min(2),
  email:    z.string().email().optional(),
  phone:    z.string().optional(),
  password: z.string().min(6),
  province: z.enum(CUBA_PROVINCES as [string, ...string[]]).optional(),
  language: z.string().default('es'),
}).refine(d => d.email || d.phone, { message: 'Email or phone required' });

const LoginSchema = z.object({
  email:    z.string().email().optional(),
  phone:    z.string().optional(),
  password: z.string(),
}).refine(d => d.email || d.phone, { message: 'Email or phone required' });

const ChangePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword:     z.string().min(6),
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function signToken(id: string, role: string) {
  return jwt.sign({ id, role }, config.jwtSecret, { expiresIn: '30d' });
}

async function safeUser(userId: string) {
  const user   = await prisma.user.findUnique({ where: { id: userId } });
  const wallet = await prisma.libreWallet.findUnique({ where: { userid: userId } });
  if (!user) return null;
  return {
    id:           user.id,
    name:         user.name,
    email:        user.email,
    phone:        user.phone,
    role:         user.role,
    language:     user.language,
    province:     user.province,
    avatarurl:    user.avatarurl,
    libreBalance: wallet?.balance ?? BigInt(0),
    createdat:    user.createdat,
  };
}

// ─── Register ─────────────────────────────────────────────────────────────────

router.post('/register', async (req: Request, res: Response) => {
  try {
    const body = RegisterSchema.parse(req.body);

    // Check uniqueness
    if (body.email) {
      const exists = await prisma.user.findUnique({ where: { email: body.email } });
      if (exists) return res.status(409).json({ error: 'Email already in use' });
    }
    if (body.phone) {
      const exists = await prisma.user.findUnique({ where: { phone: body.phone } });
      if (exists) return res.status(409).json({ error: 'Phone already in use' });
    }

    const passwordhash = await bcrypt.hash(body.password, 12);

    // Transaction: create user + wallet + signup bonus tx
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          name:         body.name,
          email:        body.email,
          phone:        body.phone,
          passwordhash,
          province:     body.province,
          language:     body.language,
        },
      });

      const wallet = await tx.libreWallet.create({
        data: {
          userid:        newUser.id,
          balance:       BigInt(100),
          lifetimeearned: BigInt(100),
        },
      });

      await tx.libreTransaction.create({
        data: {
          walletid:     wallet.id,
          amount:       BigInt(100),
          type:         'EARN_SIGNUP',
          description:  'Welcome bonus — ¡Bienvenido a Cuba Libre!',
          balanceafter: BigInt(100),
        },
      });

      return newUser;
    });

    const token  = signToken(user.id, user.role);
    const profile = await safeUser(user.id);
    res.status(201).json({ token, user: profile });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
  try {
    const body = LoginSchema.parse(req.body);

    let user = body.email
      ? await prisma.user.findUnique({ where: { email: body.email } })
      : await prisma.user.findUnique({ where: { phone: body.phone } });

    if (!user || !user.passwordhash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(body.password, user.passwordhash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token   = signToken(user.id, user.role);
    const profile = await safeUser(user.id);
    res.json({ token, user: profile });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────

const GoogleSchema = z.object({
  googleId:  z.string(),
  email:     z.string().email().optional(),
  name:      z.string(),
  avatarUrl: z.string().url().optional(),
});

router.post('/google', async (req: Request, res: Response) => {
  try {
    const body = GoogleSchema.parse(req.body);

    let user = await prisma.user.findUnique({ where: { googleid: body.googleId } });

    if (!user && body.email) {
      user = await prisma.user.findUnique({ where: { email: body.email } }) ?? null;
    }

    if (!user) {
      user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            googleid:  body.googleId,
            email:     body.email,
            name:      body.name,
            avatarurl: body.avatarUrl,
            language:  'es',
          },
        });

        const wallet = await tx.libreWallet.create({
          data: {
            userid:        newUser.id,
            balance:       BigInt(100),
            lifetimeearned: BigInt(100),
          },
        });

        await tx.libreTransaction.create({
          data: {
            walletid:     wallet.id,
            amount:       BigInt(100),
            type:         'EARN_SIGNUP',
            description:  'Welcome bonus — ¡Bienvenido a Cuba Libre!',
            balanceafter: BigInt(100),
          },
        });

        return newUser;
      });
    } else if (!user.googleid) {
      user = await prisma.user.update({
        where: { id: user.id },
        data:  { googleid: body.googleId, avatarurl: body.avatarUrl ?? user.avatarurl },
      });
    }

    const token   = signToken(user.id, user.role);
    const profile = await safeUser(user.id);
    res.json({ token, user: profile });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Me ───────────────────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await safeUser(req.user!.id);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Profile ───────────────────────────────────────────────────────────

const UpdateProfileSchema = z.object({
  name:      z.string().min(2).optional(),
  province:  z.enum(CUBA_PROVINCES as [string, ...string[]]).optional(),
  language:  z.string().optional(),
  avatarurl: z.string().url().optional(),
});

router.patch('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = UpdateProfileSchema.parse(req.body);
    await prisma.user.update({ where: { id: req.user!.id }, data: body });
    const profile = await safeUser(req.user!.id);
    res.json(profile);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Change Password ──────────────────────────────────────────────────────────

router.post('/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = ChangePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user?.passwordhash) return res.status(400).json({ error: 'No password set for this account' });

    const valid = await bcrypt.compare(body.currentPassword, user.passwordhash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const passwordhash = await bcrypt.hash(body.newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordhash } });
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0].message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
