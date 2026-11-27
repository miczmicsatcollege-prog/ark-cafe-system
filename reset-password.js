
'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');

const email = (process.argv[2] || '')
  .trim()
  .toLowerCase();

const password = process.env.RESET_PASSWORD;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

if (!email || !password || password.length < 8 ||
    password.length > 100) {
  console.error(
    'Provide an email and set RESET_PASSWORD (8-100 characters).'
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [email]
    );

    if (!result.rows.length) {
      throw new Error('User not found.');
    }

    const user = result.rows[0];

    const salt = crypto.randomBytes(16)
      .toString('hex');

    const passwordHash = salt + ':' +
      crypto.scryptSync(password, salt, 64)
        .toString('hex');

    await client.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, user.id]
    );

    await client.query(
      'DELETE FROM sessions WHERE user_id = $1',
      [user.id]
    );

    await client.query('COMMIT');

    console.log('Password reset successfully.');
    console.log('Existing sessions have been revoked.');

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch(error => {
    console.error('Password reset failed:',
      error.code || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
