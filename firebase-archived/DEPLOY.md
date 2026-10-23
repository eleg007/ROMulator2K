# FLASHBACK — Deploy Guide

## Project structure

```
flashback/
├── public/
│   └── index.html
├── functions/
│   ├── index.js
│   ├── package.json
│   └── .env.emulation2k    ← you create this, never commit it
├── .firebaserc
├── .gitignore
├── firebase.json
├── firestore.rules
└── storage.rules
```

---

## STEP 1 — Install Firebase CLI (once)

```bash
npm install -g firebase-tools
firebase login
```

---

## STEP 2 — Install function dependencies

```bash
cd functions
npm install
cd ..
```

---

## STEP 3 — Create your Gmail env file

Create `functions/.env.emulation2k` — this file is gitignored and never committed:

```
GMAIL_USER=you@gmail.com
GMAIL_PASS=your-16-char-app-password
```

To get a Gmail App Password:
1. myaccount.google.com → Security
2. Enable 2-Step Verification if not already on
3. Search "App passwords" → create one → copy the 16-character code

---

## STEP 4 — Deploy everything

```bash
firebase deploy
```

This deploys hosting, functions, Firestore rules, and Storage rules in one shot.

To deploy only specific parts:
```bash
firebase deploy --only hosting
firebase deploy --only functions
firebase deploy --only firestore:rules,storage:rules
```

---

## Firebase Console checklist (one-time setup)

- [ ] Authentication → Sign-in method → **Email/Password** → Enabled
- [ ] Authentication → Sign-in method → **Google** → Enabled (requires support email)
- [ ] **Firestore Database** created → Production mode
- [ ] **Storage** created → Production mode, same region as Firestore
- [ ] **Blaze plan** enabled (required for Functions — free tier still applies)

---

## After deploying

- To update the app: edit `public/index.html` → `firebase deploy --only hosting`
- To update functions: edit `functions/index.js` → `firebase deploy --only functions`
- To update rules: edit the `.rules` files → `firebase deploy --only firestore:rules,storage:rules`

---

## Spending protection

- Functions hard-capped at **5 max instances** (set in `functions/index.js`)
- Storage rules block uploads over **50MB** and non-.swf files
- Only approved users can upload (enforced by Firestore rules)
- Set a budget alert: console.cloud.google.com → Billing → Budgets & alerts → **$5 limit**
