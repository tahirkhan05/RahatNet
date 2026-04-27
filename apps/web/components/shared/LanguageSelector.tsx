'use client';

/**
 * LanguageSelector — shared UI component for language preference.
 *
 * Used in:
 *  - Login page header (before auth — persists to localStorage)
 *  - Profile settings (after auth — also writes to Firestore user profile)
 *  - Any page header where the user might want to switch language
 *
 * Persistence:
 *  1. localStorage key 'rahatnet-lang' — survives page reloads without auth.
 *  2. Firestore /users/{uid}.language — survives device changes after login.
 *     The Firestore write is best-effort; failure silently falls back to localStorage.
 *
 * Design:
 *  - Uses the shadcn Select primitive for consistent styling and accessibility.
 *  - Shows the country flag emoji + native-script language name in the trigger.
 *  - All items have an English label in the description for screen readers that
 *    may not support native scripts.
 *  - The trigger is compact (fits inline in headers) but tappable on mobile.
 *
 * Accessibility:
 *  - aria-label on the trigger ("Select language").
 *  - Each option has a descriptive aria-label combining native + English names.
 *  - Focus ring follows the system design token --ring.
 */

import * as React from 'react';
import { Globe } from 'lucide-react';
import { Language } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Language metadata
// ---------------------------------------------------------------------------

interface LanguageMeta {
  readonly code:       Language;
  readonly name:       string;       // English name
  readonly nativeName: string;       // Name in native script
  readonly flag:       string;       // Country flag emoji
}

const LANGUAGES: readonly LanguageMeta[] = [
  { code: Language.HINDI,     name: 'Hindi',     nativeName: 'हिंदी',     flag: '🇮🇳' },
  { code: Language.TELUGU,    name: 'Telugu',    nativeName: 'తెలుగు',    flag: '🇮🇳' },
  { code: Language.TAMIL,     name: 'Tamil',     nativeName: 'தமிழ்',     flag: '🇮🇳' },
  { code: Language.KANNADA,   name: 'Kannada',   nativeName: 'ಕನ್ನಡ',    flag: '🇮🇳' },
  { code: Language.BENGALI,   name: 'Bengali',   nativeName: 'বাংলা',     flag: '🇮🇳' },
  { code: Language.MARATHI,   name: 'Marathi',   nativeName: 'मराठी',     flag: '🇮🇳' },
  { code: Language.GUJARATI,  name: 'Gujarati',  nativeName: 'ગુજરાતી',  flag: '🇮🇳' },
  { code: Language.MALAYALAM, name: 'Malayalam', nativeName: 'മലയാളം',   flag: '🇮🇳' },
  { code: Language.ENGLISH,   name: 'English',   nativeName: 'English',   flag: '🌐' },
] as const;

const LANG_STORAGE_KEY = 'rahatnet-lang';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStoredLanguage(): Language {
  if (typeof window === 'undefined') return Language.ENGLISH;
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  const valid  = Object.values(Language) as string[];
  if (stored !== null && valid.includes(stored)) return stored as Language;
  return Language.ENGLISH;
}

function writeStoredLanguage(lang: Language): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  }
}

// ---------------------------------------------------------------------------
// Hook: useLanguage
// ---------------------------------------------------------------------------

export interface UseLanguageReturn {
  language:  Language;
  setLanguage: (lang: Language) => void;
}

/**
 * Shared hook that reads/writes the active UI language.
 * Synchronises across localStorage and (when authenticated) Firestore.
 *
 * Safe to use in any client component — returns Language.ENGLISH during SSR.
 */
export function useLanguage(): UseLanguageReturn {
  const [language, setLanguageState] = React.useState<Language>(Language.ENGLISH);

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  React.useEffect(() => {
    setLanguageState(readStoredLanguage());
  }, []);

  const setLanguage = React.useCallback((lang: Language) => {
    setLanguageState(lang);
    writeStoredLanguage(lang);

    // Best-effort write to Firestore if the user is authenticated.
    void (async () => {
      try {
        const { getCurrentUser } = await import('@/lib/firebase/auth');
        const user = getCurrentUser();
        if (user === null) return;

        const { updateDocument, COLLECTIONS } = await import('@/lib/firebase/firestore');
        await updateDocument(COLLECTIONS.USERS, user.uid, { language: lang });
      } catch {
        // Non-fatal — localStorage is the source of truth for UI language.
      }
    })();
  }, []);

  return { language, setLanguage };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LanguageSelectorProps {
  /**
   * Controlled value.  When provided, the component is controlled and
   * `onChange` must be supplied.  When absent, the component manages its
   * own state via `useLanguage`.
   */
  value?:    Language;
  onChange?: (lang: Language) => void;
  /**
   * Visual variant:
   *   'compact'  — flag + native name only (for headers, tight spaces)
   *   'full'     — flag + native name + English name (for settings pages)
   */
  variant?: 'compact' | 'full';
  /** Extra CSS classes for the trigger button. */
  className?: string;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LanguageSelector({
  value,
  onChange,
  variant   = 'compact',
  className = '',
  disabled  = false,
}: LanguageSelectorProps) {
  const { language: hookLang, setLanguage: hookSet } = useLanguage();

  const isControlled  = value !== undefined;
  const currentLang   = isControlled ? value : hookLang;
  const currentMeta   = LANGUAGES.find((l) => l.code === currentLang) ?? LANGUAGES[LANGUAGES.length - 1]!;

  const [open, setOpen] = React.useState(false);
  const dropdownRef     = React.useRef<HTMLDivElement>(null);

  const handleSelect = React.useCallback((lang: Language) => {
    if (!isControlled) hookSet(lang);
    onChange?.(lang);
    setOpen(false);
  }, [isControlled, hookSet, onChange]);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <div ref={dropdownRef} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Select language — currently ${currentMeta.name}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={[
          'inline-flex items-center gap-1.5 rounded-lg border border-border bg-background',
          'px-2.5 py-1.5 text-sm text-foreground',
          'transition-colors hover:bg-accent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'min-h-[36px]',
        ].join(' ')}
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span aria-hidden="true">{currentMeta.nativeName}</span>
        {variant === 'full' && (
          <span className="text-xs text-muted-foreground" aria-hidden="true">
            ({currentMeta.name})
          </span>
        )}
        {/* Chevron */}
        <svg
          className="h-3 w-3 shrink-0 text-muted-foreground"
          aria-hidden="true"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2 4l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <ul
          role="listbox"
          aria-label="Available languages"
          className={[
            'absolute z-50 mt-1 min-w-[11rem] overflow-y-auto',
            'rounded-xl border border-border bg-card shadow-lg',
            // Position: prefer right-aligned so it doesn't clip off the right edge.
            'right-0 top-full',
            // Max height so it doesn't go off screen on short viewports.
            'max-h-72',
          ].join(' ')}
        >
          {LANGUAGES.map((lang) => {
            const isSelected = lang.code === currentLang;

            return (
              <li
                key={lang.code}
                role="option"
                aria-selected={isSelected}
                aria-label={`${lang.nativeName} (${lang.name})`}
              >
                <button
                  type="button"
                  onClick={() => handleSelect(lang.code)}
                  className={[
                    'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm',
                    'transition-colors',
                    'focus-visible:outline-none focus-visible:bg-accent',
                    isSelected
                      ? 'bg-primary/5 font-medium text-primary'
                      : 'text-foreground hover:bg-accent',
                  ].join(' ')}
                >
                  {/* Native name (primary) */}
                  <span className="flex-1">{lang.nativeName}</span>

                  {/* English label (secondary, always shown for accessibility) */}
                  <span
                    className={[
                      'text-xs shrink-0',
                      isSelected ? 'text-primary/70' : 'text-muted-foreground',
                    ].join(' ')}
                  >
                    {lang.name}
                  </span>

                  {/* Checkmark for selected */}
                  {isSelected && (
                    <svg
                      className="h-3.5 w-3.5 shrink-0 text-primary"
                      aria-hidden="true"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M2 7l4 4 6-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
