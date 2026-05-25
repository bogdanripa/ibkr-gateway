// Firebase web app config (CLIENT-SIDE, PUBLIC).
//
// Per Firebase's own documentation, the apiKey here is NOT a secret —
// it's a client identifier. Access control is enforced by Firebase Auth
// rules, Firestore rules, and our backend's ID-token verification.
// See: https://firebase.google.com/docs/projects/api-keys
//
// This file is intentionally NOT excluded by .gitignore. Our secret scan
// (scripts/scan-secrets.sh) is configured to allow this specific path.

export const firebaseConfig = {
  apiKey: "AIzaSyDnc8EstQh9p4CjF1K94ch_vsditwm0HYg",
  authDomain: "auto-trader-493814.firebaseapp.com",
  projectId: "auto-trader-493814",
  storageBucket: "auto-trader-493814.firebasestorage.app",
  messagingSenderId: "1023470996532",
  appId: "1:1023470996532:web:19284035208b472baa8e61",
} as const;
