# Deploy RMI Job Allocator on Cloudflare Pages

Cloudflare Pages hosts **static files** (HTML, CSS, JS). It does not run PHP or Node on the server — your app talks to Firebase from the browser, which is exactly what you want.

## 1. Build the `site/` folder

From this folder in PowerShell:

```powershell
cd "$env:USERPROFILE\Desktop\the index"
python split_site.py
```

You should get:

```
site/
  index.html
  css/app.css
  js/main.js
```

**Deploy the `site/` folder**, not the root `index.html` (root is the dev copy; after splitting, keep them in sync by re-running `split_site.py` whenever you edit `index.html`).

## 2. Create a Cloudflare Pages project

1. Go to [https://dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Project name: e.g. `rmi-job-allocator`.
3. Drag the **`site`** folder (or zip it first).
4. Deploy.

Your URL will look like: `https://rmi-job-allocator.pages.dev`

## 3. Custom domain (optional)

Pages → your project → **Custom domains** → add e.g. `jobs.yourcompany.com` and follow DNS instructions.

## 4. Firebase: allow your domain

1. Firebase Console → **Authentication** → **Settings** → **Authorized domains** → Add your `*.pages.dev` URL and custom domain.
2. **Project settings** → restrict the **API key** to your Cloudflare hostname(s).

## 5. Publish Firestore rules

Copy `firestore.rules` into Firebase Console → Firestore → **Rules** → **Publish**.

## 6. Team rollout (v1.2 Auth)

1. Enable **Email/Password** in Firebase Authentication.
2. Deploy the new site.
3. **Manager first:** Activate account → Name `Manager` → temp password `manager123` (or what you set in Firestore) → work email → new password.
4. Each employee: **Activate account** (name + temp password from manager + email). Jobs stay under the same profile id.

## Updating the app later

1. Edit `index.html` in the project root (or edit `site/` files directly if you prefer).
2. Run `python split_site.py` if you edited root `index.html`.
3. Cloudflare Pages → **Upload new version** (or connect Git — see below).

### Git deploy (recommended later)

1. Put the repo on GitHub with `site/` as the output (or use root with build command `python split_site.py` and output directory `site`).
2. Pages → **Connect to Git** → build command: `python split_site.py` → build output directory: `site`.

## Folder layout reference

| Path | Purpose |
|------|---------|
| `index.html` | Main source (edit here) |
| `split_site.py` | Generates deployable `site/` |
| `site/` | **Upload this to Cloudflare** |
| `firestore.rules` | Paste into Firebase Console |
| `FIREBASE-AUTH-SETUP.md` | Auth migration notes |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Blank page | Browser DevTools → Console; check `js/main.js` path is `js/main.js` not `/js/main.js` on wrong subpath |
| Auth domain error | Add Pages URL to Firebase Authorized domains |
| Permission denied on Firestore | Publish `firestore.rules`; user must **Activate** so `usersByAuth` exists |
| Old login only | Hard refresh (Ctrl+F5); confirm v1.2.0 in header |
