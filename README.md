# RMI Job Allocator v1.4 — Release Bundle TEST123

This folder is intended to be a **clean, standalone “release” bundle** of your app for deploying to **Cloudflare Pages** (static hosting) while using **Firebase Authentication + Firestore** (and optionally Firebase Storage for attachments).

Because of an environment restriction right now, I could not auto-copy files into this folder for you. Use the checklist in `FILES_NEEDED.txt` to finish populating it.

When the folder contains the files listed in `FILES_NEEDED.txt`, it will be ready to:
1. Re-build `site/` output with `split_site.py`
2. Deploy the output to Cloudflare Pages
3. Configure Firebase rules/activation

---

## What “v1.4” means in this app

The UI is a job allocator with the following high-level capabilities:

### Job management (Jobs hub)
You create and manage jobs through a lifecycle:
- **Pending**: created, not started
- **Ongoing**: started, actively being worked
- **Paused**: work paused
- **Completed**: finished, completion timestamp tracked

For each job, the app tracks (and displays) typical fields such as:
- Client
- Job number
- Type
- Employee assignment state (self-added vs manager-assigned)
- Priority (`High`, `Medium`, `Low`)
- Status
- Deadline / due indicators
- Optional manager/completion notes (role-gated)
- Tags

### Timeline + Comments (per job)
Each job can show:
- A **timeline** of job-related events (edits/actions)
- A **comment thread** for that job

### Mentions and notifications
If you type `@Name` in notes/comments, the app attempts to resolve users by display name and sends notifications to eligible roles (managers/supervisors depending on role logic).

### Attachments (optional Firebase Storage)
When enabled, jobs support uploading attachments (images and documents).
- Files are limited client-side to **max 8MB per file**
- Attachments are uploaded to Firebase Storage under a path shaped like:
  - `jobs/{jobId}/{timestamp}_{filename}`
- After upload, the attachment list is refreshed with URLs.

### Bulk actions
Multi-select jobs and apply bulk operations:
- Change status
- Reassign
- Delete selected (permission gated)

---

## Calendar view (Team → Calendar)

The Calendar shows a monthly grid of days.
Key behavior:
- Days can indicate whether items exist (based on job deadlines/events logic).
- Clicking a day opens a modal with items relevant to that day.

---

## Insights / Analytics (Insights hub)

The Insights area provides:
- Dashboard-style panels (recent activity, overdue summaries, pending extension summaries)
- Charts (bars + pies) depending on the subsection
- Export functionality:
  - Weekly export (manual trigger)
  - Auto-download behavior while the app is open on a schedule

---

## Extensions review (Insights → Extensions)

Deadline extension requests are managed here:
- List pending extension requests
- Approve/reject flows update deadline fields
- Actions are permission gated by role

---

## Messages / Broadcasts (Messages hub → Broadcasts)

Broadcasts are “management messages” that:
- Can be sent by authorized roles
- Appear in a history list
- Can trigger notification-style behavior
- Allow dismissing notifications while keeping history viewable

---

## Account hub (Account)

Account is role-aware and includes:
- Profile view (who you are, role)
- Preferences (UI behavior and local settings)
- Admin sections (permission gated), including user/team admin
- Activity log (audit trail; permission gated)

---

## Deployment architecture (boring but correct)

### Cloudflare Pages
Cloudflare Pages hosts **static files only**:
- HTML
- CSS
- JS
- manifest/sw for PWA

The app’s “backend” is Firebase:
- Authentication: Firebase Auth (email + password)
- Data: Firestore
- Optional attachments: Firebase Storage

---

## Step-by-step: build `site/` locally

### 1) Ensure you have the required files
Populate this folder with everything in `FILES_NEEDED.txt`.

### 2) Build output
Run:

```powershell
cd "C:\Users\YOUR_USER\Desktop\the index\RMI Job Allocator v1.4"
python split_site.py
```

You should get:
- `site/index.html`
- `site/css/app.css`
- `site/js/main.js`
- plus any files `split_site.py` copies into `site/` (notably the PWA and manifest files).

---

## Step-by-step: deploy to Cloudflare Pages

1. Go to [Cloudflare Dashboard → Workers & Pages → Create → Pages]
2. Choose “Upload assets”
3. Upload the **`site/` folder**
4. Deploy

Your app URL will be something like:
- `https://<your-project>.pages.dev`

---

## Firebase setup (Auth + Firestore)

### 1) Publish Firestore rules
Open Firebase Console → Firestore → Rules:
1. Paste the contents of `firestore.rules`
2. Publish

The provided rules require:
- Users must be signed-in
- Data access depends on:
  - `usersByAuth` mapping existence for the authenticated Firebase UID
  - role checks like `manager` / `supervisor`

### 2) Auth migration + Activation
Follow `FIREBASE-AUTH-SETUP.md`:
- The app uses Firebase Authentication for sign-in (email + password).
- Users must be **activated** in the app once for v1.2+ style auth mapping.
- Manager first bootstrap step exists.

In short:
- Manager activates first
- Then employees activate via the UI using the temporary/old password logic described in the doc

### 3) Authorized domains
In Firebase Console:
- Authentication → Settings → Authorized domains
- Add your Pages URL(s)
- If using a custom domain, add that too

Also restrict the Firebase API key to the Cloudflare hostname(s) you deploy on.

---

## Optional: Firebase Storage for attachments

If you want job attachments to work:
- Ensure Firebase Storage is enabled
- Configure Storage rules appropriately
- Ensure the app can call `getStorage(app)` and that the bucket is accessible

If you don’t care about attachments:
- You can still deploy and use the core job logic without Storage.

---

## Local testing notes

Because the app is a front-end SPA and uses a module script (Firebase from CDN):
- Prefer testing over a local static server (avoid “file://” weirdness)

Example:

```powershell
cd "C:\Users\YOUR_USER\Desktop\the index\RMI Job Allocator v1.4\site"
python -m http.server 8080
```

Open:
- `http://localhost:8080/`

Then test:
- login / activation
- job CRUD
- timeline and comments
- notifications/mentions
- attachments (if configured)

---

## How to update the app later (keep it boring)

1. Edit `index.html` in this release folder
2. Re-run:
   - `python split_site.py`
3. Re-deploy Cloudflare Pages using updated `site/`

---

## Troubleshooting (specific, annoying, useful)

### Blank page
- Open DevTools → Console
- Check that `site/index.html` loads:
  - `css/app.css`
  - `js/main.js`

### Firebase auth domain error
- Ensure your Cloudflare Pages URL is in:
  - Firebase Auth → Authorized domains

### Firestore permission denied
- Ensure:
  - Firestore rules are published
  - usersByAuth mapping exists (activation happened)

---

## Checklist for you before you deploy

- [ ] `split_site.py` runs cleanly and produces `site/`
- [ ] Cloudflare Pages deploys the `site/` folder
- [ ] Firebase Auth is enabled (email/password)
- [ ] `firestore.rules` is published
- [ ] Manager account is activated
- [ ] Authorized domains include the Pages URL
- [ ] (optional) Storage rules + bucket configured if attachments needed

