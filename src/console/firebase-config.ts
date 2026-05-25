// Firebase web app config. Values are read from environment variables —
// they are NOT committed to source control. Per Firebase's docs the
// `apiKey` is a public client identifier, but committing it anyway
// triggers automated secret scanners and locks the repo to a single
// Firebase project; both are avoidable.
//
// Local dev: copy .env.example to .env and fill in the values from
// Firebase Console → Project Settings → Your apps → Web app.
//
// VM: /etc/ibkr-gateway.env (managed by deploy/deploy-on-vm.sh).

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing Firebase env var: ${name}. ` +
      `See .env.example and Firebase Console → Project Settings.`
    );
  }
  return v;
}

export const firebaseConfig = {
  apiKey: need("FIREBASE_API_KEY"),
  authDomain: need("FIREBASE_AUTH_DOMAIN"),
  projectId: need("FIREBASE_PROJECT_ID"),
  storageBucket: need("FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: need("FIREBASE_MESSAGING_SENDER_ID"),
  appId: need("FIREBASE_APP_ID"),
} as const;
