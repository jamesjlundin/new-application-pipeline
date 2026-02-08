# Template Repository Context

The application will be built on top of a pre-existing GitHub template repository. You MUST account for what the template already provides — do not plan, design, or build anything that already exists in the template. Instead, focus on what needs to be added, modified, or extended.

## Template: full-stack-web-and-mobile-template

### What the Template Already Provides

**Architecture:**
- Monorepo using pnpm workspaces + Turborepo for fast, cached builds
- TypeScript everywhere with shared types across all packages

**Web App (apps/web):**
- Next.js 16 with App Router, Server Components, Middleware, and API Routes
- Tailwind CSS for styling
- Fully functional web UI with layouts, pages, and components

**Mobile App (apps/mobile):**
- React Native bare workflow for iOS and Android
- Shared API client with the web app

**Authentication (already wired up):**
- Better Auth with email/password + OAuth support
- Session-based auth for web, JWT-based auth for mobile
- Password reset flow with email verification
- Auth middleware and protected routes

**Database:**
- PostgreSQL via Neon Serverless Postgres (provisioned through Vercel)
- Drizzle ORM with type-safe queries and auto-generated migrations
- Migration scripts and schema management

**AI Features (demo included):**
- OpenAI integration with streaming chat
- Tool calling and image generation examples
- Rate limiting on AI endpoints

**Rate Limiting:**
- Upstash Redis-powered protection on auth and API routes

**Email:**
- Resend integration for verification and password reset emails

**CI/CD & Deployment:**
- GitHub Actions workflows for tests, linting, migrations, and auto-deploy
- Vercel deployment configuration
- iOS TestFlight via Fastlane + Match
- Android internal testing workflow

**Testing:**
- Vitest for unit/integration tests
- Playwright for E2E browser tests
- Mobile E2E testing workflow

**Developer Experience:**
- Claude Code skills for common tasks (API scaffolding, DB schema changes, PR review, deploy helper, etc.)
- CLAUDE.md, AGENTS.md, GEMINI.md for AI coding assistant context
- Prettier for formatting, ESLint for linting
- .env.example with documented environment variables

### Monorepo Structure

```
apps/
  web/           — Next.js 16 web application
  mobile/        — React Native iOS & Android app
  api/           — API package (placeholder)
packages/
  shared/        — Shared types, utilities, and API client
  db/            — Drizzle schema, migrations, and database utilities
  auth/          — Better Auth configuration and helpers
  ai/            — OpenAI integration and AI utilities
  email/         — Resend email templates and sending logic
  rate-limit/    — Upstash Redis rate limiting
```

### Key Technology Stack

| Layer          | Technology                        |
|----------------|-----------------------------------|
| Language       | TypeScript 5.9                    |
| Web Framework  | Next.js 16 (App Router)           |
| Mobile         | React Native (bare workflow)      |
| ORM            | Drizzle ORM                       |
| Database       | PostgreSQL (Neon Serverless)      |
| Auth           | Better Auth                       |
| AI             | OpenAI SDK (streaming + tools)    |
| Email          | Resend                            |
| Rate Limiting  | Upstash Redis                     |
| Styling        | Tailwind CSS                      |
| Build          | Turborepo + pnpm workspaces       |
| Testing        | Vitest + Playwright               |
| Deployment     | Vercel + GitHub Actions           |
| Mobile Deploy  | Fastlane (iOS) + Gradle (Android) |

### What You Do NOT Need to Plan or Build

- Authentication system (signup, login, logout, password reset, OAuth)
- Database setup, ORM configuration, or migration tooling
- Basic monorepo structure and build pipeline
- CI/CD workflows
- Rate limiting infrastructure
- Email sending infrastructure
- AI chat streaming infrastructure
- Basic web app layout and routing
- Basic mobile app setup
- Testing infrastructure and configuration
- Linting and formatting configuration

### What You SHOULD Focus On

- New data models / database tables specific to the application
- New API endpoints for application-specific business logic
- New UI pages and components for the application's features
- Application-specific business logic
- Modifications to existing auth flows (e.g., adding roles, permissions)
- New third-party integrations beyond what's already included
- Application-specific testing
