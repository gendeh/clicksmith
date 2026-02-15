import { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../config/firebase';
import { mockDb } from '../store/mockDb';
import { Profile } from '../types';

function getUserId(req: Request) {
  return (req.headers['x-user-id'] as string) || 'mock-user';
}

export const listProfiles = async (req: Request, res: Response) => {
  const ownerId = getUserId(req);
  if (db) {
    const snapshot = await db.collection('profiles').where('ownerId', '==', ownerId).get();
    const profiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(profiles);
    return;
  }

  res.json(mockDb.listProfiles(ownerId));
};

export const getProfile = async (req: Request, res: Response) => {
  const ownerId = getUserId(req);
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
  res.json(profile);
};

export const createProfile = async (req: Request, res: Response) => {
  const ownerId = getUserId(req);
  const profile: Profile = {
    ...req.body,
    id: req.body.id || crypto.randomUUID(),
    ownerId,
    created_at: req.body.created_at || new Date().toISOString(),
    version: req.body.version || 1,
  };

  if (db) {
    await db.collection('profiles').doc(profile.id).set(profile, { merge: true });
    res.status(201).json(profile);
    return;
  }

  res.status(201).json(mockDb.saveProfile(profile));
};

export const updateProfile = async (req: Request, res: Response) => {
  const ownerId = getUserId(req);
  const updates = { ...req.body, ownerId };
  if (db) {
    await db.collection('profiles').doc(req.params.id).set(updates, { merge: true });
    res.json({ id: req.params.id, ...updates });
    return;
  }

  const existing = mockDb.getProfile(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  const saved = mockDb.saveProfile({ ...existing, ...updates });
  res.json(saved);
};

export const deleteProfile = async (req: Request, res: Response) => {
  if (db) {
    await db.collection('profiles').doc(req.params.id).delete();
    res.status(204).send();
    return;
  }

  mockDb.deleteProfile(req.params.id);
  res.status(204).send();
};
