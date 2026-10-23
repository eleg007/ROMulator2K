/**
 * FLASHBACK — Cloud Functions
 *
 * ONE-TIME SETUP:
 *
 * 1. Create the file  functions/.env.emulation2k  (gitignored, never committed):
 *      GMAIL_USER=you@gmail.com
 *      GMAIL_PASS=your-16-char-app-password
 *
 *    Get an App Password at:
 *    myaccount.google.com → Security → 2-Step Verification → App passwords
 *
 * 2. Deploy:
 *      firebase deploy --only functions
 */

const { onDocumentUpdated }  = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions }   = require('firebase-functions/v2');
const admin                  = require('firebase-admin');
const nodemailer             = require('nodemailer');

admin.initializeApp();

// Hard cap on instances — prevents runaway billing
setGlobalOptions({ maxInstances: 5, timeoutSeconds: 30, memory: '128MiB' });

// ══════════════════════════════════════════════════
//  Send approval email when status → 'approved'
// ══════════════════════════════════════════════════
exports.onUserStatusChanged = onDocumentUpdated('users/{uid}', async (event) => {
  const before = event.data.before.data();
  const after  = event.data.after.data();

  if (before.status === 'approved' || after.status !== 'approved') return null;

  const email    = after.email;
  const username = after.username || 'there';
  if (!email) return null;

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_PASS;

  if (!gmailUser || !gmailPass) {
    console.error('GMAIL_USER or GMAIL_PASS not set in .env.emulation2k');
    return null;
  }

  try {
    await nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    }).sendMail({
      from:    `FLASHBACK <${gmailUser}>`,
      to:      email,
      subject: '🎮 Your FLASHBACK account has been approved!',
      html: `
        <div style="font-family:monospace;background:#0a0a0f;color:#e8e8f0;padding:32px;border-radius:8px;max-width:480px;">
          <h1 style="color:#ff4655;letter-spacing:0.1em;margin-bottom:4px;">FLASH<span style="color:#ffcc00;">BACK</span></h1>
          <p style="color:#5a5a78;font-size:12px;letter-spacing:0.2em;margin-bottom:24px;">FLASH GAME EMULATOR</p>
          <p>Hey <strong>${username}</strong>,</p><br/>
          <p>Your account has been <strong style="color:#44ff88;">approved</strong>. You can now sign in and play!</p>
          <br/><p style="color:#5a5a78;font-size:12px;">— The FLASHBACK Admin</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('Approval email failed:', err);
  }
  return null;
});

// ══════════════════════════════════════════════════
//  Admin: update a user's Firebase Auth email
// ══════════════════════════════════════════════════
exports.adminUpdateEmail = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.');
  const caller = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (!caller.exists || caller.data().role !== 'admin')
    throw new HttpsError('permission-denied', 'Admins only.');
  const { uid, newEmail } = request.data;
  if (!uid || !newEmail) throw new HttpsError('invalid-argument', 'uid and newEmail required.');
  await admin.auth().updateUser(uid, { email: newEmail });
  return { success: true };
});

// ══════════════════════════════════════════════════
//  Admin: delete a user from Firebase Auth
// ══════════════════════════════════════════════════
exports.adminDeleteUser = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.');
  const caller = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (!caller.exists || caller.data().role !== 'admin')
    throw new HttpsError('permission-denied', 'Admins only.');
  const { uid } = request.data;
  if (!uid) throw new HttpsError('invalid-argument', 'uid required.');
  if (uid === request.auth.uid) throw new HttpsError('failed-precondition', 'Cannot delete yourself.');
  await admin.auth().deleteUser(uid);
  return { success: true };
});
