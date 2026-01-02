import { Profile, SubscriptionRecord, UserRecord } from '../types';

const profiles = new Map<string, Profile>();
const users = new Map<string, UserRecord>();
const subscriptions = new Map<string, SubscriptionRecord>();

export const mockDb = {
  listProfiles: (ownerId?: string) =>
    Array.from(profiles.values()).filter(profile => (ownerId ? profile.ownerId === ownerId : true)),
  getProfile: (id: string) => profiles.get(id),
  saveProfile: (profile: Profile) => {
    profiles.set(profile.id, profile);
    return profile;
  },
  deleteProfile: (id: string) => {
    profiles.delete(id);
  },
  createUser: (user: UserRecord) => {
    users.set(user.uid, user);
    return user;
  },
  getUser: (uid: string) => users.get(uid),
  setSubscription: (subscription: SubscriptionRecord) => {
    subscriptions.set(subscription.uid, subscription);
    return subscription;
  },
  getSubscription: (uid: string) => subscriptions.get(uid),
};
