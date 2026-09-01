import {
  initializeApp
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js';

import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCbduefUkhNgDIzLxsCG4MVR6hXGt4WwLo',
  authDomain: 'iedc-icebreak.firebaseapp.com',
  projectId: 'iedc-icebreak',
  storageBucket: 'iedc-icebreak.firebasestorage.app',
  messagingSenderId: '832684326235',
  appId: '1:832684326235:web:c9e49e05b718ecb8a8ee7e',
  measurementId: 'G-QCER748Y3F'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Keep each login isolated to its browser tab.
// This allows two different accounts to be signed in
// at the same time in two tabs of the same browser.
const authReady = setPersistence(
  auth,
  browserSessionPersistence
);

export {
  app,
  auth,
  db,
  authReady,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
  onAuthStateChanged,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch
};
