import { initializeApp, cert, App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';

// In a real implementation, we would load service account credentials from environment variables
// For MVP/local dev, we might use a mock or a placeholder if credentials aren't present

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
  : null;

let app: App | undefined;
let db: FirebaseFirestore.Firestore | undefined;
let auth: Auth | undefined;

if (serviceAccount) {
  app = initializeApp({
    credential: cert(serviceAccount)
  });
  db = getFirestore();
  auth = getAuth();
} else {
  console.warn('Firebase service account not provided. Backend will run in offline/mock mode.');
  // We can implement a mock DB here if needed for testing without Firebase credentials
  // For now, we'll just leave it null and handle it in controllers
}

export { db, auth };
