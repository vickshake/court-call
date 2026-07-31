import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { firebaseConfig } from './firebaseConfig';

const app = initializeApp(firebaseConfig);
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
