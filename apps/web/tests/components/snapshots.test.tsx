/**
 * Snapshot tests for major UI components.
 *
 * Snapshots capture the rendered HTML tree and detect unintended visual
 * regressions.  They are committed to the repository alongside the source
 * and must be updated intentionally with `vitest --update-snapshots`.
 *
 * Components covered:
 *   - TaskCard (citizen + volunteer context, multiple severities)
 *   - NeedQueueItem (coordinator war room)
 *   - ImpactMetrics (coordinator right panel)
 *   - OfflineBanner (all three states: offline, slow, pending)
 *   - DisasterAlert (IMD RED + critical spike)
 *
 * Each snapshot test also runs axe-core accessibility checks so regressions
 * in accessible markup surface at the same time as visual regressions.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { NeedType, NeedSeverity, NeedStatus } from '@rahatnet/types';

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter:  vi.fn().mockReturnValue({ push: vi.fn(), replace: vi.fn() }),
  usePathname: vi.fn().mockReturnValue('/'),
}));

vi.mock('@/hooks/useOffline', () => ({
  useOffline: vi.fn().mockReturnValue({ isOnline: true, isSlowConnection: false, pendingCount: 0 }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { TaskCard }       from '@/components/volunteer/TaskCard';
import { NeedQueueItem }  from '@/components/coordinator/NeedQueueItem';
import { ImpactMetrics }  from '@/components/coordinator/ImpactMetrics';
import { OfflineBanner }  from '@/components/shared/OfflineBanner';
import { DisasterAlert }  from '@/components/coordinator/DisasterAlert';
import {
  createMockNeed,
  type WarRoomStats,
} from '@/tests/mocks/factories';

// Re-export for snapshot helpers.
type WarRoomStatsType = {
  total: number; critical: number; urgent: number; resolved: number; activeVolunteers: number;
};

const defaultStats: WarRoomStatsType = {
  total: 42, critical: 8, urgent: 15, resolved: 12, activeVolunteers: 7,
};

// ---------------------------------------------------------------------------
// TaskCard snapshots
// ---------------------------------------------------------------------------

describe('TaskCard snapshots', () => {
  const criticalNeed = createMockNeed({
    severity: NeedSeverity.CRITICAL,
    type:     NeedType.RESCUE,
    title:    'Rescue needed at Aluva Bridge — 5 people',
  });

  const urgentFoodNeed = createMockNeed({
    severity:     NeedSeverity.URGENT,
    type:         NeedType.FOOD,
    title:        'Food needed at Ernakulam Camp',
    hasVulnerable: false,
  });

  const resolvedNeed = createMockNeed({
    severity: NeedSeverity.NORMAL,
    status:   NeedStatus.RESOLVED,
    title:    'Shelter provided at Wayanad',
    type:     NeedType.SHELTER,
  });

  it('renders a CRITICAL rescue task (active context) — matches snapshot', () => {
    const { container } = render(
      <TaskCard
        need={criticalNeed}
        context="active"
        distanceM={1200}
        onNavigate={vi.fn()}
        onComplete={vi.fn()}
        onIssue={vi.fn()}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders a URGENT food need (nearby context) — matches snapshot', () => {
    const { container } = render(
      <TaskCard
        need={urgentFoodNeed}
        context="nearby"
        distanceM={3500}
        onInterest={vi.fn()}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders a resolved task (past context) — matches snapshot', () => {
    const { container } = render(
      <TaskCard need={resolvedNeed} context="past" />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('TaskCard (active) has no accessibility violations', async () => {
    const { container } = render(
      <TaskCard
        need={criticalNeed}
        context="active"
        onNavigate={vi.fn()}
        onComplete={vi.fn()}
        onIssue={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('TaskCard (nearby) has no accessibility violations', async () => {
    const { container } = render(
      <TaskCard
        need={urgentFoodNeed}
        context="nearby"
        onInterest={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// NeedQueueItem snapshots
// ---------------------------------------------------------------------------

describe('NeedQueueItem snapshots', () => {
  const need = createMockNeed({
    severity: NeedSeverity.CRITICAL,
    status:   NeedStatus.VERIFIED,
  });

  it('renders unselected queue item — matches snapshot', () => {
    const { container } = render(
      <NeedQueueItem
        need={need}
        isSelected={false}
        onSelect={vi.fn()}
        onAssign={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders selected queue item — matches snapshot', () => {
    const { container } = render(
      <NeedQueueItem
        need={need}
        isSelected={true}
        onSelect={vi.fn()}
        onAssign={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('NeedQueueItem has no accessibility violations', async () => {
    const { container } = render(
      <NeedQueueItem
        need={need}
        isSelected={false}
        onSelect={vi.fn()}
        onAssign={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// ImpactMetrics snapshots
// ---------------------------------------------------------------------------

describe('ImpactMetrics snapshots', () => {
  it('renders with all stats populated — matches snapshot', () => {
    const { container } = render(
      <ImpactMetrics stats={defaultStats as unknown as import('@/hooks/useWarRoom').WarRoomStats} isLoading={false} />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders loading skeleton — matches snapshot', () => {
    const { container } = render(
      <ImpactMetrics stats={defaultStats as unknown as import('@/hooks/useWarRoom').WarRoomStats} isLoading={true} />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders zero stats (no needs yet) — matches snapshot', () => {
    const emptyStats = { total: 0, critical: 0, urgent: 0, resolved: 0, activeVolunteers: 0 };
    const { container } = render(
      <ImpactMetrics stats={emptyStats as unknown as import('@/hooks/useWarRoom').WarRoomStats} isLoading={false} />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('ImpactMetrics has no accessibility violations', async () => {
    const { container } = render(
      <ImpactMetrics stats={defaultStats as unknown as import('@/hooks/useWarRoom').WarRoomStats} isLoading={false} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// OfflineBanner snapshots
// ---------------------------------------------------------------------------

describe('OfflineBanner snapshots', () => {
  it('renders nothing when online and no pending reports', () => {
    const { useOffline } = require('@/hooks/useOffline');
    vi.mocked(useOffline).mockReturnValue({ isOnline: true, isSlowConnection: false, pendingCount: 0 });

    const { container } = render(<OfflineBanner />);
    // The banner renders null when everything is fine.
    expect(container).toMatchSnapshot();
  });

  it('renders the OFFLINE banner — matches snapshot', () => {
    // forceOffline prop bypasses the hook so we don't need to mock it.
    const { container } = render(<OfflineBanner forceOffline={true} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders the SLOW CONNECTION banner — matches snapshot', () => {
    const { useOffline } = require('@/hooks/useOffline');
    vi.mocked(useOffline).mockReturnValue({ isOnline: true, isSlowConnection: true, pendingCount: 0 });

    const { container } = render(<OfflineBanner />);
    expect(container).toMatchSnapshot();
  });

  it('renders the PENDING count banner — matches snapshot', () => {
    const { useOffline } = require('@/hooks/useOffline');
    vi.mocked(useOffline).mockReturnValue({ isOnline: true, isSlowConnection: false, pendingCount: 3 });

    const { container } = render(<OfflineBanner />);
    expect(container).toMatchSnapshot();
  });

  it('offline banner has no accessibility violations', async () => {
    const { container } = render(<OfflineBanner forceOffline={true} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// DisasterAlert snapshots
// ---------------------------------------------------------------------------

describe('DisasterAlert snapshots', () => {
  const needs = Array.from({ length: 12 }, () =>
    createMockNeed({
      severity:  NeedSeverity.CRITICAL,
      createdAt: { seconds: Math.floor((Date.now() - 60_000) / 1_000), nanoseconds: 0 } as never,
    }),
  );

  it('renders the critical-spike alert (>10 critical in 5 min) — matches snapshot', () => {
    const { container } = render(
      <DisasterAlert
        needs={needs}
        disasterAlerts={{}}
        disasterName="Kerala Flood 2024"
      />,
    );
    expect(container).toMatchSnapshot();
  });

  it('renders nothing when no alert condition is met', () => {
    const { container } = render(
      <DisasterAlert
        needs={[createMockNeed({ severity: NeedSeverity.NORMAL })]}
        disasterAlerts={{}}
        disasterName="Test Disaster"
      />,
    );
    // No banner when conditions are not met.
    expect(container.firstChild).toBeNull();
  });

  it('renders IMD RED alert — matches snapshot', () => {
    const { container } = render(
      <DisasterAlert
        needs={[]}
        disasterAlerts={{
          'alert-001': {
            name:      'Kerala Flood',
            type:      'FLOOD',
            severity:  'CATASTROPHIC',
            districts: ['Ernakulam'],
            issuedAt:  Date.now(),
          },
        }}
        disasterName="Kerala Flood 2024"
      />,
    );
    expect(container).toMatchSnapshot();
  });
});
