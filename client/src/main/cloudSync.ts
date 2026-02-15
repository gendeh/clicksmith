import { Profile } from '../types';

export async function syncProfileDeleteToCloud(profileId: string, token?: string) {
    const endpoint = process.env.CLICKSMITH_API_URL || 'http://localhost:3000';
    await fetch(`${endpoint}/api/v1/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE',
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
}

export async function syncProfileToCloud(profile: Profile, token?: string) {
    const endpoint = process.env.CLICKSMITH_API_URL || 'http://localhost:3000';
    await fetch(`${endpoint}/api/v1/profiles`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(profile),
    });
}
