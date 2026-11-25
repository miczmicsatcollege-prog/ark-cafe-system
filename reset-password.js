'use strict';
// Reset a user's password from the command line (for when the admin is locked out).
//   node reset-password.js admin@arkcafe.ph               -> generates a random password and prints it
//   node reset-password.js admin@arkcafe.ph NewPass1234   -> sets the password you give (8+ characters)
// Uses DATA_DIR like the server does. Safe to run while the server is running.
const path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const [email, given] = process.argv.slice(2);
if (!email) { console.error('Usage: node reset-password.js <email> [new-password]'); process.exit(1); }
const pw = given || crypto.randomBytes(9).toString('base64url');
if (pw.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
const db = new DatabaseSync(path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'ark-cafe.db'));
db.exec('PRAGMA busy_timeout=5000');
const u = db.prepare('SELECT id,name,role FROM users WHERE email=?').get(email.trim());
if (!u) { console.error('No user with that email.'); process.exit(1); }
const salt = crypto.randomBytes(16).toString('hex');
db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'), u.id);
db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
console.log(`Password reset for ${u.name} (${u.role}). New password: ${pw}\nThey were signed out everywhere. Ask them to change it under Account.`);
