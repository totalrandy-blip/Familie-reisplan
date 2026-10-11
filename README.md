# Familie Reisplan

A shared family trip planner that installs on a phone like an app (PWA).
Everyone with the link can edit; changes sync live to everyone and show who changed what, and when.

- Hosting: GitHub Pages (static files)
- Shared data: Firebase Firestore, with invisible anonymous sign-in
- Offline: the app opens without internet and saves edits until the connection is back

Only the project owner needs a Google/Firebase account. Family members just open the link.

## One-time setup (about 10 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> and click **Create a project** (name it e.g. `familie-reisplan`). Google Analytics is not needed.
2. **Build → Firestore Database → Create database**. Pick location `eur3 (europe-west)` and start in **production mode**.
3. In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules) and click **Publish**.
4. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable → Save**.
5. **Project settings** (gear icon) **→ General → Your apps → Web (`</>`)**. Register an app (no Hosting needed). Copy the `firebaseConfig` values into [`config.js`](config.js).

The config values are not secret; the security rules decide who can read and write.

### 2. Publish on GitHub Pages
1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
3. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.
4. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain →** `<your-username>.github.io`.

### 3. First open
Open the link once yourself. On first load the app imports the existing Hong Kong plan from [`seed.json`](seed.json) (once only; it never overwrites data that is already there).

## Install on a phone
- **iPhone (Safari):** Share button → **Add to Home Screen**.
- **Android (Chrome):** menu ⋮ → **Install app** / **Add to Home screen**.

Each person is asked for their name once per device. That name appears next to everything they change.

## Changing the code
The page loads the bundled `app.js`. Edit `src/app.js`, then run `npm run build` (needs Node.js) to regenerate `app.js`, and commit both.
When you change any file, bump `CACHE` in `sw.js` (e.g. `reisplan-v2`) so installed phones pick up the new version.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page layout and styling |
| `src/app.js` | App logic (source) |
| `app.js` | Bundled app logic + Firebase SDK (generated) |
| `config.js` | Your Firebase project settings |
| `firestore.rules` | Database security rules to paste into Firebase |
| `seed.json` | The existing trip plan, imported once on first open |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA install and offline support |
