import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAnalytics, isSupported, logEvent, setAnalyticsCollectionEnabled } from 'firebase/analytics';
import { firebaseConfig } from './firebaseConfig';

const app = initializeApp(firebaseConfig);

// App Check: attests that requests genuinely come from this deployed site, not a
// script talking to Firestore directly. Safe to have running even before Firestore
// enforcement is turned on in the console - it doesn't block anything by itself.
//
// IMPORTANT: replace the placeholder below with the real reCAPTCHA Enterprise Key ID
// (the same one shown in Google Cloud Console under Fraud Defense - no separate
// secret key needed for Enterprise, unlike classic reCAPTCHA v3).
// Wrapped defensively: with the placeholder still in place, this should not throw,
// but the try/catch means it can't take the whole app down even if it did.
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6Lc8JG8tAAAAALUm2UXnfIWFEUZfpcVh03F2d6gp'),
    isTokenAutoRefreshEnabled: true,
  });
} catch (e) {
  console.error('App Check init failed:', e);
}

/* ---- Google Analytics ------------------------------------------------------
   Uses the measurementId already present in firebaseConfig. getAnalytics() loads
   gtag.js itself, so there is no script tag to paste into index.html.

   Everything here is best-effort and deliberately silent on failure. GA is blocked
   outright by Brave Shields, uBlock and Safari's strict protection - the same class
   of block that caused the directory incident when App Check was affected. A blocked
   GA must never be visible to someone trying to organise tennis, so every path
   degrades to a no-op rather than an error.

   isSupported() is checked rather than assumed: it returns false in environments
   without the APIs GA needs, and calling getAnalytics() there throws.

   Note this only ever SENDS. Reading these numbers back requires the GA Data API and
   a service-account credential, which cannot live in a public JS bundle - so GA data
   is read at analytics.google.com, while the in-app Superuser panel reads Firestore.  */
let analytics = null;

isSupported()
  .then((supported) => {
    if (!supported) return;
    analytics = getAnalytics(app);
    setAnalyticsCollectionEnabled(analytics, true);
  })
  .catch(() => {
    // Blocked, unsupported, or offline - stay silent and leave analytics null.
  });

// Exposed on window rather than imported by the app, for the same reason window.storage
// is: TennisPairingApp.jsx must keep running in the claude.ai preview, where this file
// and Firebase itself do not exist. There the call simply never happens.
if (typeof window !== 'undefined') {
  window.__CC_ANALYTICS__ = {
    log(name, params) {
      try {
        if (!analytics) return;
        logEvent(analytics, name, params || {});
      } catch {
        // Never surface an analytics failure to the user.
      }
    },
  };
}

const db = getFirestore(app);

// Everything lives in one collection, one document per storage key. This mirrors the
// get/set/delete/list interface the app already talks to (window.storage inside Claude),
// so the rest of the app's code did not need to change at all - only this file is new.
const COLLECTION = 'court-call-data';

export const firebaseStorage = {
  async get(key) {
    const ref = doc(db, COLLECTION, key);
    let snap;
    try {
      snap = await getDoc(ref);
    } catch (e) {
      // getDoc() itself failed - network down, App Check token blocked (e.g. by a
      // browser privacy shield), permission denied, etc. This is NOT "the document
      // doesn't exist" - tag it distinctly so the app never confuses "can't reach
      // Firestore right now" with "this is a genuine first-time setup."
      const wrapped = new Error(`storage unavailable: ${e && e.message ? e.message : e}`);
      wrapped.storageErrorType = 'unavailable';
      throw wrapped;
    }
    if (!snap.exists()) {
      const notFound = new Error('not found');
      notFound.storageErrorType = 'not-found';
      throw notFound;
    }
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
