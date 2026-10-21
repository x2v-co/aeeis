---
name: AEEIS Ink Desk
description: A warm paper operating desk for long-running agent work.
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

**Creative North Star: “The Ink Desk”**

AEEIS is a desk for work that continues after the first sentence. The surface is warm paper, the type is ink, and vermilion is reserved for something that is alive or needs a hand. Moss means the evidence checked out. Ochre means a person still has to decide. The first screen asks for one outcome. The rest of the console stays flat and quiet until that work exists.

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
- **Display** (650, clamp(34px, 5vw, 56px), 1.02): The launch question, “你要推进什么？”
- **Title** (650, clamp(22px, 2.2vw, 30px), 1.25): The current run goal.
- **Section** (650, 15px, 1.3): Panel headings.
- **Body** (400, 14px, 1.7): Explanations and instructions.
- **Label** (500, 11–12px, mono): Navigation, statuses, and runtime metadata.

## Layout

The default viewport is a single writing desk: brand, one question, one field, one ink button. Opening settings reveals a two-column console. At 1051px and above the run sits on the left and the control rail becomes a hairline inspector on the right. At 780px and below, the rail stacks, navigation scrolls sideways, and the orbit stamp is removed.

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

### Signature Component: The Desk

The launch surface is the page itself. It asks “你要推进什么？”, accepts one outcome sentence, and mirrors that value into the full run form. `⌘K` opens the command palette.

### Signature Component: Run Activity Strip

A selected run shows a plain-language status between two rules, with a small signal and a scanning baseline. Human attention uses ochre. Completion uses moss. Failure uses red.

## Do's and Don'ts

- **Do** keep the first viewport to one question and one action.
- **Do** say what happens next in a sentence.
- **Do** use vermilion only for live work, focus, and the primary hover.
- **Do** support `prefers-reduced-motion`.
- **Don't** let governance panels compete with the run.
- **Don't** put motion on indicators that are not tied to live state.
- **Don't** let graph nodes or IDs create page-level horizontal overflow.
