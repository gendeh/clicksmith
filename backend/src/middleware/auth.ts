import { NextFunction, Request, Response } from 'express';
import { auth } from '../config/firebase';

export type AuthenticatedRequest = Request & {
  authUser?: {
    uid: string;
  };
};

function extractBearerToken(header?: string): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export async function authenticateRequest(req: Request, res: Response, next: NextFunction) {
  const authenticatedReq = req as AuthenticatedRequest;
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: missing bearer token' });
    return;
  }

  if (auth) {
    try {
      const decoded = await auth.verifyIdToken(token);
      authenticatedReq.authUser = { uid: decoded.uid };
      next();
      return;
    } catch {
      res.status(401).json({ error: 'Unauthorized: invalid token' });
      return;
    }
  }

  const allowInsecureDevAuth = process.env.ALLOW_INSECURE_DEV_AUTH === 'true';
  if (!allowInsecureDevAuth) {
    res.status(503).json({
      error: 'Auth provider unavailable. Set Firebase credentials or ALLOW_INSECURE_DEV_AUTH=true for local dev.',
    });
    return;
  }

  if (!token.startsWith('dev:')) {
    res.status(401).json({ error: 'Unauthorized: invalid dev token format' });
    return;
  }

  const uid = token.slice('dev:'.length).trim();
  if (!uid) {
    res.status(401).json({ error: 'Unauthorized: invalid dev token format' });
    return;
  }

  authenticatedReq.authUser = { uid };
  next();
}

export function requireAuthenticatedUid(req: Request): string {
  const authenticatedReq = req as AuthenticatedRequest;
  if (!authenticatedReq.authUser?.uid) {
    throw new Error('AUTH_UID_MISSING');
  }
  return authenticatedReq.authUser.uid;
}
