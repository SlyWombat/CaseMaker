---
name: Industrial Parametric UI
colors:
  surface: '#0b1326'
  surface-dim: '#0b1326'
  surface-bright: '#31394d'
  surface-container-lowest: '#060e20'
  surface-container-low: '#131b2e'
  surface-container: '#171f33'
  surface-container-high: '#222a3d'
  surface-container-highest: '#2d3449'
  on-surface: '#dae2fd'
  on-surface-variant: '#c2c6d6'
  inverse-surface: '#dae2fd'
  inverse-on-surface: '#283044'
  outline: '#8c909f'
  outline-variant: '#424754'
  surface-tint: '#adc6ff'
  primary: '#adc6ff'
  on-primary: '#002e6a'
  primary-container: '#4d8eff'
  on-primary-container: '#00285d'
  inverse-primary: '#005ac2'
  secondary: '#4edea3'
  on-secondary: '#003824'
  secondary-container: '#00a572'
  on-secondary-container: '#00311f'
  tertiary: '#ffb786'
  on-tertiary: '#502400'
  tertiary-container: '#df7412'
  on-tertiary-container: '#461f00'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a42'
  on-primary-fixed-variant: '#004395'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#ffdcc6'
  tertiary-fixed-dim: '#ffb786'
  on-tertiary-fixed: '#311400'
  on-tertiary-fixed-variant: '#723600'
  background: '#0b1326'
  on-background: '#dae2fd'
  surface-variant: '#2d3449'
typography:
  h1:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  h2:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '500'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: '0'
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
    letterSpacing: '0'
  label-mono:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1.4'
    letterSpacing: 0.05em
  code-value:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: '0'
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 12px
  panel-padding: 20px
---

## Brand & Style
The design system is engineered for precision and utility, catering to engineers, makers, and product designers. The aesthetic is rooted in **Industrial Minimalism**, prioritizing information density and functional clarity over decorative flair. 

The emotional response should be one of "Digital Craftsmanship"—the interface should feel like a high-end CAD workstation or a precision measuring tool. It employs a dark-mode-first approach to reduce eye strain during long modeling sessions. Visual hierarchy is established through structural alignment and subtle tonal shifts rather than vibrant colors, creating an environment where the user's 3D work remains the focal point.

## Colors
This design system utilizes a "Coal and Steel" palette. The core is built on a range of deep, cool-toned grays and slates that provide a stable, low-glare foundation. 

- **Primary Accent:** A focused blue used sparingly for active states, primary actions, and selection highlights.
- **Surface Strategy:** We use a stepped-neutral approach. The background is the darkest value, with interface panels and cards lifting slightly in brightness to create structure without the need for heavy shadows.
- **Functional Accents:** Green, amber, and red are reserved strictly for status indicators (success, warning, error) to maintain the technical, high-utility feel.

## Typography
Typography in this design system is split between two roles: **Expression** and **Data**.

- **Headlines (Space Grotesk):** Provides a technical, geometric flair. The subtle quirks of the typeface suggest a futuristic, engineered quality.
- **Body & Controls (Inter):** Used for maximum legibility in dense control panels. It is highly readable at small sizes, which is critical for parameter labels and numeric inputs.
- **Utility Labels:** Small, semi-bold, uppercase labels are used for headers within sidebars to distinguish metadata from editable values.

## Layout & Spacing
The design system follows a **Fixed-Fluid Hybrid** model. The main viewport for the 3D tool is fluid, expanding to fill available space, while control sidebars are fixed-width (typically 280px or 320px) to ensure consistent interaction targets.

A strict 4px base unit grid governs all spacing. 
- **Density:** High. Components are packed tightly to minimize mouse travel, reflecting the "pro-tool" nature of the application.
- **Alignment:** All elements should align to the left vertical axis within panels to create a clear "scan line" for the user.

## Elevation & Depth
Depth is communicated through **Tonal Layering** and **Low-Contrast Outlines**. 

- **Level 0 (Background):** The deepest layer, usually the workspace background.
- **Level 1 (Panels):** Sidebars and toolbars use a slightly lighter gray than the background.
- **Level 2 (Modals/Overlays):** These use a 1px solid border (`border-muted`) to distinguish them from the base panels. 
- **Shadows:** Avoid large, fuzzy shadows. Instead, use a very tight, 2px "ink shadow" with 40% opacity to suggest a slight lift for interactive elements like dropdowns or tooltips.

## Shapes
In line with the industrial theme, the design system uses a **Soft-Square** approach. A 4px (`0.25rem`) corner radius is applied to buttons, input fields, and panels. This provides a modern polish without appearing "bubbly" or consumer-grade. Primary containers and larger cards may use an 8px radius, but never beyond that.

## Components
- **Buttons:** Use a solid, matte finish. Primary buttons use the `primary_color_hex` with white text. Secondary buttons use a "Ghost" style: a subtle border that brightens on hover.
- **Input Fields:** Designed as "Parameter Blocks." Labels are placed inside the top-left of the border or directly above in `label-mono`. Numeric inputs should feature prominent +/- or chevron controls for rapid adjustment.
- **Chips/Badges:** Small, rectangular with `rounded-sm`. Used for tags like "Beta," "New," or active material types.
- **Cards/List Items:** Items in a list (like board templates) should have a subtle hover state that shifts the background color by 2-3%.
- **Breadcrumbs & Toolbars:** Icon-heavy with tooltips. Icons should be 1.5pt stroke weight to match the "clean and technical" typography.
- **The Parametric Slider:** A custom component featuring a track, a 4px wide thumb, and a persistent numeric readout.