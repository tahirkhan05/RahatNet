/**
 * Unit tests for lib/utils/indexeddb.ts
 *
 * Coverage targets:
 *   - savePendingReport: stores a report with queuedAt and retryCount=0
 *   - getPendingReports: returns reports sorted by queuedAt
 *   - getPendingReport:  returns one report by ID, undefined when absent
 *   - deletePendingReport: removes the record
 *   - updatePendingReport: full field update
 *   - incrementRetryCount: increments without touching other fields
 *   - clearAllPendingReports: empties the store
 *   - getPendingReportCount: returns accurate count
 *   - IdbError: typed error with correct message format
 *
 * jsdom ships a partial IndexedDB implementation via fake-indexeddb.
 * We do NOT mock IDB — we test the real module against the real jsdom IDB
 * so the tests catch actual storage logic bugs, not just mock interactions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IdbError } from '@/lib/utils/indexeddb';
import { NeedType } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeReport(overrides: { id?: string; type?: NeedType; affectedCount?: number } = {}) {
  return {
    id:                   overrides.id ?? `report-${Math.random().toString(36).slice(2)}`,
    type:                 overrides.type ?? NeedType.RESCUE,
    description:          'Test description of sufficient length for validation',
    originalDescription:  'Test original description',
    originalLanguage:     'en',
    voiceNoteUrl:         null as string | null,
    photoUrls:            [] as string[],
    location:             { lat: 10.0167, lng: 76.3417 },
    locationName:         'Aluva, Ernakulam',
    affectedCount:        overrides.affectedCount ?? 3,
    hasVulnerable:        false,
    disasterEventId:      'disaster-001',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lib/utils/indexeddb', () => {
  // Reset module state between tests so the DB singleton re-opens cleanly.
  // jsdom's fake-indexeddb persists within a test file unless we clear it.
  // The module's singleton is reset by re-importing with the vitest module cache.
  let idb: typeof import('@/lib/utils/indexeddb');

  beforeEach(async () => {
    // Dynamically import to get a fresh module — vitest re-evaluates.
    idb = await import('@/lib/utils/indexeddb');
    // Clear the store before each test.
    try {
      await idb.clearAllPendingReports();
    } catch {
      // Ignore if not yet open.
    }
  });

  // ── savePendingReport ───────────────────────────────────────────────────

  it('saves a report and sets queuedAt + retryCount=0', async () => {
    const report = makeReport();
    await idb.savePendingReport(report);

    const saved = await idb.getPendingReport(report.id);
    expect(saved).toBeDefined();
    expect(saved?.id).toBe(report.id);
    expect(saved?.retryCount).toBe(0);
    expect(typeof saved?.queuedAt).toBe('number');
    expect(saved?.queuedAt).toBeGreaterThan(0);
  });

  it('overwrites an existing report on duplicate ID (put semantics)', async () => {
    const report = makeReport({ id: 'fixed-id' });
    await idb.savePendingReport(report);
    await idb.savePendingReport({ ...report, affectedCount: 99 });

    const saved = await idb.getPendingReport('fixed-id');
    expect(saved?.affectedCount).toBe(99);

    const all = await idb.getPendingReports();
    expect(all).toHaveLength(1);
  });

  // ── getPendingReports ───────────────────────────────────────────────────

  it('returns reports sorted by queuedAt (ascending)', async () => {
    const r1 = makeReport({ id: 'r1' });
    const r2 = makeReport({ id: 'r2' });

    await idb.savePendingReport(r1);
    // Small delay so queuedAt differs.
    await new Promise((res) => setTimeout(res, 2));
    await idb.savePendingReport(r2);

    const reports = await idb.getPendingReports();
    expect(reports).toHaveLength(2);
    expect(reports[0]?.id).toBe('r1');
    expect(reports[1]?.id).toBe('r2');
  });

  it('returns empty array when store is empty', async () => {
    const reports = await idb.getPendingReports();
    expect(reports).toHaveLength(0);
  });

  // ── getPendingReport ────────────────────────────────────────────────────

  it('returns undefined for an ID that does not exist', async () => {
    const result = await idb.getPendingReport('nonexistent-id');
    expect(result).toBeUndefined();
  });

  it('returns the correct report by ID when multiple exist', async () => {
    const r1 = makeReport({ id: 'alpha' });
    const r2 = makeReport({ id: 'beta'  });
    await idb.savePendingReport(r1);
    await idb.savePendingReport(r2);

    const found = await idb.getPendingReport('beta');
    expect(found?.id).toBe('beta');
  });

  // ── deletePendingReport ─────────────────────────────────────────────────

  it('removes a report by ID', async () => {
    const report = makeReport({ id: 'to-delete' });
    await idb.savePendingReport(report);
    await idb.deletePendingReport('to-delete');

    const result = await idb.getPendingReport('to-delete');
    expect(result).toBeUndefined();
  });

  it('is a no-op when deleting a non-existent ID', async () => {
    await expect(idb.deletePendingReport('ghost')).resolves.toBeUndefined();
  });

  // ── updatePendingReport ─────────────────────────────────────────────────

  it('updates mutable fields without touching others', async () => {
    const report = makeReport({ id: 'patch-me', affectedCount: 3 });
    await idb.savePendingReport(report);

    await idb.updatePendingReport('patch-me', { affectedCount: 10 });

    const updated = await idb.getPendingReport('patch-me');
    expect(updated?.affectedCount).toBe(10);
    expect(updated?.id).toBe('patch-me');           // unchanged
    expect(updated?.locationName).toBe('Aluva, Ernakulam'); // unchanged
  });

  it('throws IdbError when updating a non-existent ID', async () => {
    await expect(
      idb.updatePendingReport('missing', { affectedCount: 1 }),
    ).rejects.toBeInstanceOf(IdbError);
  });

  // ── incrementRetryCount ─────────────────────────────────────────────────

  it('increments retryCount from 0 to 1', async () => {
    const report = makeReport({ id: 'retry-me' });
    await idb.savePendingReport(report);

    await idb.incrementRetryCount('retry-me');

    const updated = await idb.getPendingReport('retry-me');
    expect(updated?.retryCount).toBe(1);
  });

  it('increments retryCount from 1 to 2 on second call', async () => {
    const report = makeReport({ id: 'retry-twice' });
    await idb.savePendingReport(report);
    await idb.incrementRetryCount('retry-twice');
    await idb.incrementRetryCount('retry-twice');

    const updated = await idb.getPendingReport('retry-twice');
    expect(updated?.retryCount).toBe(2);
  });

  it('is a no-op for non-existent ID (does not throw)', async () => {
    await expect(idb.incrementRetryCount('ghost')).resolves.toBeUndefined();
  });

  // ── clearAllPendingReports ──────────────────────────────────────────────

  it('removes all reports', async () => {
    await idb.savePendingReport(makeReport({ id: 'a' }));
    await idb.savePendingReport(makeReport({ id: 'b' }));
    await idb.savePendingReport(makeReport({ id: 'c' }));

    await idb.clearAllPendingReports();

    const all = await idb.getPendingReports();
    expect(all).toHaveLength(0);
  });

  // ── getPendingReportCount ───────────────────────────────────────────────

  it('returns 0 for an empty store', async () => {
    expect(await idb.getPendingReportCount()).toBe(0);
  });

  it('returns the correct count after saves and deletes', async () => {
    await idb.savePendingReport(makeReport({ id: 'c1' }));
    await idb.savePendingReport(makeReport({ id: 'c2' }));
    await idb.savePendingReport(makeReport({ id: 'c3' }));
    expect(await idb.getPendingReportCount()).toBe(3);

    await idb.deletePendingReport('c2');
    expect(await idb.getPendingReportCount()).toBe(2);
  });

  // ── IdbError ────────────────────────────────────────────────────────────

  it('IdbError has the correct name, operation, and message format', () => {
    const err = new IdbError('savePendingReport', new Error('QuotaExceeded'));
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(IdbError);
    expect(err.name).toBe('IdbError');
    expect(err.operation).toBe('savePendingReport');
    expect(err.message).toContain('savePendingReport');
    expect(err.message).toContain('QuotaExceeded');
  });

  it('IdbError with a string cause', () => {
    const err = new IdbError('getAll', 'timeout');
    expect(err.message).toContain('timeout');
  });
});
