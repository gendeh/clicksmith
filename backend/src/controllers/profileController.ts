import { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../config/firebase';
import { requireAuthenticatedUid } from '../middleware/auth';
import { mockDb } from '../store/mockDb';
import { Profile } from '../types';

export const listProfiles = async (req: Request, res: Response) => {
  const ownerId = requireAuthenticatedUid(req);
  if (db) {
    const snapshot = await db.collection('profiles').where('ownerId', '==', ownerId).get();
    const profiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(profiles);
    return;
  }

  res.json(mockDb.listProfiles(ownerId));
};

export const getProfile = async (req: Request, res: Response) => {
  const ownerId = requireAuthenticatedUid(req);
  if (db) {
    const doc = await db.collection('profiles').doc(req.params.id).get();
    if (!doc.exists) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    const data = { ...(doc.data() as Profile), id: doc.id };
    if (data.ownerId && data.ownerId !== ownerId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.json(data);
    return;
  }

  const profile = mockDb.getProfile(req.params.id);
  if (!profile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  if (profile.ownerId && profile.ownerId !== ownerId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  res.json(profile);
};

export const createProfile = async (req: Request, res: Response) => {
  const ownerId = requireAuthenticatedUid(req);
  const body = req.body as Omit<Profile, 'ownerId'>;
  const profile: Profile = {
    ...body,
    id: body.id || crypto.randomUUID(),
    ownerId,
    created_at: body.created_at || new Date().toISOString(),
    version: body.version || 1,
  };

  if (db) {
    await db.collection('profiles').doc(profile.id).set(profile, { merge: true });
    res.status(201).json(profile);
    return;
  }

  res.status(201).json(mockDb.saveProfile(profile));
};

export const updateProfile = async (req: Request, res: Response) => {
  const ownerId = requireAuthenticatedUid(req);
  const updates = req.body as Partial<Profile>;

  if (db) {
    const ref = db.collection('profiles').doc(req.params.id);
    const current = await ref.get();
    if (!current.exists) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    const currentData = current.data() as Profile;
    if (currentData.ownerId && currentData.ownerId !== ownerId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const payload: Partial<Profile> = {
      ...updates,
      ownerId,
    };
    delete (payload as { id?: string }).id;
    await ref.set(payload, { merge: true });
    res.json({ ...currentData, ...payload, id: req.params.id });
    return;
  }

  const existing = mockDb.getProfile(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  if (existing.ownerId && existing.ownerId !== ownerId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const payload: Partial<Profile> = { ...updates, ownerId };
  delete (payload as { id?: string }).id;
  const saved = mockDb.saveProfile({ ...existing, ...payload });
  res.json(saved);
};

export const deleteProfile = async (req: Request, res: Response) => {
  const ownerId = requireAuthenticatedUid(req);

  if (db) {
    const ref = db.collection('profiles').doc(req.params.id);
    const current = await ref.get();
    if (!current.exists) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    const currentData = current.data() as Profile;
    if (currentData.ownerId && currentData.ownerId !== ownerId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    await ref.delete();
    res.status(204).send();
    return;
  }

  const profile = mockDb.getProfile(req.params.id);
  if (!profile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  if (profile.ownerId && profile.ownerId !== ownerId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  mockDb.deleteProfile(req.params.id);
  res.status(204).send();
};
