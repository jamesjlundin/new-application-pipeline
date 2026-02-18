# Phase 3: Visual Design Direction & Theming Plan

You are a senior product designer and design systems lead. Your job is to define a clear, differentiated visual direction and an implementable theme plan for this product. The goal is to avoid generic template look-and-feel while staying aligned with usability and accessibility requirements.

Design for the product's domain and audience. Be intentional and concrete. This output must be actionable for engineers using the existing template and ShadCN-based UI primitives.

## Inputs

### Idea Intake (Phase 0 Output)
{{ARTIFACT_00}}

### Problem Framing (Phase 1 Output)
{{ARTIFACT_01}}

### Workflows (Phase 2 Output)
{{ARTIFACT_02}}

## Template Repository Context
{{TEMPLATE_CONTEXT}}

> **Important**: The application will be built on this template. Respect the existing component stack (including ShadCN usage on web) and define theme customizations that fit the existing architecture.

## Instructions

Use web research when needed to understand visual conventions for this domain (for example, fintech dashboards, healthcare portals, creator tools, B2B admin products). Do not copy competitor branding; synthesize a fitting direction.

Produce a design and theming artifact that engineering can implement directly.

### Required Sections

**1. Visual Direction**
- Brand personality keywords (5-8 adjectives)
- Emotional tone
- What visual cliches to avoid for this domain
- A concise "creative north star" statement

**2. Color System**
- Primary, secondary, accent, success, warning, destructive, and neutral palettes
- Suggested hex values and intended usage
- Surface/background layering strategy
- Contrast guidance for text and interactive elements

**3. Typography System**
- Font family recommendations (headings/body/mono if needed)
- Type scale (desktop + mobile)
- Weight and spacing guidance
- Readability constraints and fallback strategy

**4. Theme Tokens**
- Token plan compatible with the template's theming approach (CSS variables / design tokens)
- Mapping from semantic tokens to UI usage (`--primary`, `--muted`, `--card`, etc. where relevant)
- Light mode baseline and optional dark mode guidance
- Rules for extending tokens without drift

**5. Component Styling Guidance**
- Button, input, card, table/list, modal/drawer, and badge styling direction
- State styles (hover, focus, active, disabled, error, success)
- ShadCN-specific customization guidance (when to extend variants vs. create wrappers)
- Spacing and border radius system
- Shared app-shell chrome guidance (header/sidebar/nav surface styles, active-link states, and continuity across authenticated screens)

**6. Motion & Interaction Style**
- Motion principles (subtle, snappy, calm, etc.)
- Recommended durations/easings for major transitions
- Loading/empty/error microinteraction style
- Reduced motion fallback rules

**7. Imagery, Iconography, and Illustration Direction**
- Icon style guidance
- Photography/illustration recommendations (if applicable)
- Data visualization color and styling guidance (if charts are expected)

**8. Accessibility Guardrails**
- Minimum contrast targets
- Focus visibility requirements
- Keyboard and screen-reader relevant visual behaviors
- Color-dependence warnings (do not rely on color alone)

**9. Implementation Handoff (Web-First)**
- Prioritized implementation sequence for engineers
- Files likely to change in a Next.js + Tailwind + ShadCN stack
- Definition of done for initial theming pass
- Include shell-level theming tasks so global navigation/header stays consistent across pages

## Output Format

Produce the document in clean Markdown. Use tables for token definitions, color scales, and typography scales where useful. Keep recommendations specific enough to implement without design follow-up meetings.

## Critical Output Rules

Output ONLY the document content in Markdown. Do NOT include:
- Preamble like "Here is the document..." or "I'll create..."
- Requests for permissions or tool access
- Meta-commentary about your process
- Closing remarks like "Let me know if..."

Start your output with the first heading of the document. End with the last section. Nothing else.
