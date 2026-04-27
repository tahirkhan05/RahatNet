/**
 * RahatNet Demo Cleanup Script
 *
 * Removes ALL documents that were created by seed-demo.ts.
 * Safety guarantees:
 *   - Only deletes documents where isDemoData === true
 *   - Asks for confirmation before deleting (unless --force flag is passed)
 *   - Shows a count of documents to be deleted before proceeding
 *   - Runs in dry-run mode by default when --dry-run is passed
 *
 * Usage:
 *   pnpm --filter @rahatnet/web seed:clear
 *   pnpm --filter @rahatnet/web seed:clear -- --force      # skip confirmation
 *   pnpm --filter @rahatnet/web seed:clear -- --dry-run    # preview only
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Firebase Admin init
// ---------------------------------------------------------------------------

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function initAdmin() {
  if (getApps().length > 0) return;
  const b64 = process.env['FIREBASE_SERVICE_ACCOUNT_BASE64'];
  if (!b64) { console.error('❌  FIREBASE_SERVICE_ACCOUNT_BASE64 not set.'); process.exit(1); }
  const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  initializeApp({ credential: cert(sa) });
}

initAdmin();
const db = getFirestore();

// ---------------------------------------------------------------------------
// Spinner helper
// ---------------------------------------------------------------------------

interface Spinner {
  start(text?: string): this;
  succeed(text?: string): this;
  fail(text?: string): this;
  text: string;
}

async function getSpinner(text: string): Promise<Spinner> {
  try {
    const { default: ora } = await import('ora');
    return ora(text).start();
  } catch {
    console.log(`  ${text}`);
    return {
      text,
      start(t?: string) { if (t) console.log(`  ${t}`); return this; },
      succeed(t?: string) { console.log(`  ✔  ${t ?? this.text}`); return this; },
      fail(t?: string) { console.error(`  ✖  ${t ?? this.text}`); return this; },
    };
  }
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Collections to clean
// ---------------------------------------------------------------------------

const DEMO_COLLECTIONS = [
  'rawReports',
  'needs',
  'assignments',
  'users',
  'resources',
  'disasterEvents',
  'imdAlerts',
  'alertTriggers',
  'urgencyScoreHistory',
  'dispatchAuditLog',
] as const;

// ---------------------------------------------------------------------------
// Count and delete demo documents in a collection
// ---------------------------------------------------------------------------

async function countDemoDocuments(collection: string): Promise<number> {
  const snap = await db.collection(collection)
    .where('isDemoData', '==', true)
    .count()
    .get();
  return snap.data().count;
}

async function deleteDemoDocuments(
  collection: string,
  dryRun: boolean,
): Promise<number> {
  let deleted = 0;

  while (true) {
    const snap = await db.collection(collection)
      .where('isDemoData', '==', true)
      .limit(400)
      .get();

    if (snap.empty) break;

    if (!dryRun) {
      const batch = db.batch();
      for (const doc of snap.docs) batch.delete(doc.ref);
      await batch.commit();
    }

    deleted += snap.docs.length;
    if (snap.docs.length < 400) break;
  }

  return deleted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args     = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isForce  = args.includes('--force');

  console.log('\n🗑️   RahatNet Demo Cleanup\n');

  if (isDryRun) {
    console.log('  ℹ️  DRY RUN — no data will be deleted\n');
  }

  // Count all demo documents across every collection.
  let spinner = await getSpinner('Counting demo documents…');
  const counts: Record<string, number> = {};
  let totalDocs = 0;

  for (const col of DEMO_COLLECTIONS) {
    const n = await countDemoDocuments(col);
    if (n > 0) {
      counts[col] = n;
      totalDocs += n;
    }
  }

  spinner.succeed(`Found ${totalDocs} demo documents across ${Object.keys(counts).length} collections`);

  if (totalDocs === 0) {
    console.log('\n  ✅  Nothing to delete — demo data is already clean.\n');
    process.exit(0);
  }

  // Show breakdown.
  console.log('\n  Documents to delete:');
  for (const [col, count] of Object.entries(counts)) {
    console.log(`    ${col.padEnd(25)} ${count}`);
  }
  console.log();

  if (isDryRun) {
    console.log('  ℹ️  Dry run complete — pass without --dry-run to actually delete.\n');
    process.exit(0);
  }

  // Confirmation gate.
  if (!isForce) {
    const ok = await confirm(
      `  ⚠️  This will permanently delete ${totalDocs} documents. Continue?`,
    );
    if (!ok) {
      console.log('\n  Aborted — no changes made.\n');
      process.exit(0);
    }
  }

  console.log();

  // Delete.
  let totalDeleted = 0;

  for (const col of DEMO_COLLECTIONS) {
    if (!counts[col]) continue;
    spinner = await getSpinner(`Deleting ${counts[col]} documents from ${col}…`);
    const deleted = await deleteDemoDocuments(col, false);
    totalDeleted += deleted;
    spinner.succeed(`Deleted ${deleted} documents from ${col}`);
  }

  console.log(`\n✅  Deleted ${totalDeleted} demo documents.\n`);

  // Also remove the disaster event document by known ID.
  const evSnap = await db.collection('disasterEvents').doc('demo-kerala-flood-2018').get();
  if (evSnap.exists && evSnap.data()?.isDemoData) {
    await db.collection('disasterEvents').doc('demo-kerala-flood-2018').delete();
    console.log('   Removed disaster event: demo-kerala-flood-2018');
  }

  console.log();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌  Clear script failed:', err);
  process.exit(1);
});
