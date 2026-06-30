# Design System: Industrial Parametric UI

## 1. Vision & Principles
The "Industrial Parametric UI" is designed for precision, clarity, and a "high-tech workshop" aesthetic. It prioritizes data density and functional clarity, using a dark, low-contrast foundation with high-contrast accents (Blue-500) for primary actions and focus states.

*   **Precision:** Use fixed-width fonts for numeric data and clear, geometric iconography.
*   **Depth:** Use subtle borders and shadow-based "layers" rather than heavy gradients to define hierarchy.
*   **Response:** All interactive elements should have immediate, subtle feedback (scale changes or background shifts).

---

## 2. Design Tokens (Tailwind CSS Based)

### Colors
*   **Primary:** `#3B82F6` (Blue-500)
*   **Background (Deep):** `#0b1326` (Surface)
*   **Background (Container):** `#131b2e` (Surface-Container-Low)
*   **Border/Stroke:** `#31394d` (Surface-Bright) or `zinc-800` for subtle separation.
*   **Text (Primary):** `#f4f4f5` (Zinc-100)
*   **Text (Secondary):** `#a1a1aa` (Zinc-400)
*   **Status/Success:** `#10b981` (Emerald-500) - Used for "Valid" or "Ready" states.

### Typography
*   **Font Family:** `'Space Grotesk'`, sans-serif.
*   **Scale:**
    *   **H1:** `text-2xl font-bold tracking-tight`
    *   **H2:** `text-lg font-semibold tracking-wide uppercase`
    *   **Body:** `text-sm font-normal`
    *   **Mono/Data:** `font-mono text-xs tracking-tighter` (Use for dimensions and coordinates).

### Shape & Spacing
*   **Roundness:** `4px` (Rounded-sm/base)
*   **Base Unit:** `4px` (All spacing should be multiples of 4).
*   **Borders:** `1px` solid, typically using `zinc-800` or `zinc-700`.

---

## 3. Core Components

### Top Navigation Bar
*   **Height:** `48px`
*   **Styles:** `bg-zinc-900 border-b border-zinc-800 flex items-center px-4`
*   **Brand:** `text-lg font-bold tracking-tighter text-zinc-100`

### Sidebar (Navigation/Status)
*   **Width:** `280px`
*   **Styles:** `bg-zinc-900 border-r border-zinc-800 flex flex-col`
*   **Active State:** `text-blue-500 border-l-2 border-blue-500 bg-zinc-800/50`

### Control Panels (Right Side)
*   **Width:** `320px`
*   **Styles:** `bg-[#0b1326]/80 backdrop-blur-md border-l border-zinc-800`
*   **Inputs:** `bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-right font-mono`

---

## 4. Interaction Patterns
*   **Buttons:** Standard padding `px-4 py-2`. Hover state should shift background brightness or border color.
*   **Sliders:** Track should be `zinc-700`, thumb should be `blue-500`.
*   **Toggles:** Custom switch component with `blue-500` for ON state.

---

## 5. Layout Structure
The application follows a three-panel workbench layout:
1.  **Global Header:** Fixed at the top.
2.  **Left Sidebar:** Project navigation and secondary utilities (Fixed).
3.  **Central Viewport:** The 3D Canvas (Liquid/Flexible).
4.  **Right Panel:** Contextual controls and parameters (Fixed).
