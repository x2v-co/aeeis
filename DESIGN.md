---
name: AEEIS Control Surface
description: A light, spacious operating console for long-running agent work.
colors:
  ink: "#172033"
  ink-soft: "#4f5b70"
  muted: "#5f6d82"
  page: "#f4f6f8"
  surface: "#ffffff"
  blue: "#315efb"
  blue-deep: "#2347d5"
  cyan: "#13b8b0"
  lime: "#baf36c"
  amber: "#f2b84b"
  red: "#d65262"
typography:
  display:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(27px, 3.2vw, 44px)"
    fontWeight: 800
    lineHeight: 1.06
    letterSpacing: "-0.055em"
  body:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: "DM Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "9px"
  md: "16px"
  lg: "26px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "28px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "13px 14px"
  surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "clamp(20px, 2.4vw, 32px)"
---

# Design System: AEEIS Control Surface

## Overview

**Creative North Star: “The Living Control Room”**

AEEIS is an operating console for goals that continue after the first click. The visual world uses generous white space, a quiet paper-like background, crisp ink typography, and blue-to-mint state color to make long-running work feel clear and alive. Motion is reserved for meaningful system activity: the agent orbit in the hero, the running-state signal, and transitions that show the interface acknowledging a change.

The interface keeps the control rail compact so the right side can hold the current run, plan graph, evidence, and delivery. Advanced governance is available on demand through collapsible panels, while the first viewport always answers what AEEIS is, where to start, and what the system is doing.

**Key Characteristics:**
- Light, spacious surfaces with thin cool-gray borders
- Blue for action and active execution; mint for evidence and completion; amber for human attention
- Manrope for UI copy with DM Mono for technical labels and IDs
- Purposeful motion with reduced-motion support

## Colors

The palette is cool and precise: ink and gray provide reading contrast, blue marks agency, mint marks verified progress, and amber marks a human decision.

### Primary
- **Signal Blue** (#315efb): Primary action, active run, focused controls, and the hero core.

### Secondary
- **Verified Mint** (#13b8b0): Connected status, successful delivery, and evidence completion.
- **Attention Amber** (#f2b84b): Approval, input, waiting, and reconcile states.

### Neutral
- **Ink** (#172033): Headings and primary content.
- **Ink Soft** (#4f5b70): Supporting copy.
- **Page** (#f4f6f8): Global canvas.
- **Surface** (#ffffff): Cards and work areas.
- **Line** (#dce2ea): Boundaries and dividers.

## Typography

**Display Font:** Manrope (with system sans fallback)
**Body Font:** Manrope (with system sans fallback)
**Label/Mono Font:** DM Mono

**Character:** Manrope gives the console a warm, contemporary voice; DM Mono is reserved for runtime vocabulary, IDs, and compact technical metadata.

### Hierarchy
- **Display** (800, clamp(27px, 3.2vw, 44px), 1.06): Product title and major run headings.
- **Headline** (800, clamp(23px, 2.7vw, 36px), 1.08): Hero statement.
- **Title** (700, 16px, 1.3): Section headings and card titles.
- **Body** (400, 14px, 1.75): Explanations and instructions.
- **Label** (500, 12px, 1.4, slight tracking): Navigation, statuses, and runtime metadata.

## Layout

The page uses a two-column operating layout: a 310–370px sticky control rail and a fluid work surface. The top hero uses a 1fr / 240–360px composition with a small orbit visualization. At 780px and below, the rail becomes a normal stack, navigation becomes horizontally scrollable, and the orbit is removed to protect focus and width.

## Elevation & Depth

Depth comes from white surfaces on a cool-gray page, 1px cool borders, and restrained ambient shadows. The hero and primary run use the strongest elevation; data rows stay mostly flat and gain a small lift on hover.

## Shapes

The shape language is soft but precise: 9px controls, 10px data rows, 16px work sections, and a 26px hero. Borders are thin and cool-gray. Pills are used for statuses and lifecycle steps only.

## Components

### Buttons
- **Shape:** 9px radius.
- **Primary:** Signal Blue fill with white text and a restrained blue shadow.
- **Hover / Focus:** Darker blue, two-pixel lift, and a visible focus ring.
- **Secondary:** Pale blue surface with blue ink.

### Cards / Containers
- **Corner Style:** 16px work surfaces; 10px data rows.
- **Background:** White or a very light blue/green tint for semantic states.
- **Shadow Strategy:** Ambient shadow on major surfaces only.
- **Border:** 1px cool-gray, semantic color for active states.
- **Internal Padding:** 20–32px for work surfaces, 11–13px for rows.

### Inputs / Fields
- **Style:** White fill, 1px cool-gray border, 9px radius, 10–11px padding.
- **Focus:** Blue border with a soft blue focus halo.
- **Error / Disabled:** Red text for errors; reduced opacity for disabled actions.

### Navigation

Sticky pill links provide quick jumps between work areas. They remain white and quiet at rest, gain blue ink and a slight lift on hover, and scroll horizontally on small screens.

### Signature Component: Command Center

The top command center is the primary launch surface. It accepts a single outcome sentence, mirrors that value into the full run form, supports the keyboard shortcut `⌘K`, and can switch the workspace into a focused run mode that removes the configuration rail.

### Signature Component: Run Activity Strip

Every selected run includes a compact activity strip beneath its title. The strip translates machine status into plain language, paired with a small signal animation and a scanning baseline. Human attention states use amber; successful completion uses mint; failures use red.

## Do's and Don'ts

- **Do** keep the first viewport focused on one clear action: start a run.
- **Do** translate statuses into a sentence that tells the user what happens next.
- **Do** use motion to show a living process or an acknowledged action.
- **Do** support `prefers-reduced-motion`.
- **Don't** make advanced governance compete with the primary run flow.
- **Don't** use motion on decorative indicators that are not tied to live state.
- **Don't** let graph nodes or IDs create page-level horizontal overflow.
