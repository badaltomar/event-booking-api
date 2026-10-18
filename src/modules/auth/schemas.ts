import { z } from 'zod';
import { roleSchema } from '../../lib/schemas.js';

export const registerBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(8).max(128),
  role: roleSchema,
});

export const loginBody = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(128),
});

export const userResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  createdAt: z.string(),
});

export const authResponse = z.object({
  user: userResponse,
  token: z.string(),
});
