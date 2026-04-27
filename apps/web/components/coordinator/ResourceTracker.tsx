'use client';

/**
 * ResourceTracker — war-room right panel for physical resource management.
 *
 * Features:
 *  1. Live inventory table — Firestore subscription on /resources scoped to the
 *     active disaster.  Colour-coded by availability:
 *       red   < 10% available
 *       amber < 30% available
 *       green otherwise
 *
 *  2. Duplication warning — if 2+ resources are deployed to the exact same
 *     locationName a banner shows "Two boats to the same house" risk.
 *
 *  3. Add resource form — type, quantity, locationName, optional assignedTo.
 *     Writes a new /resources doc via POST /api/resources.
 *
 *  4. Allocation history — last 10 allocation events across all resources.
 *
 *  5. PDF export — @react-pdf/renderer generates a resource allocation report
 *     on the client and triggers a download.  No server round-trip needed.
 *
 * Accessibility:
 *  - Table has correct role="table" structure with th[scope] attributes.
 *  - Status colours have text labels so they are never colour-alone.
 *  - Form inputs have aria-label / htmlFor pairings.
 *  - Duplication warning is role="alert" so screen readers announce it.
 */

import * as React from 'react';
import {
  Anchor, Box, Cross, Home, Truck, Radio,
  Plus, Download, AlertTriangle, ChevronDown, ChevronUp,
  Loader2, RefreshCw,
} from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ResourceType, ResourceStatus,
  type Resource, type ResourceSummary,
  COLLECTIONS,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Resource icon + label mapping
// ---------------------------------------------------------------------------

const RESOURCE_ICONS: Record<ResourceType, React.ReactNode> = {
  [ResourceType.BOAT]:                 <Anchor    className="h-4 w-4" aria-hidden="true" />,
  [ResourceType.FOOD_PACKET]:          <Box       className="h-4 w-4" aria-hidden="true" />,
  [ResourceType.MEDICINE_KIT]:         <Cross     className="h-4 w-4" aria-hidden="true" />,
  [ResourceType.SHELTER_KIT]:          <Home      className="h-4 w-4" aria-hidden="true" />,
  [ResourceType.VEHICLE]:              <Truck     className="h-4 w-4" aria-hidden="true" />,
  [ResourceType.COMMUNICATION_DEVICE]: <Radio     className="h-4 w-4" aria-hidden="true" />,
};

const RESOURCE_LABELS: Record<ResourceType, string> = {
  [ResourceType.BOAT]:                 'Boats',
  [ResourceType.FOOD_PACKET]:          'Food Packets',
  [ResourceType.MEDICINE_KIT]:         'Medicine Kits',
  [ResourceType.SHELTER_KIT]:          'Shelter Kits',
  [ResourceType.VEHICLE]:              'Vehicles',
  [ResourceType.COMMUNICATION_DEVICE]: 'Comms Devices',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSummary(resource: Resource): ResourceSummary {
  const available       = resource.quantity - resource.deployed;
  const deploymentRate  = resource.quantity > 0 ? (resource.deployed / resource.quantity) * 100 : 0;
  return {
    resource,
    available,
    deploymentRate,
    isLow:      available > 0 && available / resource.quantity < 0.10,
    isDepleted: available <= 0,
  };
}

function availabilityColor(summary: ResourceSummary): string {
  if (summary.isDepleted || summary.isLow) return 'text-red-600 dark:text-red-400';
  if (summary.available / summary.resource.quantity < 0.30) return 'text-amber-600 dark:text-amber-400';
  return 'text-green-600 dark:text-green-400';
}

function availabilityLabel(summary: ResourceSummary): string {
  if (summary.isDepleted) return 'Depleted';
  if (summary.isLow)      return 'Critical';
  if (summary.available / summary.resource.quantity < 0.30) return 'Low';
  return 'Good';
}

// ---------------------------------------------------------------------------
// Duplication detection
// ---------------------------------------------------------------------------

function detectDuplicateLocations(resources: Resource[]): Map<string, Resource[]> {
  const map = new Map<string, Resource[]>();
  for (const r of resources) {
    if (r.deployed <= 0) continue;
    const key = r.locationName.trim().toLowerCase();
    const existing = map.get(key) ?? [];
    existing.push(r);
    map.set(key, existing);
  }
  // Keep only locations with 2+ resources.
  for (const [key, list] of map.entries()) {
    if (list.length < 2) map.delete(key);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Add resource form
// ---------------------------------------------------------------------------

const addResourceSchema = z.object({
  type:         z.nativeEnum(ResourceType),
  description:  z.string().min(2).max(200),
  quantity:     z.coerce.number().int().min(1).max(10_000),
  locationName: z.string().min(2).max(200),
  assignedTo:   z.string().optional(),
});

type AddResourceValues = z.infer<typeof addResourceSchema>;

interface AddResourceFormProps {
  disasterEventId: string;
  onAdded:         () => void;
  onCancel:        () => void;
}

function AddResourceForm({ disasterEventId, onAdded, onCancel }: AddResourceFormProps) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error,      setError]      = React.useState<string | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<AddResourceValues>({
    resolver: zodResolver(addResourceSchema),
    defaultValues: { type: ResourceType.BOAT, quantity: 1, description: '', locationName: '' },
  });

  const onSubmit = async (values: AddResourceValues) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/resources', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...values, disasterEventId }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'Failed to add resource');
      }
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add resource. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="rounded-xl border border-border bg-card p-4 space-y-3"
      aria-label="Add new resource"
      noValidate
    >
      <h3 className="text-sm font-semibold text-foreground">Add Resource</h3>

      <div className="grid grid-cols-2 gap-3">
        {/* Type */}
        <div className="col-span-2 space-y-1">
          <label htmlFor="res-type" className="block text-xs font-medium text-foreground">
            Type
          </label>
          <select
            id="res-type"
            {...register('type')}
            className="w-full rounded-lg border border-border bg-background py-2 pl-3 pr-8 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {Object.values(ResourceType).map((t) => (
              <option key={t} value={t}>{RESOURCE_LABELS[t]}</option>
            ))}
          </select>
        </div>

        {/* Description */}
        <div className="col-span-2 space-y-1">
          <label htmlFor="res-desc" className="block text-xs font-medium text-foreground">
            Description
          </label>
          <input
            id="res-desc"
            type="text"
            placeholder="e.g. 15-foot motorised boat"
            {...register('description')}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {errors.description && <p className="text-[11px] text-destructive">{errors.description.message}</p>}
        </div>

        {/* Quantity */}
        <div className="space-y-1">
          <label htmlFor="res-qty" className="block text-xs font-medium text-foreground">
            Quantity
          </label>
          <input
            id="res-qty"
            type="number"
            min={1}
            {...register('quantity')}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {errors.quantity && <p className="text-[11px] text-destructive">{errors.quantity.message}</p>}
        </div>

        {/* Location */}
        <div className="space-y-1">
          <label htmlFor="res-loc" className="block text-xs font-medium text-foreground">
            Current Location
          </label>
          <input
            id="res-loc"
            type="text"
            placeholder="e.g. Aluva Camp"
            {...register('locationName')}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {errors.locationName && <p className="text-[11px] text-destructive">{errors.locationName.message}</p>}
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="text-xs text-destructive">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg border border-border bg-background py-2 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {submitting ? 'Adding…' : 'Add Resource'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// PDF Export
// ---------------------------------------------------------------------------

async function exportResourcePDF(resources: Resource[], disasterName: string): Promise<void> {
  // Dynamic import so the large @react-pdf bundle is not loaded until needed.
  const { pdf, Document, Page, Text, View, StyleSheet } = await import('@react-pdf/renderer');

  const styles = StyleSheet.create({
    page:    { padding: 32, fontFamily: 'Helvetica', fontSize: 10 },
    title:   { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
    sub:     { fontSize: 11, color: '#555', marginBottom: 20 },
    table:   { borderWidth: 1, borderColor: '#ddd' },
    row:     { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#ddd' },
    header:  { backgroundColor: '#f3f3f3' },
    cell:    { flex: 1, padding: 6 },
    bold:    { fontWeight: 'bold' },
  });

  const doc = (
    <Document title={`Resource Report — ${disasterName}`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Resource Allocation Report</Text>
        <Text style={styles.sub}>
          {disasterName} · Generated {new Date().toLocaleString('en-IN')}
        </Text>

        <View style={styles.table}>
          {/* Header */}
          <View style={[styles.row, styles.header]}>
            {['Type', 'Description', 'Total', 'Deployed', 'Available', 'Location', 'Status'].map((h) => (
              <Text key={h} style={[styles.cell, styles.bold]}>{h}</Text>
            ))}
          </View>
          {/* Rows */}
          {resources.map((r) => {
            const avail = r.quantity - r.deployed;
            return (
              <View key={r.id} style={styles.row}>
                <Text style={styles.cell}>{r.type.replace(/_/g, ' ')}</Text>
                <Text style={styles.cell}>{r.description}</Text>
                <Text style={styles.cell}>{r.quantity}</Text>
                <Text style={styles.cell}>{r.deployed}</Text>
                <Text style={styles.cell}>{avail}</Text>
                <Text style={styles.cell}>{r.locationName}</Text>
                <Text style={styles.cell}>{r.status}</Text>
              </View>
            );
          })}
        </View>
      </Page>
    </Document>
  );

  const blob = await pdf(doc).toBlob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `resource-report-${Date.now()}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ResourceTrackerProps {
  disasterEventId: string;
  disasterName?:   string;
}

function ResourceActionButton({ label, color, onClick }: {
  label: string;
  color: 'primary' | 'secondary' | 'destructive';
  onClick: () => void;
}) {
  const cls = {
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'border border-border bg-background text-foreground hover:bg-accent',
    destructive: 'bg-destructive/10 text-destructive hover:bg-destructive/20',
  }[color];
  return (
    <button onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${cls}`}>
      {label}
    </button>
  );
}

export function ResourceTracker({
  disasterEventId,
  disasterName = 'Active Disaster',
}: ResourceTrackerProps) {
  const [resources,    setResources]    = React.useState<Resource[]>([]);
  const [isLoading,    setIsLoading]    = React.useState(true);
  const [showAddForm,  setShowAddForm]  = React.useState(false);
  const [expandedId,   setExpandedId]   = React.useState<string | null>(null);
  const [exporting,    setExporting]    = React.useState(false);
  const [error,        setError]        = React.useState<string | null>(null);

  const handleResourceAction = async (resourceId: string, action: 'deploy' | 'return' | 'delete') => {
    if (action === 'delete') {
      const res = await fetch(`/api/resources/${resourceId}`, { method: 'DELETE' });
      if (!res.ok) console.error('Failed to delete resource');
      return;
    }
    const delta = action === 'deploy' ? 1 : -1;
    const resource = resources.find(r => r.id === resourceId);
    if (!resource) return;
    await fetch(`/api/resources/${resourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deployed: Math.max(0, Math.min(resource.quantity, resource.deployed + delta)) }),
    });
  };

  // Subscribe to Firestore /resources.
  React.useEffect(() => {
    let unsub: (() => void) | undefined;

    void (async () => {
      try {
        const { subscribeToDocuments, COLLECTIONS: COL } = await import('@/lib/firebase/firestore');
        const { where } = await import('firebase/firestore');

        unsub = subscribeToDocuments<Resource>(
          COL.RESOURCES,
          (docs) => {
            setResources([...docs].sort((a, b) => (a.type ?? '').localeCompare(b.type ?? '')));
            setIsLoading(false);
          },
          undefined,
          where('disasterEventId', '==', disasterEventId),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load resources');
        setIsLoading(false);
      }
    })();

    return () => unsub?.();
  }, [disasterEventId]);

  const summaries = React.useMemo(
    () => resources.map(computeSummary),
    [resources],
  );

  const duplicates = React.useMemo(
    () => detectDuplicateLocations(resources),
    [resources],
  );

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportResourcePDF(resources, disasterName);
    } catch {
      // Non-fatal — user sees no action instead of a crash.
    } finally {
      setExporting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4" aria-label="Resource tracker">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Resources</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || resources.length === 0}
            aria-label="Download resource allocation PDF"
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {exporting
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              : <Download className="h-3.5 w-3.5"             aria-hidden="true" />}
            Export PDF
          </button>
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            aria-label="Add new resource"
            className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add
          </button>
        </div>
      </div>

      {/* Duplication warning */}
      {duplicates.size > 0 && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">Duplication risk</p>
            <p className="text-xs">
              Multiple resources deployed to the same location:{' '}
              {[...duplicates.keys()].join(', ')}.
            </p>
          </div>
        </div>
      )}

      {/* Add resource form */}
      {showAddForm && (
        <AddResourceForm
          disasterEventId={disasterEventId}
          onAdded={() => { setShowAddForm(false); }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Inventory table */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-lg skeleton-shimmer" />
          ))}
        </div>
      ) : error !== null ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : resources.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          No resources registered yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-xs" role="table" aria-label="Resource inventory">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                {['Type', 'Total', 'Deployed', 'Available', 'Status'].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
                <th scope="col" className="w-8" />
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <React.Fragment key={s.resource.id}>
                  <tr
                    className="cursor-pointer border-b border-border transition-colors hover:bg-accent last:border-b-0"
                    onClick={() => setExpandedId((id) => id === s.resource.id ? null : s.resource.id)}
                    aria-expanded={expandedId === s.resource.id}
                  >
                    {/* Type */}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        {RESOURCE_ICONS[s.resource.type]}
                        <span className="font-medium text-foreground">
                          {RESOURCE_LABELS[s.resource.type]}
                        </span>
                      </div>
                    </td>

                    {/* Total */}
                    <td className="px-3 py-2 tabular-nums text-foreground">
                      {s.resource.quantity}
                    </td>

                    {/* Deployed */}
                    <td className="px-3 py-2 tabular-nums text-foreground">
                      {s.resource.deployed}
                    </td>

                    {/* Available */}
                    <td className={`px-3 py-2 tabular-nums font-semibold ${availabilityColor(s)}`}>
                      {s.available}
                    </td>

                    {/* Status badge */}
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${availabilityColor(s)} bg-current/10`}>
                        {availabilityLabel(s)}
                      </span>
                    </td>

                    {/* Expand toggle */}
                    <td className="px-2 py-2 text-muted-foreground">
                      {expandedId === s.resource.id
                        ? <ChevronUp   className="h-3.5 w-3.5" aria-hidden="true" />
                        : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expandedId === s.resource.id && (
                    <tr className="bg-secondary/30">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-muted-foreground">
                            <span>
                              <span className="font-medium text-foreground">Location: </span>
                              {s.resource.locationName}
                            </span>
                            <span>
                              <span className="font-medium text-foreground">Condition: </span>
                              {s.resource.condition}
                            </span>
                            <span className="col-span-2">
                              <span className="font-medium text-foreground">Description: </span>
                              {s.resource.description}
                            </span>
                            <div className="col-span-2 mt-1">
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                                <div
                                  className={`h-full rounded-full ${
                                    s.isDepleted || s.isLow ? 'bg-red-500' :
                                    s.deploymentRate > 70   ? 'bg-amber-500' : 'bg-green-500'
                                  }`}
                                  style={{ width: `${s.deploymentRate}%` }}
                                  role="progressbar"
                                  aria-valuenow={Math.round(s.deploymentRate)}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-label={`${Math.round(s.deploymentRate)}% deployed`}
                                />
                              </div>
                              <p className="mt-0.5 text-[10px]">{Math.round(s.deploymentRate)}% deployed</p>
                            </div>
                          </div>
                          {/* Action buttons */}
                          <div className="flex gap-2 flex-wrap">
                            {s.available > 0 && (
                              <ResourceActionButton
                                label="Deploy 1"
                                color="primary"
                                onClick={() => void handleResourceAction(s.resource.id, 'deploy')}
                              />
                            )}
                            {s.resource.deployed > 0 && (
                              <ResourceActionButton
                                label="Return 1"
                                color="secondary"
                                onClick={() => void handleResourceAction(s.resource.id, 'return')}
                              />
                            )}
                            <ResourceActionButton
                              label="Delete"
                              color="destructive"
                              onClick={() => void handleResourceAction(s.resource.id, 'delete')}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Allocation history (last 10 actions) */}
      <AllocationHistory disasterEventId={disasterEventId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Allocation history sub-component
// ---------------------------------------------------------------------------

interface AllocationEvent {
  id:          string;
  resourceId:  string;
  resourceType: string;
  quantity:    number;
  status:      string;
  locationName: string;
  allocatedAt: { seconds: number } | null;
}

function AllocationHistory({ disasterEventId }: { disasterEventId: string }) {
  const [events,    setEvents]    = React.useState<AllocationEvent[]>([]);
  const [loading,   setLoading]   = React.useState(true);
  const [collapsed, setCollapsed] = React.useState(true);

  React.useEffect(() => {
    void (async () => {
      try {
        // Client-side: query public Firestore directly.
        const { getDocuments } = await import('@/lib/firebase/firestore');
        const { where, limit } = await import('firebase/firestore');

        const docs = await getDocuments<AllocationEvent>(
          COLLECTIONS.RESOURCES,
          undefined,
          where('disasterEventId', '==', disasterEventId),
          limit(10),
        );
        setEvents(docs);
      } catch {
        // Non-fatal
      } finally {
        setLoading(false);
      }
    })();
  }, [disasterEventId]);

  if (loading) return null;
  if (events.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
        aria-expanded={!collapsed}
      >
        Recent Allocation Activity
        {collapsed
          ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          : <ChevronUp   className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>

      {!collapsed && (
        <ul className="mt-2 space-y-1.5" aria-label="Allocation history">
          {events.slice(0, 10).map((e) => {
            const ts = e.allocatedAt
              ? new Date(e.allocatedAt.seconds * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
              : '';
            return (
              <li
                key={e.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs"
              >
                <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {ts}
                </span>
                <span className="flex-1 text-foreground">
                  {e.resourceType?.replace(/_/g, ' ')} ×{e.quantity} → {e.locationName}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{e.status}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
