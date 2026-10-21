---
name: AEEIS Ink Desk
description: A Grok-style conversation with an on-demand workbench for long-running agent work.
colors:
  ink: "#1c1916"
  ink-soft: "#4a433c"
  muted: "#5e564e"
  page: "#efe8dc"
  surface: "#fbf7f1"
  signal: "#b43322"
  signal-deep: "#8c2416"
  moss: "#1f6b45"
  ochre: "#a16207"
  red: "#9f2c22"
typography:
  display:
    fontFamily: "Inter, WenQuanYi Micro Hei, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(34px, 5vw, 56px)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.055em"
  body:
    fontFamily: "Inter, WenQuanYi Micro Hei, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "JetBrains Mono, Noto Sans Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#fbf7f1"
    rounded: "{rounded.sm}"
    padding: "12px 14px"
  surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "clamp(18px, 2.2vw, 28px)"
---

# Design System: AEEIS Ink Desk

## Overview

**Creative North Star: “A teammate, not a console”**

AEEIS is one persistent agent. The screen is a conversation with it. The sidebar is a roster of ongoing work and shows whether the agent is idle, thinking, working, waiting, blocked, or done. The transcript holds the goal, the decision, tool activity, and the delivery. The composer stays fixed at the bottom. Graphs, evidence, goals, reminders, and governance live in its computer — a side panel opened from the conversation, never the home page. Vermilion means the agent is alive or needs a hand. Moss means the evidence checked out. Ochre means a person still has to decide.

**Key Characteristics:**
- Warm paper page with a 3px vermilion rule at the top
- Ink for primary actions; vermilion on hover and for live execution
- Hairline sections in the control rail; lifted paper sheets for the current run
- Inter for interface copy, with WenQuanYi Micro Hei for Chinese glyphs, and JetBrains Mono for IDs and status
- Motion only on live signals, with reduced-motion support

## Colors

Ink does the reading. Vermilion marks agency. Moss marks verified delivery. Ochre marks a human decision.

### Primary
- **Ink** (#1c1916): Headings, primary buttons, the current-run frame, and the brand mark.
- **Signal Vermilion** (#b43322): Hover on primary actions, active execution, focus, and the page rule.

### Secondary
- **Verified Moss** (#1f6b45): Connected status, successful delivery, and evidence completion.
- **Attention Ochre** (#a16207): Approval, input, waiting, and reconcile states.

### Neutral
- **Ink Soft** (#4a433c): Supporting copy.
- **Muted** (#5e564e): Labels and metadata.
- **Page** (#efe8dc): Global canvas.
- **Surface** (#fbf7f1): Cards, inputs, and the command sheet.
- **Line** (#e0d5c6): Boundaries. **Line Strong** (#cbbba6): Inputs and emphasis rules.

## Typography

**UI Font:** Inter, with WenQuanYi Micro Hei and Droid Sans Fallback for Chinese
**Label/Mono Font:** JetBrains Mono

**Character:** Inter keeps Chinese and Latin at the same weight. Mono is reserved for runtime vocabulary, IDs, and compact technical metadata.

### Hierarchy
- **Display** (650, 28px): The empty conversation, “AEEIS”.
- **Title** (500, 14px): The user’s goal, set as an ink bubble on the right.
- **Section** (650, 15px, 1.3): Panel headings.
- **Body** (400, 14px, 1.7): Explanations and instructions.
- **Label** (500, 11–12px, mono): Navigation, statuses, and runtime metadata.

## Layout

The default viewport is a roster, a transcript, and a composer. The roster lists each run with a presence mark. The transcript is the selected run: the goal on the right, decision and activity cards on the left, approval inline. The composer accepts one message; Enter sends. “打开它的工作台” reveals the computer on the right (setup, goals, governance, status, or this run’s graphs). Closing it leaves the conversation in place. Below 860px the roster and the conversation swap places; the computer covers the screen until it is closed. Share and thread pages stay transcript-only.

## Elevation & Depth

Depth is mostly flat. Paper sits on a warmer page, separated by 1px lines. Floating objects — the command palette, the run dock, and the activity toast — are the only surfaces with a shadow. The current run uses an ink border instead of a glow.

## Shapes

Corners are short: 4px controls, 6px rows, 8px decisions, 12px work sheets. Pills are limited to status and lifecycle filters. The brand mark is an ink square with a vermilion registration mark.

## Components

### Buttons
- **Shape:** 4px radius. No lift on hover.
- **Primary:** Ink fill, paper text. Hover and press shift to vermilion.
- **Quiet:** Transparent or paper, ink text, hairline border.

### Cards / Containers
- **Work sheets:** 12px, paper fill, 1px line. The current run uses an ink border. Delivery uses a moss border.
- **Rail:** No cards. Sections are separated by a bottom rule. The new-run block carries a vermilion spine.
- **Rows:** 6px, paper, ink border on hover or selection.

### Inputs / Fields
- **Style:** Paper fill, 1px strong line, 4px radius.
- **Focus:** Ink border and a soft ink halo.
- **Error:** Vermilion-red text. Disabled actions fade to half opacity.

### Navigation

Text links with a bottom rule on hover. They stay quiet at rest and scroll horizontally on small screens.

### Signature Component: The Conversation

The home surface is a chat with AEEIS. An empty thread offers example intents. A selected run keeps approvals (“批准并执行”), questions, and delivery in the transcript. `⌘K` still opens the command palette. The computer is the agent’s desk and stays closed until asked for.

### Signature Component: Run Activity Strip

A selected run shows a plain-language status between two rules, with a small signal and a scanning baseline. Human attention uses ochre. Completion uses moss. Failure uses red.

## Do's and Don'ts

- **Do** keep the conversation on screen when the computer opens or closes.
- **Do** say what happens next in a sentence, inside the transcript.
- **Do** use vermilion only for live presence, focus, and the primary hover.
- **Do** support `prefers-reduced-motion`.
- **Don't** put goals, reminders, RSI, or system status on the home transcript.
- **Don't** put motion on indicators that are not tied to live presence.
- **Don't** let graph nodes or IDs create page-level horizontal overflow.
