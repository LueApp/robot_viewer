![screenshot](./docs/screenshot.png)

---

# Robot Viewer

[![Version](https://img.shields.io/badge/version-v1.3.0-blue.svg)](https://github.com/fan-ziqi/robot_viewer)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-orange.svg)](https://github.com/fan-ziqi/robot_viewer)
[![JavaScript](https://img.shields.io/badge/language-JavaScript-f1e05a.svg)](https://github.com/fan-ziqi/robot_viewer)
[![Three.js](https://img.shields.io/badge/Three.js-0.163.0-black.svg)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-4.5.0-646cff.svg)](https://vitejs.dev/)
[![Demo](https://img.shields.io/badge/Demo-Live-brightgreen.svg)](http://viewer.robotsfan.com/)

**Robot Viewer** is a web-based 3D viewer for robot models and scenes. Built on top of [Three.js](https://threejs.org/), it provides an intuitive interface for visualizing, editing, and simulating robots directly in the browser without any installation required. This tool helps you visualize and analyze robot structures, joints, and physical properties.

**Live Demo** (All processing happens in your browser - your models never leave your device):

[![Try it now](https://img.shields.io/badge/🌐_Try_it_now-viewer.robotsfan.com-brightgreen?style=for-the-badge)](http://viewer.robotsfan.com/)

## Key Features

- **Format Support**:
  - **URDF**: Unified Robot Description Format
  - **Xacro**: ROS Xacro format with macro expansion and conditional logic support
  - **MJCF**: Mujoco XML format
  - **USD**: Universal Scene Description (partial support)
- **Robot Types**: Serial robot structures (parallel robots not currently supported)
- **Visualization Tools**: Visual/collision geometry, inertia tensors, center of mass, coordinate frames, joint axes, shadows, ground grid visibility, coordinate system orientation
- **Interactive Controls**: Drag joints in real-time, adjust model poses
- **Animation Editor (Experimental)**: Multi-clip dope sheet and Bézier graph editor with auto-key, multi-selection, undo/redo, play/record ranges, event and media tracks, pose snapshots, audio-reactive keys, live-input recording, autosave, and portable `.robotanim.json` projects
- **Measurement Tools**: Measure distances between joints and links with 3D visualization, display X/Y/Z axis projections and total distance, support ground height measurement
- **Code Editor**: Built-in CodeMirror editor with syntax highlighting and live preview
- **Structured URDF Editing**: Move, rotate, scale, or mirror individual visual/collision meshes; edit joint frames or motion axes with optional limit reversal and automatic preview reload
- **Physics Simulation**: Integrated MuJoCo engine for dynamics simulation (MJCF models)
- **Scene Management**: File tree and scene graph visualization with hierarchical structure

## Getting Started

This project uses **pnpm**, but you can also use **npm** or **yarn**.

Clone the repository and install dependencies:

```bash
git clone https://github.com/fan-ziqi/robot_viewer.git
cd robot_viewer
pnpm install
```

Start the development server:

```bash
pnpm run dev
```

Build for production:

```bash
pnpm run build
```

Output will be in the `dist/` directory.

To try structured URDF editing without external assets, load the
[`public/examples`](public/examples) folder and select
`urdf-transform-demo.urdf`.

## Live simulator display

The **Live simulation** panel connects to a protocol-independent state stream,
such as the sibling Behavior Sim runtime at `ws://localhost:8766/state`.
Load [`behavior-sim.urdf`](public/examples/behavior-sim.urdf) to use its two-motor
example. The stream carries named joint positions in radians/meters, simulation
time, session/sequence identifiers, optional base pose and device diagnostics.

Matching joint names map automatically. The panel supports explicit mappings,
connection/stale-state diagnostics, target and measurement inspection, segmented
motion recording, JSON import/export, replay and creation of editable animation
clips. Live mode pauses competing animation/local physics and locks joint editing.
Camera controls remain available. Disconnect keeps the last pose; **Return to
local mode** explicitly unlocks editing. Out-of-limit telemetry is displayed with
a diagnostic instead of silently clamped.

The viewer is observational: it never sends motor commands. Closing it does not
stop the simulator. It records the visualization snapshots it receives, not every
controller cycle. Robot model assets remain loaded through the existing file UI.
See `behavior-sim/spec/common-api.md` for the stream and coordinate conventions.

### Create an animation clip from recorded motion

1. Load the matching robot model and connect **Live simulation**.
2. Click **Record motion**, let the simulator run for a few seconds, then click
   **Stop recording**. The nearby indicator shows captured snapshot/segment counts.
3. Select the recorded segment. Alternatively, open a previously exported
   `.robotlive.json` file and select a segment from it.
4. Click **Create animation clip**. This creates an editable copy named
   **Recorded simulation**, selects it, opens the **Animation Editor**, and moves
   its playhead to the beginning. The live viewer connection is disconnected.
5. Press **▶ Play** in the Animation Editor or edit the timeline keyframes.

This operation creates a clip from an existing recording; it does not start
recording or download a file. Use **Export recording** to save the original
capture, or the Animation Editor's project export to save editable clips. The
original capture is retained in memory. Empty, zero-duration or unmapped captures
produce an actionable message instead of an empty clip.

## Contributing

We welcome contributions from the community! Whether you're fixing bugs, adding features, or improving documentation, your help is appreciated.

- **Bug Reports**: Open an [issue](https://github.com/fan-ziqi/robot_viewer/issues) with details
- **Feature Requests**: Discuss ideas in [Discussions](https://github.com/fan-ziqi/robot_viewer/discussions)
- **Pull Requests**: Submit PRs with clear descriptions and tests

## License

This project is licensed under the [Apache License 2.0](LICENSE).

## Acknowledgements

Robot Viewer builds upon the excellent work of the open-source robotics community. This project integrates several powerful open-source projects:

- **[urdf-loader](https://github.com/gkjohnson/urdf-loaders)** - Robust URDF loading for Three.js
- **[xacro-parser](https://github.com/gkjohnson/xacro-parser)** - ROS Xacro file format parser for Javascript
- **[mujoco_wasm](https://github.com/zalo/mujoco_wasm)** - MuJoCo physics engine compiled to WebAssembly
- **[usd-viewer](https://github.com/needle-tools/usd-viewer)** - OpenUSD viewer with rich USDStage support
- **[mechaverse](https://github.com/jurmy24/mechaverse)** - Universal 3D viewer for robot models, providing valuable design inspiration

Special thanks to all the maintainers and contributors of these projects for their foundational work.

Parts of this project were developed with the assistance of [Cursor](https://cursor.sh).
