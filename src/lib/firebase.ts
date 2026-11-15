import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();
export const firestoreDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);

let connectionChecked = false;
export async function verifyFirestoreConnection(): Promise<void> {
  if (connectionChecked) return;
  connectionChecked = true;
  try {
    await getDocFromServer(doc(firestoreDb, 'team_snapshots', '__healthcheck__'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firestore offline or unreachable.');
    }
  }
}
