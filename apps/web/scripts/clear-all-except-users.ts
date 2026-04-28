/**
 * One-shot script: delete everything except user accounts.
 * Collections cleared: rawReports, needs, assignments, resources,
 *   disasterEvents, imdAlerts, alertTriggers, urgencyScoreHistory, dispatchAuditLog
 * Collection preserved: users (all roles/profiles kept)
 *
 * Usage: npx tsx scripts/clear-all-except-users.ts --force
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../.env.local');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && val && !process.env[key]) process.env[key] = val;
  }
}

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  const b64 = process.env['FIREBASE_SERVICE_ACCOUNT_BASE64'];
  if (!b64) {
    console.error('FIREBASE_SERVICE_ACCOUNT_BASE64 not set.');
    process.exit(1);
  }
  initializeApp({ credential: cert(JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'))) });
}

const db = getFirestore();

const COLLECTIONS = [
  'rawReports',
  'needs',
  'assignments',
  'resources',
  'disasterEvents',
  'imdAlerts',
  'alertTriggers',
  'urgencyScoreHistory',
  'dispatchAuditLog',
];

async function deleteAll(col: string): Promise<number> {
  let deleted = 0;
  while (true) {
    const snap = await db.collection(col).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snap.docs.length;
    if (snap.docs.length < 400) break;
  }
  return deleted;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (yes/no): `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const force = process.argv.includes('--force');
  console.log('\nThis will delete ALL documents in these collections (users are safe):');
  for (const c of COLLECTIONS) console.log(`  - ${c}`);
  console.log();

  if (!force) {
    const ok = await confirm('Proceed?');
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  let total = 0;
  for (const col of COLLECTIONS) {
    process.stdout.write(`  Clearing ${col}...`);
    const n = await deleteAll(col);
    process.stdout.write(` ${n} deleted\n`);
    total += n;
  }

  console.log(`\nDone. ${total} documents deleted. Users preserved.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
