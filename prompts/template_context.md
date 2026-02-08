# Template Repository Context

The application is built on top of `jamesjlundin/full-stack-web-and-mobile-template`. You MUST account for what the template already provides — do not plan, design, or build anything that already exists. Focus only on what needs to be added, modified, or extended.

---

## Monorepo Structure

**Build system**: Turborepo v2 + pnpm v9 workspaces. TypeScript strict mode everywhere.

```
apps/
  web/              — Next.js 16 (App Router, React 19, Tailwind CSS 4)
  mobile/           — React Native bare workflow (iOS + Android)
  api/              — Standalone API server (if configured)
packages/
  ai/               — Vercel AI SDK integration (OpenAI, Anthropic, Google)
  api-client/       — Shared fetch client with streaming + timeout
  auth/             — Better Auth config (sessions, JWT, OAuth)
  db/               — Drizzle ORM schema, migrations, PostgreSQL client
  security/         — Rate limiting (Upstash Redis + in-memory fallback)
  types/            — Shared TypeScript types (User, ChatChunk, AppConfig)
  rag/              — RAG pipeline (pgvector, chunking, embedding)
  tools/            — AI tool definitions
  tools-testing/    — Tool testing utilities
  evals/            — AI evaluation framework
  obs/              — Observability utilities
  config/           — Shared ESLint + Prettier configs
  tests/            — Integration test suite
```

Package scope: `@acme/*` (e.g., `@acme/db`, `@acme/auth`).

---

## Database Schema

**ORM**: Drizzle ORM with PostgreSQL (Neon Serverless). Schema files:
- `packages/db/src/auth-schema.ts` — Auth tables
- `packages/db/src/rag-schema.ts` — RAG vector table
- `packages/db/src/schema.ts` — Re-exports all tables

### `users` table
| Column | Type | Constraints |
|--------|------|-------------|
| id | text | PRIMARY KEY |
| name | text | NOT NULL, default '' |
| email | text | NOT NULL, UNIQUE |
| emailVerified | boolean | NOT NULL, default false |
| image | text | nullable |
| role | text | NOT NULL, default 'user' |
| createdAt | timestamp | NOT NULL, defaultNow() |
| updatedAt | timestamp | NOT NULL, auto-update |

### `sessions` table
| Column | Type | Constraints |
|--------|------|-------------|
| id | text | PRIMARY KEY |
| expiresAt | timestamp | NOT NULL |
| token | text | NOT NULL, UNIQUE |
| createdAt | timestamp | NOT NULL, defaultNow() |
| updatedAt | timestamp | NOT NULL, auto-update |
| ipAddress | text | nullable |
| userAgent | text | nullable |
| userId | text | NOT NULL, FK -> users.id CASCADE |

Index: `sessions_userId_idx` on userId.

### `accounts` table
| Column | Type | Constraints |
|--------|------|-------------|
| id | text | PRIMARY KEY |
| accountId | text | NOT NULL |
| providerId | text | NOT NULL |
| userId | text | NOT NULL, FK -> users.id CASCADE |
| accessToken | text | nullable |
| refreshToken | text | nullable |
| idToken | text | nullable |
| accessTokenExpiresAt | timestamp | nullable |
| refreshTokenExpiresAt | timestamp | nullable |
| scope | text | nullable |
| password | text | nullable (hashed) |
| createdAt | timestamp | NOT NULL, defaultNow() |
| updatedAt | timestamp | NOT NULL, auto-update |

Index: `accounts_userId_idx` on userId.

### `verifications` table
| Column | Type | Constraints |
|--------|------|-------------|
| id | text | PRIMARY KEY |
| identifier | text | NOT NULL |
| value | text | NOT NULL |
| expiresAt | timestamp | NOT NULL |
| createdAt | timestamp | NOT NULL, defaultNow() |
| updatedAt | timestamp | NOT NULL, auto-update |

Index: `verifications_identifier_idx` on identifier.

### `rag_chunks` table
| Column | Type | Constraints |
|--------|------|-------------|
| id | text | PRIMARY KEY (ULID) |
| docId | text | NOT NULL |
| content | text | NOT NULL |
| metadata | jsonb | nullable |
| embedding | vector(1536) | via raw SQL migration (pgvector) |
| createdAt | timestamp | NOT NULL, defaultNow() |

Index: `rag_chunks_doc_id_idx` on docId.

### Relations
- users -> many sessions (one-to-many)
- users -> many accounts (one-to-many)

### Adding New Tables
New tables go in `packages/db/src/`. Follow the existing pattern: define with `pgTable()`, export from `schema.ts`, then run `pnpm migrate:generate` and `pnpm migrate:apply`.

---

## Authentication

**Library**: Better Auth. **Config file**: `packages/auth/src/index.ts`

### What's Already Implemented
- Email/password signup + login
- Google OAuth (conditional — enabled if `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` set)
- Email verification flow (with Resend or dev token fallback)
- Password reset flow
- Web: cookie-based sessions (cookie prefix: `acme`)
- Mobile: JWT bearer tokens (HS256, 24h expiry, signed with `BETTER_AUTH_SECRET`)
- Dev token storage (in-memory Map, 10-min expiry, logged when `ALLOW_DEV_TOKENS=true`)

### Key Auth Functions
- `getCurrentUser(request)` — Extracts user from Bearer token or session cookie. File: `packages/auth/src/index.ts`
- `auth.api.getSession()` — Session lookup with `nextCookies()` plugin
- `getDevToken(type, email)` / `storeDevToken()` / `consumeTokenForEmail()` — Dev/test token helpers
- `isGoogleAuthEnabled()` — Check if OAuth is configured

### Auth Middleware Pattern
Protected API routes call `getCurrentUser(request)`. It checks Bearer token first (JWT verify), falls back to session cookie. Returns `{ user }` or `null`.

---

## API Routes

All routes under `apps/web/app/api/`. Pattern: Next.js App Router route handlers.

### Existing Routes

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| POST | /api/agent/stream | User | 5/24h per user | Stream AI agent responses with tools |
| POST | /api/auth/token | No | 5/60s per IP | Email/password sign-in, returns JWT |
| ALL | /api/auth/[...any] | Varies | Varies | Better Auth catch-all handler |
| GET | /api/me | Bearer/Session | No | Current user + app config |
| GET | /api/config | No | No | App configuration (providers, features) |
| POST | /api/rag/query | Yes | No | RAG semantic search |
| POST | /api/upload | Yes | No | File upload (Vercel Blob) |
| GET | /api/health | No | No | Health check |
| GET | /api/debug/versions | No | No | Debug version info |
| POST | /api/cron/heartbeat | CRON_SECRET | No | Health check cron |
| POST | /api/cron/nightly | CRON_SECRET | No | Nightly scheduled tasks |
| POST | /api/cron/run | CRON_SECRET | No | Generic cron runner |

### API Route Pattern (follow this for new routes)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter } from '@acme/security';
import { withRateLimit, withUserRateLimit } from '../_middleware';
import { getCurrentUser } from '@acme/auth';

const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

async function handler(request: NextRequest): Promise<Response> {
  const body = await request.json().catch(() => null);
  // Validate with Zod, then business logic
  return NextResponse.json(data);
}

// IP-based rate limiting (public routes):
export const POST = withRateLimit('/api/route', limiter, handler);

// User-based rate limiting (protected routes):
export const POST = withUserRateLimit('/api/route', limiter, handler);
```

### Response Formats
- Success: `NextResponse.json(data, { status: 200 })`
- Error: `NextResponse.json({ error: 'message' }, { status: 4xx })`
- Streaming: `new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })`
- Rate limited: 429 with `Retry-After` header + `X-RateLimit-*` headers

---

## Frontend Pages

### Web App (Next.js App Router)

**Public pages** (route group `(public)`):
- `/` — Landing page
- `/login` — Sign in
- `/register` — Sign up
- `/logout` — Sign out
- `/auth/verify` — Email verification
- `/auth/reset` — Password reset request
- `/auth/reset/confirm` — Password reset confirmation
- `/reset-password` + `/reset-password/confirm` — Alternative reset flow

**Protected pages** (under `app/(protected)`):
- `/app/home` — Dashboard
- `/app/agent` — AI agent interaction

**Layouts**: Root layout at `app/layout.tsx`, public group layout, protected app layout.

### Mobile App (React Native)

Screens at `apps/mobile/src/screens/`:
- `SplashScreen`, `WelcomeScreen`
- `SignInScreen`, `SignUpScreen`
- `VerifyEmailScreen`, `ResetRequestScreen`, `ResetConfirmScreen`
- `HomeScreen`, `AgentScreen`, `AccountScreen`

---

## Shared Package Exports

### `@acme/db`
- `db` — Drizzle ORM instance (lazy-init proxy, serverless-safe)
- `pool` — Node pg pool (CLI tools only)
- `schema` — All table definitions
- Operators: `eq`, `and`, `or`, `gt`, `gte`, `lt`, `lte`, `ne`, `ilike`, `like`, `inArray`, `isNull`, `isNotNull`, `asc`, `desc`, `count`, `sum`, `avg`, `max`

**Query pattern**:
```typescript
import { db, eq, schema } from '@acme/db';
const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
await db.insert(schema.users).values({ id, email, name });
await db.update(schema.users).set({ name }).where(eq(schema.users.id, id));
await db.delete(schema.users).where(eq(schema.users.id, id));
```

### `@acme/auth`
- `auth` — Better Auth instance
- `authHandler` — Next.js route handler (GET, POST, PUT, PATCH, DELETE)
- `getCurrentUser(request)` — Extract user from token/session
- Dev token helpers: `getDevToken()`, `storeDevToken()`, `consumeTokenForEmail()`
- `isGoogleAuthEnabled()`

### `@acme/security`
- `createRateLimiter({ limit, windowMs })` — Returns `{ check(key), limit }`
- Uses Upstash Redis in production, in-memory Map in dev
- Configurable via `DISABLE_RATE_LIMIT`, `RATE_LIMIT_MULTIPLIER`

### `@acme/ai`
- `getModel(provider, model)` — Instantiate LLM (OpenAI, Anthropic, Google)
- `getAvailableProviders()`, `getDefaultProvider()`, `validateProviderModel()`
- `streamChat()` — Stream text responses
- `selectPrompt(channel)` — Get system prompt by channel
- Image generation tool: `executeGenerateImage()`

### `@acme/api-client`
- `createApiClient(baseUrl?)` — Returns client with: `getMe()`, `getConfig()`, `signIn()`, `requestVerificationEmail()`, `streamChat()`
- `streamFetch(url, init)` — Async generator for SSE
- `fetchWithTimeout(url, init)` — Fetch with 10s default timeout

### `@acme/types`
- `User` — `{ id, email, name?, emailVerified? }`
- `ChatChunk` — `{ content: string, done?: boolean }`
- `AiProviderInfo`, `AiModelInfo`, `AppConfig`

### `@acme/rag`
- Chunking: `fixedSizeChunks()`, `mdToText()`, `splitParagraphs()`
- Embedding: `openaiEmbedder()`, `getDefaultEmbedder()`
- Vector store: `upsertChunks()`, `querySimilar()`, `deleteDocChunks()`
- High-level: `ragQuery(db, options)`, `createRetrieveFn(db)`

---

## Environment Variables

### Required
- `DATABASE_URL` — PostgreSQL connection string (Neon-compatible)
- `BETTER_AUTH_SECRET` — JWT signing key (>= 32 chars)
- `APP_BASE_URL` — App base URL (e.g., http://localhost:3000)

### Optional — Enable Features
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` — Enable Google OAuth
- `RESEND_API_KEY` — Enable email verification/reset via Resend
- `MAIL_FROM` — Sender email address
- `OPENAI_API_KEY` — Enable OpenAI models
- `ANTHROPIC_API_KEY` — Enable Anthropic models
- `GOOGLE_GENERATIVE_AI_API_KEY` — Enable Google Gemini
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — Enable Upstash Redis rate limiting
- `BLOB_READ_WRITE_TOKEN` — Enable Vercel Blob file uploads
- `CRON_SECRET` — Protect cron endpoints
- `NEXT_PUBLIC_GA_TRACKING_ID` — Google Analytics 4

### Dev/Test
- `ALLOW_DEV_TOKENS=true` — Echo tokens in API responses
- `DISABLE_RATE_LIMIT=true` — Skip rate limiting
- `RATE_LIMIT_MULTIPLIER=N` — Multiply rate limits by N
- `RESEND_DRY_RUN=true` — Log email payloads instead of sending

### Database Variants (Vercel/Neon)
- `DATABASE_URL_UNPOOLED` — For migrations
- `POSTGRES_URL`, `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`
- `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`

---

## CI/CD & Deployment

### GitHub Actions Workflows
- `.github/workflows/tests.yml` — Runs on push/PR: builds, migrates, runs integration tests + Playwright E2E (chromium + webkit) against PostgreSQL + pgvector service
- `.github/workflows/deploy.yml` — Runs on main: typecheck, lint, build, migrate, trigger Vercel deploy hook
- `.github/workflows/linter.yml` — Lint checks
- `.github/workflows/evals.yml` — AI evaluation runs
- `.github/workflows/ios-testflight.yml` — iOS build + TestFlight
- `.github/workflows/android-internal.yml` — Android internal testing
- `.github/workflows/mobile-e2e.yml` — React Native E2E tests

### Key Scripts
- `pnpm dev` — Run all apps in parallel
- `pnpm build` — Build all workspaces
- `pnpm typecheck` — TypeScript strict check
- `pnpm lint` — ESLint all packages
- `pnpm format` — Prettier format
- `pnpm test:integration` — Integration tests
- `pnpm test:e2e` — Playwright E2E tests
- `pnpm db:up` / `pnpm db:down` — Local PostgreSQL via Docker
- `pnpm migrate:generate` / `pnpm migrate:apply` — Drizzle migrations

---

## Code Conventions (from CLAUDE.md / AGENTS.md)

### Style
- Prettier: single quotes, semicolons, 100 char width, trailing commas
- ESLint: alphabetized import groups, no unused imports
- Naming: camelCase for functions/variables, PascalCase for types/components

### Rules
- Run `pnpm typecheck && pnpm lint` before committing
- Use `@acme/*` workspace packages for shared code
- Add rate limiting to all new endpoints via `@acme/security`
- Define new tables in `packages/db/src/`, export from `schema.ts`
- Follow existing patterns in each package
- Never commit `.env` files or hardcode secrets

---

## What You Do NOT Need to Build

- Authentication (signup, login, logout, password reset, OAuth)
- Database setup, ORM config, migration tooling
- Monorepo structure and build pipeline
- CI/CD workflows
- Rate limiting infrastructure
- Email sending infrastructure
- AI chat streaming infrastructure
- Basic web app layout, routing, and auth pages
- Basic mobile app setup and auth screens
- Testing infrastructure (Vitest, Playwright, integration test setup)
- Linting and formatting configuration

## What You SHOULD Focus On

- New database tables for the application's domain
- New API endpoints for application-specific business logic
- New UI pages and components for the application's features
- Application-specific business logic and data flows
- Modifications to existing auth (e.g., adding roles or permissions beyond the `role` column)
- New third-party integrations beyond what's included
- Application-specific tests
