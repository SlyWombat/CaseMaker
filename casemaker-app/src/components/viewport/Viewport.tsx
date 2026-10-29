import { useEffect, useLayoutEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { GridFloor } from './GridFloor';
import { SceneMeshes } from './SceneMeshes';
import { EngraveLegend } from './EngraveLegend';
import { RotaryViewControls } from './RotaryViewControls';
import { MachineStatusStrip } from './MachineStatusStrip';
import { SimLegend } from './SimLegend';
import { SimTransport } from './SimTransport';
import { MachineDock } from './MachineDock';
import { ViewportToolbar } from './ViewportToolbar';
import {
  activeSceneBounds,
  shouldReframe,
  VIEWPORT_CAMERA_EVENT,
  type SceneBox,
  type ViewportCameraCommand,
} from './viewportCamera';
import { ensureZUp } from '@/engine/coords';
import { useViewportStore, type ViewportCameraMode } from '@/store/viewportStore';
import { useJobStore } from '@/store/jobStore';
import { isSimSceneActive, useSimStore, type SimState } from '@/store/simStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { jobMachine } from '@/engine/cnc/calibration';
import { machineBedPlate } from '@/engine/cnc/bedPlate';
import { jobVise } from '@/engine/cnc/fixture';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import { pathBounds } from './simGeometry';

ensureZUp();

const isE2E = import.meta.env.VITE_E2E === '1';

const DEFAULT_TARGET: [number, number, number] = [40, 30, 10];

const CAMERA_VIEWS: Record<ViewportCameraMode, { position: [number, number, number]; target: [number, number, number] }> = {
  perspective: { position: [120, -160, 90], target: DEFAULT_TARGET },
  top: { position: [40, 30, 200], target: DEFAULT_TARGET },
  front: { position: [40, -200, 30], target: DEFAULT_TARGET },
  side: { position: [200, 30, 30], target: DEFAULT_TARGET },
};

/**
 * Issue #138 — each preset as a DIRECTION rather than a fixed position.
 *
 * The old table was tuned for a palm-sized board case, so on a 252x250x280 mm
 * rack every preset landed inside the geometry: "Top" showed the middle of a
 * shelf. Distance now comes from the scene's own bounding box, exactly as
 * AutoFrame computes it, so a preset frames whatever is actually loaded.
 */
const VIEW_DIRS: Record<ViewportCameraMode, [number, number, number]> = {
  perspective: [0.5, -1, 0.55],
  top: [0, 0, 1],
  front: [0, -1, 0],
  side: [1, 0, 0],
};

/**
 * The world is z-up and so is the camera — but looking straight DOWN the z
 * axis makes up parallel to the view direction, and lookAt degenerates to an
 * arbitrary roll. That is the second half of why "Top" behaved oddly: not just
 * too close, but pointing at nothing in particular. Give the top view +y as
 * its up instead, so the model's front edge sits at the bottom of the screen.
 */
const VIEW_UP: Record<ViewportCameraMode, [number, number, number]> = {
  perspective: [0, 0, 1],
  top: [0, 1, 0],
  front: [0, 0, 1],
  side: [0, 0, 1],
};

/**
 * How far back a perspective camera must sit to frame `diag` with margin.
 *
 * #761 — BOTH axes: the panel's viewport is often tall and narrow (the rail is ~344 px wide), so a
 * horizontal field computed from the vertical FOV alone crops a wide picture — the Unroll map's
 * 100 mm length is wider than the visible field. The tighter of the two half-angles decides the
 * distance, so the whole of what is on screen fits whichever way the viewport is shaped.
 */
function framingDistance(camera: THREE.PerspectiveCamera, diag: number): number {
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  return (diag / 2 / Math.min(Math.tan(vFov / 2), Math.tan(hFov / 2))) * 1.15;
}

/** The boxes the simulation currently draws: its stock, plus one per fixture obstacle (#204). */
function simBoxesOf(s: SimState): SceneBox[] {
  const boxes: SceneBox[] = [];
  // #716 slice 2 — frame what is ON SCREEN. After Stock | Unroll the delivered frame is the
  // picture (the rod at its checkpoint, or the unrolled map), and the load's own stock mesh is
  // only the final wrapped state; frame that instead wherever a frame has arrived.
  const shown = s.frame?.stock.bbox ?? s.meshes?.stock.bbox ?? null;
  if (shown !== null) {
    boxes.push(shown);
    for (const f of s.meshes?.fixture ?? []) boxes.push(f.mesh.bbox);
  } else if (s.path) {
    const b = pathBounds(s.path);
    if (b) boxes.push(b);
  }
  return boxes;
}

/**
 * The boxes the engrave preview draws (#205): its stock, plus one per vise jaw, plus — #557 — the
 * machine's bed plate, so the camera frames the real machine envelope and the stock reads as
 * sitting WITHIN it rather than floating. An EMPTY list while the preview is still building — so
 * `activeSceneBounds` frames nothing rather than the case, which the engrave branch of
 * `SceneMeshes` is not drawing.
 */
function engraveBoxesOf(preview: EngravePreview | null, bed: SceneBox | null): SceneBox[] {
  if (!preview) return [];
  const boxes: SceneBox[] = [preview.stock.bbox, ...preview.fixture.map((f) => f.mesh.bbox)];
  if (bed) boxes.push(bed);
  return boxes;
}

/** `activeSceneBounds` over the live stores — for the controllers, which read non-reactively. */
function activeSceneBoundsFromStores(): { center: THREE.Vector3; diag: number } | null {
  const sim = useSimStore.getState();
  const simActive = isSimSceneActive(sim);
  // The engrave section owns the viewport exactly when no simulation does (#205); a simulation
  // that is still up keeps the camera, so the two branches can never both be fenced.
  const engraveActive = !simActive && useViewportStore.getState().activeSidebarSection === 'cnc-engrave';
  // #557 — the machine bed plate in the WORK frame, so the camera frames the real envelope. Only
  // computed while the engrave section owns the viewport (the case view frames its own nodes).
  const bedBox: SceneBox | null = engraveActive
    ? (() => {
        const job = useEngraveJobStore.getState().job;
        return machineBedPlate(jobVise(job), job.sacrificial, jobMachine(job, null));
      })()
    : null;
  return activeSceneBounds({
    nodes: useJobStore.getState().nodes,
    simBoxes: simActive ? simBoxesOf(sim) : null,
    engraveBoxes: engraveActive ? engraveBoxesOf(useEngravePreviewStore.getState().preview, bedBox) : null,
  });
}

/**
 * Issue #86 — when the viewport store's cameraMode changes, snap the
 * PerspectiveCamera + OrbitControls target to the canonical view. This
 * runs inside the Canvas so it has access to useThree().
 */
function CameraModeController() {
  const cameraMode = useViewportStore((s) => s.cameraMode);
  const { camera, controls } = useThree() as {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update?: () => void } | null;
  };
  const lastApplied = useRef<ViewportCameraMode | null>(null);
  useEffect(() => {
    // Skip the initial mount — the camera/controls already have their
    // defaults from the JSX, so re-applying perspective on first render
    // would just kick anyone who'd persisted a different mode back to
    // their saved choice without ill effect. Always apply on every
    // change after that.
    if (lastApplied.current === cameraMode) return;
    // Read the scene non-reactively: this must fire when the MODE changes, not
    // every time geometry recompiles, or it would yank the camera back mid-orbit.
    // #197 §6 — the bounds of what is ON SCREEN, so a preset frames the simulation's
    // stock (and vise jaws) rather than a case that is not being drawn.
    const bounds = activeSceneBoundsFromStores();
    camera.up.set(...VIEW_UP[cameraMode]);
    if (bounds) {
      const dir = new THREE.Vector3(...VIEW_DIRS[cameraMode]).normalize();
      camera.position.copy(
        bounds.center.clone().add(dir.multiplyScalar(framingDistance(camera, bounds.diag))),
      );
      if (controls && controls.target) {
        controls.target.copy(bounds.center);
        controls.update?.();
      }
      camera.lookAt(bounds.center);
    } else {
      // Nothing compiled yet — fall back to the fixed table.
      const view = CAMERA_VIEWS[cameraMode];
      camera.position.set(...view.position);
      if (controls && controls.target) {
        controls.target.set(...view.target);
        controls.update?.();
      }
      camera.lookAt(...view.target);
    }
    lastApplied.current = cameraMode;
  }, [cameraMode, camera, controls]);
  return null;
}

/**
 * Auto-frame the camera when the scene's overall size changes substantially
 * (loading a template, switching archetype, a big resize). The default
 * camera comfortably frames a ~150 mm board case; a 280 mm rack or the
 * 200 mm box fills the screen edge-to-edge. Deliberately does NOT re-frame
 * on small size changes so it never fights the user's own orbiting.
 */
function AutoFrame() {
  const nodes = useJobStore((s) => s.nodes);
  // One identity per LOAD of a program (#197 §5): `meshes` is replaced by a load and never by a
  // scrub, and a path-only session's `path` is the equivalent. `step` is deliberately not read,
  // so scrubbing never re-frames.
  const simSolids = useSimStore((s) => (isSimSceneActive(s) ? s.meshes ?? s.path : null));
  // #205 — the engrave preview. Its object identity changes on EVERY rebuild (one per keystroke),
  // so it is deliberately NOT the identity below: only opening/closing the section, and the first
  // preview arriving, count as a change of what is on screen. Re-framing on each rebuild would
  // yank the camera out from under the user mid-typing.
  const engraveSection = useViewportStore((s) => s.activeSidebarSection === 'cnc-engrave');
  const engravePreview = useEngravePreviewStore((s) => s.preview);
  const engraveScene = engraveSection ? (engravePreview ? 'engrave-ready' : 'engrave-pending') : null;
  const { camera, controls } = useThree() as {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update?: () => void } | null;
  };
  const lastDiag = useRef(0);
  const lastSimSolids = useRef<unknown>(null);
  const lastEngraveScene = useRef<string | null>(null);
  useEffect(() => {
    // A LOAD of a program, the END of a simulation, and the engrave section opening (or its
    // first preview arriving) all change what is on screen and are framed once whatever the
    // size: the size rule alone would skip a stock whose diagonal happens to be close to the
    // case's — exactly the "nothing happened when I loaded the file" bug when entering, and, on
    // close, the case's own diagonal can pass the rule while the case sits somewhere else in the
    // work frame, leaving the camera looking at nothing (#197 review).
    const forced =
      simSolids !== lastSimSolids.current || engraveScene !== lastEngraveScene.current;
    lastSimSolids.current = simSolids;
    lastEngraveScene.current = engraveScene;
    // Same bbox and same framing maths the presets use (issue #138), so the
    // two can never drift into disagreeing about where the model is.
    const bounds = activeSceneBoundsFromStores();
    if (!bounds) return;
    const { center, diag } = bounds;
    // Re-frame on a forced transition, or on a substantial size change (>35% either way).
    if (!shouldReframe(lastDiag.current, diag, forced)) return;
    lastDiag.current = diag;
    // Keep the canonical perspective direction; just move out far enough.
    const dir = new THREE.Vector3(...VIEW_DIRS.perspective).normalize();
    camera.position.copy(center.clone().add(dir.multiplyScalar(framingDistance(camera, diag))));
    if (controls && controls.target) {
      controls.target.copy(center);
      controls.update?.();
    }
    camera.lookAt(center);
  }, [nodes, simSolids, engraveScene, camera, controls]);
  return null;
}

/**
 * #361 — publish the toolbar's BOTTOM EDGE, so the corner legends can clear it instead of sitting
 * on top of it.
 *
 * The toolbar WRAPS (`flexWrap: 'wrap'` in `ViewportToolbar`), so its height is one row at 1440 and
 * three at 1024 in the rail layout: no static `top` clears it at every width, and at 1024 the
 * engrave depth legend covered "Fit" and cut "Side" to "Si" — the legend is `pointer-events: none`,
 * so the buttons still took clicks, but they could not be READ.
 *
 * The BOTTOM EDGE, not the height: the toolbar also sits at `top: var(--cm-space-3)`, so a height
 * alone leaves the legends a `--cm-space-3` short of clearing it — `top: calc(h + 8px)` at one row
 * puts the legend 4 px INTO the toolbar's box. Measured from the wrapper (position: relative, no
 * padding or border, so the rect difference is the offset within it) it needs no knowledge of the
 * toolbar's own `top`, and would still be right if that changed.
 *
 * Written as a CSS variable on the wrapper, never React state: this runs on every resize and a
 * state update would re-render the subtree containing `<Canvas>`. The legends read it as
 * `calc(var(--cm-viewport-toolbar-bottom, 0px) + 8px)`, so with no measurement at all — jsdom,
 * which has neither layout nor `ResizeObserver` — they fall back to exactly today's `top: 8px`.
 */
const TOOLBAR_BOTTOM_VAR = '--cm-viewport-toolbar-bottom';

function useToolbarBottom(wrapper: React.RefObject<HTMLDivElement | null>, toolbar: React.RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const host = wrapper.current;
    const el = toolbar.current;
    if (!host || !el || typeof ResizeObserver === 'undefined') return;
    const publish = (): void => {
      const bottom = el.getBoundingClientRect().bottom - host.getBoundingClientRect().top;
      host.style.setProperty(TOOLBAR_BOTTOM_VAR, `${Math.round(bottom)}px`);
    };
    publish();
    // What changes the edge: the pane's WIDTH (the toolbar wraps), and the LAYER group appearing
    // when a CNC section opens. The observer sees both without a resize listener.
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty(TOOLBAR_BOTTOM_VAR);
    };
  }, [wrapper, toolbar]);
}

/** How much one Zoom click changes the camera's distance to the orbit target (#197 §7). */
const ZOOM_FACTOR = 1.25;

type OrbitControlsLike = {
  target: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  update?: () => void;
};

/**
 * Issue #197 §7 — Zoom in / Zoom out / Fit. The buttons live on `ViewportToolbar`, OUTSIDE the
 * Canvas, so they reach the camera through a window event: the stores hold no three objects, and
 * this keeps every piece of camera maths (presets, framing, zoom) in one file.
 */
/**
 * #761 — STOCK | UNROLL CHANGES WHAT IS ON SCREEN, and the new design's frame arrives a beat after
 * the switch. The preset and AutoFrame controllers fire on their own events, so without this the
 * camera stays where the OTHER view's bounds put it: the map's first picture is a corner of the
 * rod's box, not the opened surface. Frame once per switch, on the first frame of the design now
 * shown, keeping the view direction the user is in (Fit's rule).
 */
function DesignReframe() {
  const design = useSimStore((s) => s.design);
  const frameDesign = useSimStore((s) => s.frame?.design ?? null);
  const cameraMode = useViewportStore((s) => s.cameraMode);
  const { camera, controls } = useThree() as {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update?: () => void } | null;
  };
  // The design already framed at mount: a load's first frame is AutoFrame's, not this effect's.
  const framedFor = useRef(design);
  useEffect(() => {
    if (frameDesign === null || frameDesign !== design) return;
    if (framedFor.current === design) return;
    framedFor.current = design;
    const bounds = activeSceneBoundsFromStores();
    if (!bounds || !controls || !controls.target) return;
    // The MODE's canonical direction, not wherever the camera happens to be: the frame can arrive
    // before or after a preset click, and the switch must leave the chosen view framed either way.
    camera.up.set(...VIEW_UP[cameraMode]);
    const dir = new THREE.Vector3(...VIEW_DIRS[cameraMode]).normalize();
    camera.position.copy(bounds.center.clone().add(dir.multiplyScalar(framingDistance(camera, bounds.diag))));
    controls.target.copy(bounds.center);
    camera.lookAt(bounds.center);
    controls.update?.();
  }, [design, frameDesign, cameraMode, camera, controls]);
  return null;
}

function ViewportCameraController() {
  const { camera, controls } = useThree() as {
    camera: THREE.PerspectiveCamera;
    controls: OrbitControlsLike | null;
  };
  useEffect(() => {
    const onCommand = (e: Event) => {
      const command = (e as CustomEvent<ViewportCameraCommand>).detail;
      if (!controls || !controls.target) return;
      const target = controls.target;
      const dir = camera.position.clone().sub(target);
      const dist = dir.length();
      if (dist < 1e-9) return;
      dir.divideScalar(dist); // unit vector: from the target out to the camera
      if (command === 'fit') {
        const bounds = activeSceneBoundsFromStores();
        if (!bounds) return;
        // Fit keeps the view DIRECTION and re-runs the framing maths on what is on screen.
        camera.position.copy(
          bounds.center.clone().add(dir.multiplyScalar(framingDistance(camera, bounds.diag))),
        );
        target.copy(bounds.center);
        camera.lookAt(bounds.center);
        controls.update?.();
        return;
      }
      const factor = command === 'zoom-in' ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
      const next = THREE.MathUtils.clamp(
        dist * factor,
        controls.minDistance,
        controls.maxDistance,
      );
      camera.position.copy(target).addScaledVector(dir, next);
      controls.update?.();
    };
    window.addEventListener(VIEWPORT_CAMERA_EVENT, onCommand);
    return () => window.removeEventListener(VIEWPORT_CAMERA_EVENT, onCommand);
  }, [camera, controls]);
  return null;
}

/**
 * Issue #355 — an orbit drag that leaves the canvas must not select the panels beside it.
 *
 * `OrbitControls` takes the pointer on the canvas and captures it, but it never calls
 * `preventDefault`, so the browser's own drag-to-select runs alongside the orbit: pull the scene
 * left across the Context panel and the paragraph under the pointer, and every button in its way,
 * comes back highlighted and filled in blue. `user-select: none` on the document for the DURATION
 * of the drag stops the selection starting; the first `pointerup`, `pointercancel` or `blur` after
 * it clears the rule again, so a release the window never sees (a pointer captured and let go
 * outside) cannot leave the app unselectable.
 *
 * The rule is applied only for a press that BEGAN on the canvas — the toolbar, the legends and the
 * transport live inside the same wrapper and have their own hit-testing to worry about.
 */
function useNoSelectWhileOrbiting(): (e: React.PointerEvent) => void {
  useEffect(() => {
    const root = document.documentElement;
    const clear = (): void => {
      root.style.userSelect = '';
    };
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointerup', clear);
      window.removeEventListener('pointercancel', clear);
      window.removeEventListener('blur', clear);
      clear();
    };
  }, []);
  return (e: React.PointerEvent) => {
    if (e.target instanceof HTMLCanvasElement) document.documentElement.style.userSelect = 'none';
  };
}

export function Viewport() {
  // The grid's plane is z = 0 — the stock's TOP face in the work frame — so it would slice
  // through the middle of the simulation's stock, and z-fight the engrave preview's top face,
  // which sits at exactly z = 0 too. Hidden while either CNC view owns the viewport (#197, #205).
  const simActive = useSimStore(isSimSceneActive);
  const engraveActive = useViewportStore((s) => s.activeSidebarSection === 'cnc-engrave');
  const onPointerDown = useNoSelectWhileOrbiting();
  // #361 — the wrapper the legends are anchored to, and the toolbar whose height they have to clear.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useToolbarBottom(wrapperRef, toolbarRef);
  return (
    <div
      ref={wrapperRef}
      className="viewport-wrapper"
      onPointerDown={onPointerDown}
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <ViewportToolbar ref={toolbarRef} />
      {/* The canvas and its overlays flex to fill the space above the status strip and the dock,
          so those two bands stack at the bottom instead of overlapping the canvas (#528). */}
      <div style={{ position: 'relative', flex: '1 1 0', minHeight: 0 }}>
        <Canvas
          gl={{ antialias: !isE2E, preserveDrawingBuffer: true }}
          dpr={isE2E ? 1 : window.devicePixelRatio}
          flat={isE2E}
          onCreated={({ scene }) => {
            scene.up = new THREE.Vector3(0, 0, 1);
          }}
          // Issue #83 — clicking empty canvas (no scene object hit) clears
          // any active selection. Only fires while the Select tool is on so
          // we don't fight Orbit/Pan tool drag-clicks.
          onPointerMissed={() => {
            const { activeTool, setSelection } = useViewportStore.getState();
            if (activeTool === 'select') setSelection(null);
          }}
          data-testid="viewport-canvas"
        >
          <PerspectiveCamera makeDefault position={[120, -160, 90]} fov={45} up={[0, 0, 1]} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[100, -100, 200]} intensity={0.8} />
          <directionalLight position={[-100, 100, 100]} intensity={0.3} />
          <OrbitControls
            target={DEFAULT_TARGET}
            enableDamping={!isE2E}
            makeDefault
          />
          <CameraModeController />
          <AutoFrame />
          <DesignReframe />
          <ViewportCameraController />
          {!simActive && !engraveActive && <GridFloor />}
          <SceneMeshes />
        </Canvas>
        {/* #349 — the engrave depth legend rides over the canvas as DOM, like the transport, rather
            than being projected from the scene origin. It renders itself null with no preview.
            Gated on the SCENE, not just the section: opening the Engrave section does not take the
            viewport from a loaded simulation (`SceneMeshes`, and `activeSceneBounds` above), so the
            depth legend must not paint over a scene it does not describe — as DOM it did not follow
            the scene the way it did while it lived inside `EngravePreview` (review of ebf38c5). */}
        {engraveActive && !simActive && <EngraveLegend />}
        {/* #716 — a rotary job's Map | Stock switch and its ⌀/around read-out, beside the legend.
            Null for a flat job, so the flat preview's chrome is unchanged. */}
        {engraveActive && !simActive && <RotaryViewControls />}
        {/* #349 — the simulation's sacrificial swatch, the same move. */}
        {simActive && <SimLegend />}
        {/* #198 — the transport rides over the bottom of the canvas while a simulation owns the
            scene. It renders itself null otherwise, so no guard is needed here. */}
        <SimTransport />
      </div>
      {/* #526 — the live machine in one line under the viewport whenever a machine is remembered.
          It renders itself null until machineStore carries a machine, so no guard is needed here. */}
      <MachineStatusStrip />
      {/* #528 — the dock band under the viewport for what the machine said. Renders itself null
          until there is transcript content. */}
      <MachineDock />
    </div>
  );
}
