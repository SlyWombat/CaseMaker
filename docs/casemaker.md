# CaseSmith: Parametric 3D Printed Enclosure Designer

CaseSmith is a web-based Single Page Application (SPA) designed to automate the creation of custom 3D-printable enclosures for microcontrollers and single-board computers (SBCs). It allows users to visualize components, place mounting points, and generate production-ready `.3mf` or `.stl` files.

## 1. Core Architecture
The application is structured as a modular web application to avoid monolithic file issues and ensure scalability.

- **Frontend:** React or Vue.js (SPA Framework)
- **3D Engine:** Three.js for real-time visualization and component manipulation.
- **Geometry Engine:** OpenCascade.js or Manifold (WebAssembly) for robust CSG (Constructive Solid Geometry) operations.
- **State Management:** Redux or Pinia to handle the Board Library and Case Parameters.

## 2. Key Features

### A. Board Library & HAT Support
- **Predefined Profiles:** Integrated library for ESP32 (DevKit V1, WROOM), Arduino (Uno, Nano, GIGA R1), and Raspberry Pi (4, 5, Zero 2W).
- **Custom Board Definition:** Users can define custom PCB dimensions, hole spacing, and height.
- **Vertical Expansion:** Configurable "Z-Clearance" to accommodate HATs, shields, or bulky components like capacitors and heatsinks.

### B. Parametric Case Design
- **Mounting Bosses:** Auto-generation of screw pillars based on the selected board profile.
- **Wall Thickness:** Global parameter for structural integrity.
- **Joint Types:** Options for snap-fit lids, sliding lids, or screw-down tops.

### C. IO & Port Management
- **Smart Cutouts:** Drag-and-drop port placements for:
  - Power (Barrel Jack, USB-C)
  - Data (USB-B, Micro-USB)
  - Display (HDMI, Micro-HDMI)
- **External Asset Support:** Ability to load existing `.stl` or `.3mf` meshes to visualize how the board fits within an existing mechanical assembly.

## 3. Technical Implementation Strategy

### Directory Structure
```text
/casesmith-app
├── /public            # Static assets (icons, environment maps)
├── /src
│   ├── /components    # UI Components (Sidebar, Toolbar, 3D Canvas)
│   ├── /library       # JSON definitions for boards (ESP32, Pi, etc.)
│   ├── /engine        # Three.js wrappers and Geometry logic
│   ├── /store         # State management for parametric values
│   ├── /utils         # Export logic (STL/3MF exporters)
│   └── App.js         # Main Entry Point
├── package.json
└── vite.config.js