# Firebase Auth migration (v1.2) — data kept

## What stays the same

- Every document in `jobs`, `notifications`, `extensions`, `broadcasts`, `events`, `loginlogs`
- User profile document ids (`manager`, `ahmed_1716…`, etc.)
- Fields like `owner`, `userId`, `byId` on existing records

## What changes

- Sign-in uses **email + password** (Firebase Authentication)
- Plaintext `password` on user docs is removed after activation
- New collection: `usersByAuth/{firebaseUid}` → `{ profileId: "ahmed_..." }`

## One-time per user: Activate account

1. Open app → **Activate account**
2. **Name** — exactly as shown in Manage Users
3. **Old or temporary password** — previous app password OR temp password from manager
4. **Work email** + **new password**

Firebase creates the auth user; the app links it to the existing Firestore profile. All jobs for that profile id remain visible.

## Manager first

Default bootstrap user: name **Manager**, temp password **manager123** (until you change it in Firestore). Activate with your real email, then sign in normally.

## New employees (after v1.2)

Manager adds user with **email** + **temporary password**. Employee uses **Activate account** (not Sign in) the first time.

## Firestore rules

Use `firestore.rules` in this folder. Rules require:

- Signed in with Firebase Auth
- `usersByAuth` mapping for data access

Open rules (`if true`) are no longer recommended.

## Optional: Admin bulk import

If you have many users, a one-time Node script with Firebase Admin SDK can create Auth users and `usersByAuth` rows. Not required for small teams — activation in the UI is enough.
