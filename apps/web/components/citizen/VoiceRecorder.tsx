'use client';

/**
 * VoiceRecorder — primary input method for need descriptions.
 *
 * Priority over text input because:
 *  - Panicking users in a flood can speak faster than type.
 *  - Works for illiterate users and non-English speakers.
 *  - Captures emotional urgency that text loses.
 *
 * Features:
 *  - Requests microphone permission with a graceful explanation first.
 *  - Animated waveform (AnalyserNode-driven bar chart) during recording.
 *  - 60-second hard limit with visible countdown.
 *  - Playback before committing — user can re-record.
 *  - Converts the recorded Blob to a base64 data URL for API submission.
 *  - Falls back gracefully if MediaRecorder API is unavailable.
 *
 * Supported formats: audio/webm (Chrome/Android), audio/ogg (Firefox),
 * audio/mp4 (Safari) — whichever the browser supports first.
 */

import * as React from 'react';
import { Mic, MicOff, Square, Play, Pause, RefreshCw, Loader2 } from 'lucide-react';
import { t } from '@/lib/i18n/t';

const MAX_RECORDING_SECS = 60;
const WAVEFORM_BARS = 24;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RecorderState =
  | 'idle'          // hasn't started yet
  | 'requesting'    // asking for mic permission
  | 'denied'        // mic permission denied
  | 'recording'     // actively recording
  | 'paused_done'   // finished recording, ready to play or re-record
  | 'playing';      // playing back the recording

interface VoiceRecorderProps {
  /** Called when the user commits a recording. Receives a base64 data URL. */
  onRecorded: (base64: string | null) => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPreferredMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Waveform display
// ---------------------------------------------------------------------------

function Waveform({
  analyser,
  isRecording,
}: {
  analyser: AnalyserNode | null;
  isRecording: boolean;
}) {
  const [bars, setBars] = React.useState<number[]>(Array(WAVEFORM_BARS).fill(0));
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!isRecording || analyser === null) {
      setBars(Array(WAVEFORM_BARS).fill(2));
      return;
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      analyser.getByteFrequencyData(dataArray);
      const step = Math.floor(dataArray.length / WAVEFORM_BARS);
      const newBars = Array.from({ length: WAVEFORM_BARS }, (_, i) => {
        const val = dataArray[i * step] ?? 0;
        return Math.max(2, Math.round((val / 255) * 40));
      });
      setBars(newBars);
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [isRecording, analyser]);

  return (
    <div
      aria-hidden="true"
      className="flex h-12 items-center justify-center gap-0.5"
    >
      {bars.map((h, i) => (
        <div
          key={i}
          className={[
            'w-1.5 rounded-full transition-all duration-75',
            isRecording ? 'bg-primary' : 'bg-muted-foreground/40',
          ].join(' ')}
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function VoiceRecorder({ onRecorded, disabled = false }: VoiceRecorderProps) {
  const [state, setState] = React.useState<RecorderState>('idle');
  const [secondsLeft, setSecondsLeft] = React.useState(MAX_RECORDING_SECS);
  const [recordedBase64, setRecordedBase64] = React.useState<string | null>(null);
  const [isUnsupported, setIsUnsupported] = React.useState(false);

  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Check API availability on mount.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setIsUnsupported(true);
    }
  }, []);

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      stopStream();
      if (timerRef.current != null) clearInterval(timerRef.current);
    };
  }, []);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analyserRef.current = null;
  };

  const startRecording = async () => {
    if (disabled || isUnsupported) return;
    setState('requesting');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState('denied');
      return;
    }

    streamRef.current = stream;

    // Set up AnalyserNode for the waveform visualisation.
    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;

    const mimeType = getPreferredMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      stopStream();
      const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
      const base64 = await blobToBase64(blob);
      setRecordedBase64(base64);
      onRecorded(base64);
      setState('paused_done');
    };

    recorder.start(250); // collect data every 250 ms
    setState('recording');
    setSecondsLeft(MAX_RECORDING_SECS);

    // Countdown timer.
    timerRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          stopRecording();
          return 0;
        }
        return prev - 1;
      });
    }, 1_000);
  };

  const stopRecording = () => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current?.state !== 'inactive') {
      mediaRecorderRef.current?.stop();
    }
  };

  const handleReRecord = () => {
    setRecordedBase64(null);
    onRecorded(null);
    setState('idle');
    setSecondsLeft(MAX_RECORDING_SECS);
    if (audioRef.current != null) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  const handlePlayback = () => {
    if (recordedBase64 === null) return;
    if (audioRef.current === null) {
      const audio = new Audio(recordedBase64);
      audioRef.current = audio;
      audio.onended = () => setState('paused_done');
    }
    if (state === 'playing') {
      audioRef.current.pause();
      setState('paused_done');
    } else {
      void audioRef.current.play();
      setState('playing');
    }
  };

  // ---- Render branches ----

  if (isUnsupported) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-3 text-sm text-muted-foreground">
        <MicOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('report.step2.voice.no_permission')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Waveform + timer */}
      <div
        className={[
          'flex flex-col items-center gap-2 rounded-xl border px-4 py-3 transition-colors',
          state === 'recording' ? 'border-primary bg-primary/5' : 'border-border bg-secondary/50',
        ].join(' ')}
        aria-live="polite"
      >
        <Waveform
          analyser={analyserRef.current}
          isRecording={state === 'recording'}
        />

        {state === 'recording' && (
          <p className="text-sm font-mono font-medium text-primary" aria-label={`${secondsLeft} seconds remaining`}>
            {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:
            {String(secondsLeft % 60).padStart(2, '0')}
          </p>
        )}

        {state === 'paused_done' && (
          <p className="text-xs text-muted-foreground">
            Recording ready — tap play to review
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2">
        {(state === 'idle' || state === 'denied') && (
          <button
            type="button"
            onClick={startRecording}
            disabled={disabled}
            aria-label={t('report.step2.voice.start')}
            className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <Mic className="h-5 w-5" aria-hidden="true" />
            {t('report.step2.voice.start')}
          </button>
        )}

        {state === 'requesting' && (
          <div className="flex min-h-[48px] flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Requesting microphone…
          </div>
        )}

        {state === 'recording' && (
          <button
            type="button"
            onClick={stopRecording}
            aria-label={t('report.step2.voice.stop')}
            className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-lg border border-destructive bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring animate-severity-pulse"
          >
            <Square className="h-5 w-5 fill-current" aria-hidden="true" />
            {t('report.step2.voice.stop')}
          </button>
        )}

        {(state === 'paused_done' || state === 'playing') && (
          <>
            <button
              type="button"
              onClick={handlePlayback}
              aria-label={state === 'playing' ? 'Pause' : t('report.step2.voice.play')}
              aria-pressed={state === 'playing'}
              className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {state === 'playing' ? (
                <Pause className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Play className="h-5 w-5" aria-hidden="true" />
              )}
              {state === 'playing' ? 'Pause' : t('report.step2.voice.play')}
            </button>
            <button
              type="button"
              onClick={handleReRecord}
              aria-label={t('report.step2.voice.remove')}
              className="flex min-h-[48px] items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Re-record
            </button>
          </>
        )}

        {state === 'denied' && (
          <p role="alert" className="flex-1 text-xs text-destructive">
            {t('report.step2.voice.no_permission')}
          </p>
        )}
      </div>
    </div>
  );
}
