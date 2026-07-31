import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { firebaseConfig } from './firebaseConfig';

const app = initializeApp(firebaseConfig);

// App Check: attests that requests genuinely come from this deployed site, not a
// script talking to Firestore directly. Safe to have running even before Firestore
// enforcement is turned on in the console - it doesn't block anything by itself.
//
// IMPORTANT: replace the placeholder below with the real reCAPTCHA v3 SITE key
// (not the secret key - the secret key goes into the Firebase console instead,
// never into this file). Get it from Firebase Console > Security > App Check.
// Wrapped defensively: with the placeholder still in place, this should not throw,
// but the try/catch means it can't take the whole app down even if it did.
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider('REPLACE_WITH_YOUR_RECAPTCHA_V3_SITE_KEY'),
    isTokenAutoRefreshEnabled: true,
  });
} catch (e) {
  console.error('App Check init failed (safe to ignore until a real site key is set):', e);
}

const db = getFirestore(app);

// Everything lives in one collection, one document per storage key. This mirrors the
// get/set/delete/list interface the app already talks to (window.storage inside Claude),
// so the rest of the app's code did not need to change at all - only this file is new.
const COLLECTION = 'court-call-data';

export const firebaseStorage = {
  async get(key) {
    const ref = doc(db, COLLECTION, key);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('not found');
    return { key, value: snap.data().value, shared: true };
  },

  async set(key, value) {
    const ref = doc(db, COLLECTION, key);
    await setDoc(ref, { value, updatedAt: Date.now() });
    return { key, value, shared: true };
  },

  async delete(key) {
    const ref = doc(db, COLLECTION, key);
    await deleteDoc(ref);
    return { key, deleted: true, shared: true };
  },

  async list(prefix) {
    const snap = await getDocs(collection(db, COLLECTION));
    const keys = snap.docs.map((d) => d.id).filter((k) => !prefix || k.startsWith(prefix));
    return { keys, shared: true };
  },
};
