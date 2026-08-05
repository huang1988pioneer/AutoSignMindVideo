---
name: MindVideo 每日簽到
description: A calm Traditional Chinese desktop dashboard for verified MindVideo daily actions.
colors:
  workspace: "#F3F6F8"
  rail: "#073334"
  rail-surface: "#185151"
  paper: "#FFFFFF"
  inset-surface: "#F7F9FA"
  teal: "#008B86"
  teal-ink: "#007C78"
  heading: "#102C4A"
  body: "#516987"
  rail-strong: "#FFFFFF"
  rail-muted: "#A9D2D0"
  danger: "#B64040"
typography:
  display:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "29px"
    fontWeight: 300
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "14px"
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
rounded:
  button: "4px"
  input: "8px"
  inset: "7px"
  paper: "12px"
spacing:
  micro: "4px"
  control-gap: "10px"
  stack: "18px"
  inset: "18px"
  card: "26px"
  workspace-x: "50px"
  workspace-y: "36px"
components:
  button-primary:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.rail-strong}"
    rounded: "{rounded.button}"
    padding: "15px 9px"
    typography: "{typography.label}"
  dashboard-paper:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.heading}"
    rounded: "{rounded.paper}"
    padding: "{spacing.card}"
  account-editor:
    backgroundColor: "{colors.inset-surface}"
    textColor: "{colors.heading}"
    rounded: "{rounded.inset}"
    padding: "{spacing.inset}"
---

# Design System: MindVideo 每日簽到

## Overview

**Creative North Star: "Evergreen Desk, Daily Paper"**

This is a calm, trustworthy Traditional Chinese operations dashboard for a short daily task. A deep evergreen guidance rail anchors the desktop window, while a pale gray workspace carries a single white paper-like dashboard panel. The hierarchy is deliberately humane: orient first, review readiness second, then take a verified action.

The design avoids a dark command-center aesthetic and avoids a generic grid of cards. The prominent dashboard panel combines all-account actions, operational counters, an account ledger, and the selected account editor into one continuous work surface. Teal is reserved for affirmative action and healthy key figures; supporting information stays quiet in blue-gray ink.

**Key Characteristics:**

- Deep evergreen fixed sidebar against a light, fog-gray workspace.
- One large, rounded white dashboard paper panel rather than many competing cards.
- Teal action controls and metric ink, balanced with calm navy headings.
- Traditional Chinese operational copy with desktop-native Fluent controls.

## Colors

The palette pairs institutional evergreen with pale paper and restrained blue-gray ink, making the local credential workflow feel steady and legible.

### Primary

- **Action Teal:** `teal` is the filled affirmative-action color, used for the all-account check-in and save actions.
- **Teal Ink:** `teal-ink` is used for the eyebrow label and prominent operational values, extending the action color into non-interactive emphasis without turning the screen into a field of buttons.

### Secondary

- **Evergreen Rail:** `rail` anchors product identity and persistent guidance on the left.
- **Raised Evergreen:** `rail-surface` contains the sidebar notice, separating it softly from the rail without adding borders or shadows.

### Neutral

- **Fog Workspace:** `workspace` is the window and scrolling canvas behind the content.
- **Dashboard Paper:** `paper` is the primary white work surface.
- **Quiet Inset:** `inset-surface` groups the selected-account editor within the paper panel.
- **Navy Ink:** `heading` is for titles, table labels, and strong operational text; `body` carries explanatory copy and secondary values.
- **Rail Copy:** `rail-strong` and `rail-muted` retain clear hierarchy over the dark evergreen background.

### Named Rules

**The Teal Means Proceed Rule.** Use filled teal for an affirmative operation that submits or saves work. Refresh and add-account actions stay on the Fluent neutral treatment.

**The Paper Holds the Work Rule.** The white dashboard paper is the unified operational surface; do not fragment its tightly related contents into a gallery of equally elevated cards.

## Typography

**Display Font:** Inter, supplied through Avalonia with a system sans-serif fallback.

**Character:** Light display type makes the page heading feel composed, while semibold section titles, controls, and table headings preserve scanability for an operational desktop workflow. Traditional Chinese copy should retain the same hierarchy and avoid overly small explanatory text.

### Hierarchy

- **Display:** `display` is the large light-weight workspace page title.
- **Headline:** `headline` is the white product name in the sidebar.
- **Title:** `title` names the main dashboard paper and selected-account editor.
- **Body:** `body` explains the day’s action, activity, and operational details.
- **Label:** `label` is for the uppercase-style teal eyebrow, metric labels, navigation, and compact data labels; semibold is used where action or table scanning needs it.

**The Readiness-First Rule.** Lead with the page title and a short explanation, then surface the action and status data. Large type is reserved for orientation and key counts, never for decoration.

## Layout

The desktop shell is a two-column grid: a fixed 230px evergreen sidebar and a scrollable light workspace. The shipped window begins at 1160 × 760 and preserves the sidebar at the 920 × 620 minimum size; it does not collapse into a mobile card layout.

The workspace stack uses a 50px horizontal and 36px top inset, with a 40px bottom inset and 18px vertical rhythm. It starts with a teal eyebrow, light-weight page title, and concise description. The primary dashboard paper follows with 26px internal padding. Its contents are a vertically ordered action area, a compact operational limit row, a three-column metric strip, an activity line, an account table, and a quiet account-editor inset.

The sidebar uses 25px horizontal and 28px vertical padding. It keeps product identity and guidance in view, places the notice and operational links below it, and pins token-privacy guidance at the bottom. Main content scrolls independently when height is constrained.

## Elevation & Depth

The system is flat and tonal: there are no authored shadows. Depth comes from the large contrast step between the evergreen rail, fog workspace, white dashboard paper, and pale editor inset. Rounded containment makes these layers feel approachable without simulating floating material.

**The Quiet Layers Rule.** Use tonal surface changes and spacing for grouping. Do not add glass, gradients, drop shadows, or divider-heavy framing to make the dashboard feel busier.

## Shapes

The form language is softly practical. Global Fluent buttons use a small `button` radius, text fields are more gently rounded with `input`, the account editor is a modest rounded inset, and the primary paper panel has the most generous radius. Keep controls rectangular and desktop-native; rounded corners communicate containment, not decoration.

## Components

### Buttons

FluentTheme provides the interaction baseline. Buttons use semibold Inter and compact desktop padding. The all-account check-in and save actions use `button-primary`; refresh, add account, and individual check-in retain the neutral Fluent appearance. Removal is text-led `danger`, not a filled red button.

Keyboard focus, disabled state, press state, and validation behavior remain FluentTheme-native. Teal fill must continue to carry the affirmative meaning in every state.

### Sidebar

The sidebar is a fixed evergreen orientation rail. It holds the product name, a short schedule or explanatory block, a muted notice panel, concise navigation-like references, and privacy copy. White is reserved for the product name and key references; the remaining copy steps down through pale aqua tints.

### Dashboard Paper and Metrics

`dashboard-paper` is the dominant container. Its white background and broad radius establish the work area, while its action row keeps the primary operation immediately reachable. Metrics are an unboxed three-column strip: label above value, with teal values and no extra card chrome.

### Account Ledger

The account area is a compact ListBox-backed table with four columns for account type, name, status/message, and credits. Headers use semibold navy. Name and message cells trim rather than widening the panel, and the status binding retains its semantic color from the view model.

### Inputs / Account Editor

`account-editor` is a pale inset within the dashboard paper. It groups the selected account’s name, token field, and related actions. TextBox controls retain FluentTheme behavior with the project-wide input radius. Tokens use password masking and must never be echoed into activity or status copy.

## Do's and Don'ts

### Do:

- **Do** preserve the evergreen sidebar → fog workspace → white paper → pale inset layer sequence.
- **Do** keep the primary all-account operation at the top of the dashboard paper and render it in teal.
- **Do** use navy for headings, blue-gray for explanation, and teal for affirmative emphasis and key values.
- **Do** keep Traditional Chinese operational copy concise, legible, and task-oriented.
- **Do** retain Avalonia FluentTheme behavior for focus, keyboard navigation, text entry, disabled state, and list selection.

### Don't:

- **Don't** return to a dark blue command-center or ledger visual system.
- **Don't** replace the unified white dashboard paper with a generic card grid.
- **Don't** use teal as a decorative wash across rails, backgrounds, or every secondary control.
- **Don't** add shadows, gradients, glass, or excessive borders.
- **Don't** reveal saved tokens or rely on color alone to communicate account status.
