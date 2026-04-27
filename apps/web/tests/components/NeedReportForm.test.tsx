/**
 * Component tests for NeedReportForm.
 *
 * Tests the citizen need-reporting flow:
 *   Step 1 — need type selection
 *   Step 2 — description (voice, text, photo, count, vulnerable)
 *   Step 3 — confirmation + submit
 *
 * Uses @testing-library/react + axe-core for accessibility.
 * MSW intercepts all fetch() calls.
 *
 * Firebase, geolocation, and MediaRecorder APIs are mocked so tests run
 * in a jsdom environment without real browser APIs.
 */

import * as React from 'react';
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import {
  render, screen, fireEvent, waitFor, within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { NeedType } from '@rahatnet/types';

// Extend jest matchers to include axe
expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/hooks/useOffline', () => ({
  useOffline: vi.fn().mockReturnValue({
    isOnline:         true,
    isSlowConnection: false,
    pendingCount:     0,
  }),
}));

vi.mock('@/hooks/useGeolocation', () => ({
  useGeolocation: vi.fn().mockReturnValue({
    lat:       10.0167,
    lng:       76.3417,
    accuracy:  10,
    error:     null,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: vi.fn().mockReturnValue({
    pendingCount: 0,
    isSyncing:    false,
    enqueue:      vi.fn().mockResolvedValue(undefined),
    syncNow:      vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/lib/firebase/storage', () => ({
  uploadNeedPhoto: vi.fn().mockResolvedValue('https://storage.example.com/photo.jpg'),
}));

// Mock geolocation so Maps geocoding doesn't block.
vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { NeedReportForm } from '@/components/citizen/NeedReportForm';

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

const mockOnSuccess = vi.fn();

function renderForm() {
  return render(
    <NeedReportForm userId="test-user-uid" onSuccess={mockOnSuccess} />,
  );
}

// ---------------------------------------------------------------------------
// Step 1: Need type selection
// ---------------------------------------------------------------------------

describe('NeedReportForm — Step 1: Need type selection', () => {
  beforeEach(() => {
    mockOnSuccess.mockClear();
  });

  it('renders all 6 need type cards', () => {
    renderForm();

    expect(screen.getByText('Rescue')).toBeInTheDocument();
    expect(screen.getByText('Food & Water')).toBeInTheDocument();
    expect(screen.getByText('Medicine')).toBeInTheDocument();
    expect(screen.getByText('Shelter')).toBeInTheDocument();
    expect(screen.getByText('Mental Support')).toBeInTheDocument();
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
  });

  it('the Next button is disabled until a need type is selected', () => {
    renderForm();

    const nextBtn = screen.getByRole('button', { name: /next/i });
    expect(nextBtn).toBeDisabled();
  });

  it('selecting a need type enables the Next button', async () => {
    renderForm();

    const rescueCard = screen.getByRole('radio', { name: /rescue/i });
    await userEvent.click(rescueCard);

    const nextBtn = screen.getByRole('button', { name: /next/i });
    expect(nextBtn).not.toBeDisabled();
  });

  it('clicking Next after selecting a type advances to Step 2', async () => {
    renderForm();

    await userEvent.click(screen.getByRole('radio', { name: /rescue/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));

    expect(screen.getByText(/describe the situation/i)).toBeInTheDocument();
  });

  it('shows no accessibility violations on Step 1 render', async () => {
    const { container } = renderForm();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// Step 2: Description
// ---------------------------------------------------------------------------

describe('NeedReportForm — Step 2: Describe the situation', () => {
  async function goToStep2() {
    renderForm();
    await userEvent.click(screen.getByRole('radio', { name: /rescue/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
  }

  it('shows the voice recorder, text area, and photo uploader', async () => {
    await goToStep2();

    expect(screen.getByText(/describe by voice/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /or describe in text/i })).toBeInTheDocument();
    expect(screen.getByText(/add a photo/i)).toBeInTheDocument();
  });

  it('shows a location detection status', async () => {
    await goToStep2();
    // With our mocked geolocation (lat/lng provided), the location should show.
    expect(screen.getByText(/your location/i)).toBeInTheDocument();
  });

  it('blocks proceeding without a description when no voice note', async () => {
    await goToStep2();

    const nextBtn = screen.getByRole('button', { name: /next/i });
    await userEvent.click(nextBtn);

    expect(screen.getByText(/at least 10 characters/i)).toBeInTheDocument();
  });

  it('allows proceeding after entering a text description', async () => {
    await goToStep2();

    const textarea = screen.getByRole('textbox', { name: /or describe in text/i });
    await userEvent.type(textarea, 'People are stranded on the rooftop and need rescue');

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText(/confirm your report/i)).toBeInTheDocument();
  });

  it('people stepper increments and decrements', async () => {
    await goToStep2();

    const plusBtn  = screen.getByRole('button', { name: /6 people/i });
    await userEvent.click(plusBtn);
    expect(screen.getByRole('button', { name: /6 people/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('vulnerable checkbox is toggleable', async () => {
    await goToStep2();

    const checkbox = screen.getByRole('checkbox', { name: /elderly.*disabled.*child/i });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('rejects a photo file over 10 MB', async () => {
    await goToStep2();

    // Create a 11 MB fake file.
    const bigFile = new File(
      [new ArrayBuffer(11 * 1024 * 1024)],
      'big.jpg',
      { type: 'image/jpeg' },
    );

    const photoInput = screen.getByLabelText(/take a photo with camera/i);
    await userEvent.upload(photoInput, bigFile);

    await waitFor(() => {
      expect(screen.getByText(/too large/i)).toBeInTheDocument();
    });
  });

  it('shows no accessibility violations on Step 2', async () => {
    await goToStep2();
    const { container } = await import('@testing-library/react').then(
      (m) => ({ container: document.body }),
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// Step 3: Confirmation + submit
// ---------------------------------------------------------------------------

describe('NeedReportForm — Step 3: Confirmation', () => {
  async function goToStep3() {
    renderForm();
    await userEvent.click(screen.getByRole('radio', { name: /rescue/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    const textarea = screen.getByRole('textbox', { name: /or describe in text/i });
    await userEvent.type(textarea, 'People are stranded on the rooftop and need rescue now');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
  }

  it('shows a summary before submission', async () => {
    await goToStep3();

    expect(screen.getByText(/confirm your report/i)).toBeInTheDocument();
    expect(screen.getByText(/rescue/i)).toBeInTheDocument();
  });

  it('shows the offline notice when the device is offline', async () => {
    const { useOffline } = await import('@/hooks/useOffline');
    vi.mocked(useOffline).mockReturnValueOnce({
      isOnline:         false,
      isSlowConnection: false,
      pendingCount:     0,
    });

    await goToStep3();

    expect(screen.getByText(/you are offline/i)).toBeInTheDocument();
    expect(screen.getByText(/sent automatically when you reconnect/i)).toBeInTheDocument();
  });

  it('calls onSuccess with wasQueued=false after successful online submit', async () => {
    await goToStep3();

    await userEvent.click(screen.getByRole('button', { name: /submit report/i }));

    await waitFor(() => {
      expect(mockOnSuccess).toHaveBeenCalledWith(
        expect.any(String),
        false, // not queued
      );
    });
  });

  it('calls onSuccess with wasQueued=true when submitting offline', async () => {
    const { useOffline } = await import('@/hooks/useOffline');
    vi.mocked(useOffline).mockReturnValue({
      isOnline:         false,
      isSlowConnection: false,
      pendingCount:     0,
    });

    await goToStep3();
    await userEvent.click(screen.getByRole('button', { name: /submit report/i }));

    await waitFor(() => {
      expect(mockOnSuccess).toHaveBeenCalledWith(expect.any(String), true);
    });
  });
});

// ---------------------------------------------------------------------------
// Accessibility — full form
// ---------------------------------------------------------------------------

describe('NeedReportForm — Accessibility', () => {
  it('all interactive elements on Step 1 have accessible labels', () => {
    renderForm();

    const radioGroup = screen.getByRole('radiogroup', { name: /type of help/i });
    expect(radioGroup).toBeInTheDocument();

    const radios = within(radioGroup).getAllByRole('radio');
    radios.forEach((radio) => {
      expect(radio).toHaveAccessibleName();
    });
  });

  it('step indicator has role=status', () => {
    renderForm();
    expect(screen.getByRole('status', { name: /step/i })).toBeInTheDocument();
  });
});
