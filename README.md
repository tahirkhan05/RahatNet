# RahatNet — AI-Powered Disaster Coordination Platform

> **Google Solutions Challenge 2026 Submission**
> Real-time AI-driven disaster relief coordination for India, built for the people who need it most.

---

## The Problem

India faces annual flooding in Kerala, Assam, Bihar, Odisha, and Uttarakhand. During the 2018 Kerala floods — which killed 483 people — post-disaster analysis found that **coordination failure, not resource shortage**, was the primary cause. Thousands of WhatsApp messages reported the same flooded house, volunteers were dispatched to wrong locations, and coordinators had no unified view.

RahatNet solves this with a real-time AI layer that sits between citizens, volunteers, and coordinators.

---

## What It Does

```
Citizen reports need (voice/photo/text, offline-capable)
         ↓
Gemini AI deduplicates 500 reports → 1 canonical need
         ↓
Urgency scored (keyword + Vision AI + context)
         ↓
Coordinator sees live war room map with priority queue
         ↓
Volunteer dispatched with Google Maps turn-by-turn navigation
         ↓
Citizen tracks volunteer live location (Swiggy-style)
         ↓
Need resolved — analytics updated in BigQuery
```

---

## Key Features

### For Citizens (Flood Victims)

- **One-tap need reporting** — select type, auto-detect GPS, speak in your language
- **Voice + photo submission** — works on 2G, offline-first with IndexedDB queue
- **8 Indian languages** — Hindi, Telugu, Tamil, Kannada, Malayalam, Bengali, Marathi, Gujarati
- **Live volunteer tracking** — see your volunteer approaching on a map, call them directly
- **Real-time status** — Submitted → Processing → Verified → Help on the way → Resolved

### For Volunteers

- **Smart task assignment** — matched by skill (boat operator, doctor, cook, rescue swimmer)
- **In-app navigation** — full Swiggy-style map with route, ETA, and citizen contact
- **Live availability toggle** — turn on/off, synced across all devices instantly
- **Push notifications** — FCM alerts when assigned a task
- **Offline map tiles** — cached for flood zones with poor connectivity

### For Coordinators (War Room)

- **Full-screen live map** — Google Maps with emoji need pins (🆘🍛💊🏠), clustering, density rings
- **AI priority queue** — needs ranked by Gemini urgency score (1-10)
- **5 live analytics charts** — response time, resolution funnel, volunteer activity, need type breakdown, coverage
- **One-click volunteer assignment** — see who expressed interest, assign instantly
- **Resource tracker** — boats, food packets, medicine kits with deploy/return/delete
- **Auto-process reports** — "Process" button runs Gemini classification + urgency scoring

### Proactive Trigger System

- **IMD alert polling** — Cloud Function runs every 15 minutes
- **Auto-activation** — when IMD issues a RED alert, war room opens before the first report comes in
- **Google Alerts integration** — disaster detection from news and government sources

---

## AI Stack

| Feature              | Technology                       | What It Does                                                        |
| -------------------- | -------------------------------- | ------------------------------------------------------------------- |
| Report deduplication | Gemini 1.5 Flash                 | 500 reports → 1 canonical need                                      |
| Urgency scoring      | Gemini Vision + keywords         | Photo analysis + text scoring → 1-10 score                          |
| Need classification  | Gemini 1.5 Flash                 | Auto-tags RESCUE/FOOD/MEDICINE/SHELTER/MENTAL_HEALTH/INFRASTRUCTURE |
| Multilingual NLP     | Google Cloud Translation API     | Understands reports in 8 languages                                  |
| Voice transcription  | Gemini multimodal                | Audio → text → classification                                       |
| Volunteer dispatch   | Distance Matrix + skill matching | Finds best-fit volunteer with real ETA                              |
| Urgency prediction   | Vertex AI (fallback: Gemini)     | Tabular model for severity scoring                                  |
| Analytics            | BigQuery                         | Real-time impact metrics for coordinators and NDRF                  |

---

## Tech Stack

```
Frontend:    Next.js 14 (App Router) · TypeScript strict · Tailwind CSS
Backend:     Firebase (Auth/Firestore/RTDB/Storage/FCM/Admin SDK)
AI/ML:       Gemini 1.5 Flash · Vertex AI · Google Cloud Translation
Maps:        Google Maps Platform (Routes API, Geocoding, Distance Matrix)
Infra:       Firebase Cloud Functions v2 · BigQuery · Turborepo monorepo
PWA:         Workbox · Background Sync · IndexedDB · Push Notifications
Testing:     Vitest (unit/integration) · Playwright (E2E) · MSW (mocks)
CI/CD:       GitHub Actions (lint → test → build → deploy)
```

---

## Architecture

```
apps/
├── web/                    # Next.js 14 PWA (citizen + volunteer + coordinator)
│   ├── app/
│   │   ├── citizen/        # Citizen dashboard, report form, status tracker, live tracking
│   │   ├── volunteer/      # Volunteer dashboard, tasks, map, in-app navigation
│   │   ├── coordinator/    # War room, needs queue, volunteers, resources
│   │   └── api/            # 20+ API routes (AI, dispatch, auth, needs, resources)
│   ├── components/         # 40+ React components
│   ├── hooks/              # useOfflineQueue, useVolunteerLocation, useTaskNotifications...
│   └── lib/
│       ├── ai/             # Gemini, Vertex AI, urgency scoring, translation, deduplication
│       ├── firebase/       # Client SDK, Admin SDK, RTDB, Storage
│       └── maps/           # Google Maps loader, geocoding, routing
└── functions/              # Firebase Cloud Functions
    ├── ai/                 # processReports (Gemini pipeline)
    ├── triggers/           # imdPoller (every 15min), fcmBroadcast
    ├── dispatch/           # volunteerMatcher (Firestore trigger)
    └── analytics/          # BigQuery sync (onNeedResolved, onAssignmentCompleted)

packages/
├── types/                  # Shared TypeScript types (CanonicalNeed, Assignment, etc.)
├── ui/                     # Shared shadcn/ui component library
└── config/                 # Shared ESLint, TypeScript, Tailwind configs
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+
- Firebase project with Firestore, RTDB, Auth, Storage enabled

### Setup

```bash
# Clone the repository
git clone https://github.com/tahirkhan05/RahatNet.git
cd RahatNet

# Install dependencies
pnpm install

# Configure environment
cp apps/web/.env.example apps/web/.env.local
# Fill in Firebase config, Gemini API key, Google Maps key

# Start development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000)

### Environment Variables

| Variable                          | Required | Description                                    |
| --------------------------------- | -------- | ---------------------------------------------- |
| `NEXT_PUBLIC_FIREBASE_*`          | ✅       | Firebase client config (from Firebase Console) |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | ✅       | Firebase Admin SDK service account (base64)    |
| `GEMINI_API_KEY`                  | ✅       | Google AI Studio API key                       |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY`     | ✅       | Google Maps Platform API key                   |
| `NEXT_PUBLIC_FCM_VAPID_KEY`       | ✅       | Firebase Cloud Messaging VAPID key             |
| `SESSION_SECRET`                  | ✅       | 64-char random hex for session signing         |
| `NEXT_PUBLIC_ACTIVE_DISASTER_ID`  | ✅       | Active disaster event ID                       |
| `NEXT_PUBLIC_COORDINATOR_PHONE`   | Optional | Emergency coordinator phone number             |
| `VERTEX_AI_ENDPOINT`              | Optional | Vertex AI custom model endpoint (Phase 2)      |
| `UPSTASH_REDIS_REST_URL`          | Optional | Distributed rate limiting                      |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID`   | Optional | Google Analytics                               |

### Firebase Setup

```bash
# Login to Firebase
npx firebase-tools login

# Deploy security rules and indexes
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage,database --project YOUR_PROJECT_ID

# Deploy Cloud Functions
npx firebase-tools deploy --only functions --project YOUR_PROJECT_ID
```

### Demo Flow

1. **Sign in as Coordinator** → Dashboard → click "Process" button (initializes disaster event)
2. **Sign in as Citizen** → Report a need (voice/photo/text) → Submit
3. **Coordinator** → Dashboard → "Process reports" → Gemini classifies + scores urgency
4. **Coordinator** → War Room → See need on map → Volunteers page → Assign
5. **Volunteer** → Dashboard → Active task banner → My Tasks → Navigate (in-app map)
6. **Citizen** → My Reports → Status updates live → "Track live location" button

---

## Impact Metrics

| Metric                  | Target                     | How Measured                              |
| ----------------------- | -------------------------- | ----------------------------------------- |
| Report to dispatch time | < 8 minutes                | Assignment timestamp - creation timestamp |
| Deduplication rate      | 70% reduction              | Canonical needs / raw reports ratio       |
| Coverage                | Track % of needs addressed | Resolved needs / total needs              |
| Response time           | Live in war room           | ImpactAnalytics component                 |

---

## Problem Statement Alignment — NGO Survey Gap

The problem statement specifically mentions: _"Local social groups and NGOs collect important information through **paper surveys and field reports**."_ A gap in the original build was that the platform only handled real-time crisis reports (citizens in panic). Pre-disaster vulnerability data from NGO field workers had no ingestion path.

This has been closed with a **Community Survey mode** built directly into the citizen app:

- **Structured household survey form** — NGO field workers walk door-to-door and record: household size, disability (type), elderly count, children under 12, pregnant, chronic illness, food insecurity, flood-risk zone, clean water access, surveyor name + organisation
- **Same AI pipeline** — survey submissions flow through Gemini de-duplication and urgency scoring, appearing on the war room map as distinct grey 📋 pins alongside real-time crisis pins (red/amber)
- **Mode toggle on the citizen dashboard** — a pill toggle switches between "Report a Need" (panic mode) and "Community Survey" (structured NGO mode), with separate history sections for each
- **Survey detail page** — each survey is tappable, showing all structured vulnerability data in a readable breakdown (not just a description string)
- **War room visibility** — unprocessed survey pins appear on the coordinator map immediately, before the AI pipeline runs. A "Survey Reports" metric card shows the count of pre-mapped vulnerabilities
- **Voice notes end-to-end** — voice recordings are uploaded to Firebase Storage and served as playable audio to both coordinators (in the priority queue) and volunteers (in the need detail sheet before expressing interest)

---

## Why RahatNet is Different

| System                 | What it does               | What it lacks          |
| ---------------------- | -------------------------- | ---------------------- |
| Google Crisis Response | Passive maps               | No dispatch, no AI     |
| Sahayata App           | Basic reporting            | No AI deduplication    |
| WhatsApp groups        | Informal coordination      | No structure, no dedup |
| **RahatNet**           | End-to-end AI coordination | —                      |

---

## Project Structure Decisions

- **Monorepo (Turborepo)** — shared types prevent citizen/coordinator data model drift
- **PWA over native** — instant deployment, no app store approval during disasters
- **Firebase RTDB for volunteer locations** — sub-second latency for live tracking
- **Gemini over traditional NLP** — handles code-mixed Indian language text natively
- **Edge middleware for auth** — role-based routing without server round-trips

---

## Purpose

Built for the **Google Solutions Challenge 2026** — addressing UN SDG 11 (Sustainable Cities) and SDG 13 (Climate Action).
