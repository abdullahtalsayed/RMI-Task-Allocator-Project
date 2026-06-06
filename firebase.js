// ── FIREBASE SDK + CONFIG ─────────────────────────────────────────────────────
// Re-export Firebase modular SDK (CDN) so the rest of the app imports from here.
export { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
export { getFirestore, collection, doc, setDoc, addDoc, updateDoc, deleteDoc, deleteField, onSnapshot, getDocs, getDoc, query, where, limit, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
export { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
export { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

export const CFG = {
  apiKey:            "AIzaSyCsAsi2R-bNvG1F8bLN2xvKgw1S1BcV9-Q",
  authDomain:        "rmi-job-allocation.firebaseapp.com",
  projectId:         "rmi-job-allocation",
  storageBucket:     "rmi-job-allocation.firebasestorage.app",
  messagingSenderId: "420212187802",
  appId:             "1:420212187802:web:d1bc5b9478eb808d347523"
};
export const MGR_PW = "manager123";
export const USE_FIREBASE = CFG.apiKey !== "PASTE_apiKey_HERE";
export const USE_AUTH = USE_FIREBASE;
