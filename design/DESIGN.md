---
name: RFDeck Engineering System
colors:
  surface: '#131314'
  surface-dim: '#131314'
  surface-bright: '#3a393a'
  surface-container-lowest: '#0e0e0f'
  surface-container-low: '#1c1b1c'
  surface-container: '#201f20'
  surface-container-high: '#2a2a2b'
  surface-container-highest: '#353436'
  on-surface: '#e5e2e3'
  on-surface-variant: '#b9cacb'
  inverse-surface: '#e5e2e3'
  inverse-on-surface: '#313031'
  outline: '#849495'
  outline-variant: '#3b494b'
  surface-tint: '#00dbe9'
  primary: '#dbfcff'
  on-primary: '#00363a'
  primary-container: '#00f0ff'
  on-primary-container: '#006970'
  inverse-primary: '#006970'
  secondary: '#4ae176'
  on-secondary: '#003915'
  secondary-container: '#00b954'
  on-secondary-container: '#004119'
  tertiary: '#fff3ef'
  on-tertiary: '#552100'
  tertiary-container: '#ffcfb8'
  on-tertiary-container: '#9d4300'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#7df4ff'
  primary-fixed-dim: '#00dbe9'
  on-primary-fixed: '#002022'
  on-primary-fixed-variant: '#004f54'
  secondary-fixed: '#6bff8f'
  secondary-fixed-dim: '#4ae176'
  on-secondary-fixed: '#002109'
  on-secondary-fixed-variant: '#005321'
  tertiary-fixed: '#ffdbca'
  tertiary-fixed-dim: '#ffb690'
  on-tertiary-fixed: '#341100'
  on-tertiary-fixed-variant: '#783200'
  background: '#131314'
  on-background: '#e5e2e3'
  surface-variant: '#353436'
typography:
  display-rf:
    fontFamily: JetBrains Mono
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  data-tabular:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 12px
  margin: 16px
  density-compact: 4px 8px
  density-comfortable: 12px 16px
---

## Brand & Style

The design system is engineered for high-stakes, live production environments where split-second decisions are critical. The brand personality is **Modern Engineering**: precise, authoritative, and mission-critical. It prioritizes data density and immediate legibility over decorative elements.

The visual style utilizes a **Refined Technical** approach—a hybrid of Corporate Modern and subtle Glassmorphism. The interface must remain unobtrusive in dim Front of House (FOH) or backstage settings, using a deep-black foundation to minimize light spill while employing high-vibrancy accents to signal system status. The emotional response should be one of absolute control and technical reliability.

## Colors

The palette is optimized for high-contrast monitoring in dark environments. 

- **Foundation:** The base uses a near-perfect black (`#0A0A0B`) to ensure maximum OLED efficiency and zero glare. Elevated surfaces use slightly lighter charcoal tones to create depth.
- **Accents:** 
  - **Primary (Cyan):** Used for active RF signals, focus states, and interactive telemetry.
  - **Success (Green):** Indicates healthy signal-to-noise ratios and full battery.
  - **Warning (Orange):** Highlights frequency interference or low-power states.
  - **Critical (Red):** Reserved for signal dropouts or hardware failure.
- **Intervention:** Use high-vibrancy saturations for data points, but keep container backgrounds neutral to prevent visual fatigue.

## Typography

This design system employs a three-tier typographic strategy:
1. **Geist** for structural headings, providing a clean, technical, and modern appearance.
2. **Inter** for standard UI labels and body text, ensuring maximum readability across varying screen qualities.
3. **JetBrains Mono** for all telemetry, frequency readouts (MHz), and battery percentages. Monospaced characters prevent "jumping" UI during real-time data updates.

**Mobile Scaling:** Headlines scale down by 20% on mobile devices, while data-tabular remains at 13px to maintain technical accuracy.

## Layout & Spacing

The system follows a **Fixed-Grid fluid hybrid** model based on a 4px baseline.
- **Density:** High information density is required. Data tables and telemetry cards should use `density-compact` spacing.
- **Grid:** A 12-column grid is used for desktop monitoring dashboards. On mobile, the system collapses to a single-column stack with 16px side margins.
- **Alignment:** All technical data must be top-aligned within cards to ensure that the most critical "Header" information (Channel Name/Frequency) is visible first when scrolling rapidly.

## Elevation & Depth

Hierarchy is established through **Tonal Layering** and **Glassmorphism**:
- **Level 0 (Base):** Deep black (`#0A0A0B`).
- **Level 1 (Cards/Panels):** Tonal elevation using `#161618` with a 1px solid stroke of `#262629`.
- **Level 2 (Modals/Overlays):** Semi-transparent glass (`rgba(20, 20, 22, 0.8)`) with a high-intensity backdrop-blur (20px).

Avoid ambient shadows; they create "muddy" interfaces in low-light environments. Instead, use **Inner Glows** (0.5px white at 10% opacity) on primary action buttons to simulate hardware light-pipes.

## Shapes

The shape language is **Soft (0.25rem)**, leaning towards a "precision-milled" industrial aesthetic. 
- Standard components (Inputs, Buttons) use 4px corner radii.
- Telemetry cards and larger containers use 8px (`rounded-lg`).
- Status pips and signal strength indicators remain sharp or minimally rounded to maintain a technical "meter" look.

## Components

- **Telemetry Cards:** Must feature a 1px top-border color-coded to status. Include a real-time "Sparkline" or signal bar for RF strength.
- **Data Tables:** High-density, zebra-striped with `rgba(255, 255, 255, 0.02)`. Columns containing frequencies must use `data-tabular` (monospace).
- **Control Toggles:** Large, tactile-style switches. Active states should use the Primary Cyan color with a subtle outer glow to indicate "Power On."
- **Buttons:**
  - *Primary:* Solid Cyan with Black text for visibility.
  - *Secondary:* Ghost style with 1px Neutral-700 border.
  - *Hazard:* Solid Orange or Red with white text.
- **RF Meters:** Vertical segmented bars (10 segments). Segments 1-7 (Green), 8-9 (Orange), 10 (Red/Clip).
- **Input Fields:** Inset appearance with `#050505` background and 1px stroke. Use monospaced font for numeric entry.