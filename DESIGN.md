---
name: AEEIS Minimal
description: One Bot, many concurrent tasks, and a quiet shared computer.
colors:
  ink: "#171717"
  ink-soft: "#3f3f3f"
  muted: "#737373"
  page: "#ffffff"
  surface: "#ffffff"
  signal: "#171717"
  signal-deep: "#000000"
  moss: "#3d6b52"
  ochre: "#8a5a12"
  red: "#9b3a32"
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

**Creative North Star: “One Bot, many tasks”**

Follow the 2026-10-21 conversation design: AEEIS stays one Bot. That Bot can carry several tasks at once. The sidebar is the Bot, and the tasks sit under it. Opening a task only shows that execution. It does not stop the others. The transcript is the entry. The composer stays at the bottom. Graphs, evidence, goals, and governance stay in the shared computer until asked for. The surface is white, hairline, and quiet.

**Key Characteristics:**
- White page, #fafafa sidebar, 1px #ececec lines
- Black only for the mark, the send button, and active presence
- Tasks are indented rows under the Bot, not a second list of teammates
- Inter for interface copy, with WenQuanYi Micro Hei for Chinese glyphs, and JetBrains Mono for IDs and status
- Motion only on live signals, with reduced-motion support

## Colors

Black reads. Status colors stay small and only on state.

### Primary
- **Ink** (#171717): Text, the send button, the brand mark, and active presence.

### Secondary
- **Moss** (#3d6b52): Completed work.
- **Ochre** (#8a5a12): Waiting on a person.
- **Red** (#9b3a32): Blocked work.

### Neutral
- **Muted** (#737373): Labels.
- **Page / Surface** (#ffffff): The conversation and the computer.
- **Sidebar** (#fafafa): The Bot and its tasks.
- **Line** (#ececec): Boundaries. **Line Strong** (#d6d6d6): Inputs.

## Typography

**UI Font:** Inter, with WenQuanYi Micro Hei and Droid Sans Fallback for Chinese
**Label/Mono Font:** JetBrains Mono

**Character:** Inter keeps Chinese and Latin at the same weight. Mono is reserved for runtime vocabulary, IDs, and compact technical metadata.

### Hierarchy
- **Display** (650, 28px): The empty conversation, “AEEIS”.
- **Title** (500, 14px): The user’s goal, in a light gray bubble.
- **Section** (650, 15px, 1.3): Panel headings.
- **Body** (400, 14px, 1.7): Explanations and instructions.
- **Label** (500, 11–12px, mono): Navigation, statuses, and runtime metadata.

## Layout

The sidebar lists Bots, then that Bot's tasks, then group chats. AEEIS is always there. When no external Agent has been admitted, the demo also shows 发布, 研究 and 纪要, already split into 工作 and 研究. Those demo Bots can be regrouped, and they can be named in a group chat, but they do not run tasks or reply. Admitted Agents replace the demo roster. Clicking AEEIS returns to its entry and keeps a draft already typed. It does not stop a task. A group chat sits below the tasks: AEEIS is always in it, plus one to five admitted external agents, demo Bots, or members, six people at most. The transcript shows the entry, the execution of the task you opened, or that shared Room. Opening a group does not stop a task. Approvals, logins, and secrets stay in the one-to-one conversation. The composer accepts one message; Enter sends. In a group, `@` names who owns the next step. “打开它的工作台” reveals the shared computer. Closing it leaves the conversation in place. Below 860px the sidebar and the conversation swap places. Share and thread pages stay transcript-only.

## Elevation & Depth

Depth is flat. White sits on white, separated by 1px lines. The command palette, the run dock, and the activity toast are the only shadows.

## Shapes

Corners are short: 4px controls, 6px task rows, 12px bubbles. The brand mark is a plain black square.

## Components

### Buttons
- **Shape:** 4px radius. No lift on hover.
- **Primary:** Black fill, white text. Hover stays black.
- **Quiet:** Transparent or paper, ink text, hairline border.

### Cards / Containers
- **Work sheets:** White, 1px line.
- **Rail:** No cards. Sections are separated by a bottom rule.
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
