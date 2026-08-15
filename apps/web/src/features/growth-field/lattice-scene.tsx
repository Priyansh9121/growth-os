'use client';

/**
 * The Growth Lattice — WebGL scene.
 *
 * ARCHITECTURAL RESPONSIBILITY
 * Renders the living growth-loop graph behind the login, and performs the
 * convergence that carries a user into the dashboard.
 *
 * PERFORMANCE ENVELOPE (enforced, not aspirational — see 3d-system.md §3)
 *   - 4 draw calls: instanced nodes, edge lines, signal points, depth points
 *   - < 10,000 triangles (nodes are detail-0 icosahedra: 20 faces each)
 *   - zero textures — no decode, no memory, no network
 *   - DPR capped at 1.75; fill-rate cost is quadratic above that
 *   - the frame loop stops when the tab is hidden
 *   - every geometry and material is disposed on unmount
 *
 * This module is loaded only via `next/dynamic({ ssr: false })` from the host,
 * so three.js is never in the initial bundle and authentication never waits on
 * it.
 *
 * @see docs/design/3d-system.md
 * @see docs/decisions/ADR-0007-3d-stack.md
 */

import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  buildDepthField,
  buildEdgePositions,
  CONVERGENCE_TARGETS,
  createRandom,
  LATTICE_CHORDS,
  LATTICE_EDGES,
  LATTICE_NODES,
  readPalette,
  SIGNALS_PER_EDGE,
  smoothstep,
} from './lattice-geometry';

interface SceneProps {
  /** 0 = at rest, 1 = fully converged into the mark. */
  readonly convergenceTarget: number;
  /** Raised briefly while credentials are being verified. */
  readonly activity: number;
  readonly onConverged?: (() => void) | undefined;
}

/** Seconds the convergence takes. Matches `--duration-threshold` (720ms). */
const CONVERGENCE_SECONDS = 0.72;

/** Maximum pointer-driven camera offset, in scene units (≈2.5° of rotation). */
const PARALLAX_RANGE = 0.35;

/** Critically-damped follow factor for the pointer. Low enough to feel like inertia. */
const PARALLAX_DAMPING = 0.045;

function LatticeContent({ convergenceTarget, activity, onConverged }: SceneProps) {
  const { camera, invalidate } = useThree();

  const nodesRef = useRef<THREE.InstancedMesh>(null);
  const edgesRef = useRef<THREE.LineSegments>(null);
  const signalsRef = useRef<THREE.Points>(null);

  /** Current eased convergence, lerped toward `convergenceTarget` each frame. */
  const progressRef = useRef(0);
  const convergedNotifiedRef = useRef(false);
  const pointerRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0 });

  const palette = useMemo(() => readPalette(), []);

  const signalColor = useMemo(() => new THREE.Color(palette.signal), [palette.signal]);
  const dimColor = useMemo(() => new THREE.Color(palette.signalDim), [palette.signalDim]);

  const allEdges = useMemo(() => [...LATTICE_EDGES, ...LATTICE_CHORDS], []);

  // ---------------------------------------------------------------------------
  // Static buffers. Built once; positions are mutated in place during
  // convergence rather than reallocated per frame.
  // ---------------------------------------------------------------------------
  const edgeGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(buildEdgePositions(LATTICE_NODES, allEdges), 3),
    );
    return geometry;
  }, [allEdges]);

  const depthGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buildDepthField(), 3));
    return geometry;
  }, []);

  /**
   * Signal pulses: one point per (edge × SIGNALS_PER_EDGE), each carrying a
   * phase offset so they are distributed along their edge rather than moving
   * in lockstep. Positions are recomputed on the CPU each frame — with ~30
   * points that is negligible, and it avoids a custom shader whose correctness
   * would be harder to verify.
   */
  const signalPhases = useMemo(() => {
    const random = createRandom(0x5eed);
    return Array.from({ length: allEdges.length * SIGNALS_PER_EDGE }, () => random());
  }, [allEdges.length]);

  const signalGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(signalPhases.length * 3), 3),
    );
    return geometry;
  }, [signalPhases.length]);

  // Instance transforms for the node mesh.
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    const mesh = nodesRef.current;
    if (!mesh) return;

    LATTICE_NODES.forEach((node, index) => {
      dummy.position.set(...node.position);
      dummy.scale.setScalar(0.09 + node.weight * 0.07);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, dimColor.clone().lerp(signalColor, node.weight));
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [dummy, dimColor, signalColor]);

  // ---------------------------------------------------------------------------
  // Pointer parallax.
  //
  // Bound to the window rather than the canvas: the canvas sits behind the
  // login card with `pointer-events: none`, so it never receives events itself.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      pointerRef.current.targetX = (event.clientX / window.innerWidth - 0.5) * 2;
      pointerRef.current.targetY = (event.clientY / window.innerHeight - 0.5) * 2;
      invalidate();
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, [invalidate]);

  // ---------------------------------------------------------------------------
  // Frame loop.
  // ---------------------------------------------------------------------------
  useFrame((state, delta) => {
    // Clamp delta: after a tab has been backgrounded the first delta can be
    // seconds long, which would snap every animation to its end state.
    const dt = Math.min(delta, 0.05);
    const time = state.clock.elapsedTime;

    // Convergence, eased.
    const previous = progressRef.current;
    const step = dt / CONVERGENCE_SECONDS;
    progressRef.current =
      convergenceTarget > previous
        ? Math.min(convergenceTarget, previous + step)
        : Math.max(convergenceTarget, previous - step);

    const progress = smoothstep(progressRef.current);

    if (!convergedNotifiedRef.current && convergenceTarget === 1 && progressRef.current >= 1) {
      convergedNotifiedRef.current = true;
      onConverged?.();
    }

    // Pointer parallax + camera push-through during convergence.
    const pointer = pointerRef.current;
    pointer.x += (pointer.targetX - pointer.x) * PARALLAX_DAMPING;
    pointer.y += (pointer.targetY - pointer.y) * PARALLAX_DAMPING;

    camera.position.x = pointer.x * PARALLAX_RANGE;
    camera.position.y = -pointer.y * PARALLAX_RANGE;
    // 11 → 2.2: the push travels through the collapsing structure, which is
    // what makes the transition read as *entering* rather than watching.
    camera.position.z = 11 - progress * 8.8;
    camera.lookAt(0, 0, 0);

    // Node positions: rest position → mark geometry, with a slow idle drift.
    const mesh = nodesRef.current;
    if (mesh) {
      LATTICE_NODES.forEach((node, index) => {
        const target = CONVERGENCE_TARGETS[index] ?? node.position;
        const drift = Math.sin(time * 0.4 + index * 1.7) * 0.06 * (1 - progress);

        dummy.position.set(
          node.position[0] + (target[0] - node.position[0]) * progress,
          node.position[1] + (target[1] - node.position[1]) * progress + drift,
          node.position[2] + (target[2] - node.position[2]) * progress,
        );
        dummy.scale.setScalar((0.09 + node.weight * 0.07) * (1 + progress * 0.5));
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Edges follow their endpoints. Written in place into the existing buffer.
    const edgePositions = edgeGeometry.getAttribute('position') as THREE.BufferAttribute;
    const edgeArray = edgePositions.array as Float32Array;

    allEdges.forEach(([fromIndex, toIndex], edgeIndex) => {
      const from = LATTICE_NODES[fromIndex];
      const to = LATTICE_NODES[toIndex];
      if (!from || !to) return;

      const fromTarget = CONVERGENCE_TARGETS[fromIndex] ?? from.position;
      const toTarget = CONVERGENCE_TARGETS[toIndex] ?? to.position;
      const offset = edgeIndex * 6;

      for (let axis = 0; axis < 3; axis += 1) {
        edgeArray[offset + axis] =
          from.position[axis]! + (fromTarget[axis]! - from.position[axis]!) * progress;
        edgeArray[offset + 3 + axis] =
          to.position[axis]! + (toTarget[axis]! - to.position[axis]!) * progress;
      }
    });
    edgePositions.needsUpdate = true;

    // Signal pulses travel their edge, then fade out as the lattice collapses.
    const signalPositions = signalGeometry.getAttribute('position') as THREE.BufferAttribute;
    const signalArray = signalPositions.array as Float32Array;
    const speed = 0.13 + activity * 0.09;

    signalPhases.forEach((phase, index) => {
      const edgeIndex = Math.floor(index / SIGNALS_PER_EDGE);
      const edge = allEdges[edgeIndex];
      if (!edge) return;

      const from = LATTICE_NODES[edge[0]];
      const to = LATTICE_NODES[edge[1]];
      if (!from || !to) return;

      const t = (phase + time * speed) % 1;
      const offset = index * 3;

      for (let axis = 0; axis < 3; axis += 1) {
        const fromTarget = CONVERGENCE_TARGETS[edge[0]] ?? from.position;
        const toTarget = CONVERGENCE_TARGETS[edge[1]] ?? to.position;
        const start = from.position[axis]! + (fromTarget[axis]! - from.position[axis]!) * progress;
        const end = to.position[axis]! + (toTarget[axis]! - to.position[axis]!) * progress;
        signalArray[offset + axis] = start + (end - start) * t;
      }
    });
    signalPositions.needsUpdate = true;

    if (signalsRef.current) {
      const material = signalsRef.current.material as THREE.PointsMaterial;
      material.opacity = (0.75 + activity * 0.25) * (1 - progress);
    }

    if (edgesRef.current) {
      const material = edgesRef.current.material as THREE.LineBasicMaterial;
      material.opacity = 0.26 * (1 - progress * 0.7);
    }
  });

  // ---------------------------------------------------------------------------
  // Disposal.
  //
  // WebGL contexts are a finite browser resource, and a leaked one surfaces
  // much later as a blank canvas on an unrelated page — extremely hard to
  // diagnose. Geometries created with useMemo are not managed by R3F's
  // automatic disposal, so they are disposed explicitly.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      edgeGeometry.dispose();
      depthGeometry.dispose();
      signalGeometry.dispose();
    };
  }, [edgeGeometry, depthGeometry, signalGeometry]);

  return (
    <>
      <instancedMesh
        ref={nodesRef}
        args={[undefined, undefined, LATTICE_NODES.length]}
        frustumCulled={false}
      >
        {/* Detail 0 → 20 triangles per node. 7 nodes = 140 triangles total. */}
        <icosahedronGeometry args={[1, 0]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <lineSegments ref={edgesRef} geometry={edgeGeometry} frustumCulled={false}>
        <lineBasicMaterial color={dimColor} transparent opacity={0.26} toneMapped={false} />
      </lineSegments>

      <points ref={signalsRef} geometry={signalGeometry} frustumCulled={false}>
        <pointsMaterial
          color={signalColor}
          size={0.075}
          transparent
          opacity={0.85}
          sizeAttenuation
          toneMapped={false}
          depthWrite={false}
        />
      </points>

      <points geometry={depthGeometry} frustumCulled={false}>
        <pointsMaterial
          color={dimColor}
          size={0.035}
          transparent
          opacity={0.4}
          sizeAttenuation
          toneMapped={false}
          depthWrite={false}
        />
      </points>
    </>
  );
}

/**
 * Canvas host.
 *
 * `frameloop="always"` is required because the scene animates continuously.
 * It is paused on `visibilitychange` by `PauseWhenHidden` below, so a
 * backgrounded tab costs nothing.
 */
export default function LatticeScene(props: SceneProps) {
  return (
    <Canvas
      // Cap DPR at 1.75 — beyond that the fill-rate cost grows quadratically
      // for a difference nobody can see on this content.
      dpr={[1, 1.75]}
      camera={{ position: [0, 0, 11], fov: 42 }}
      gl={{
        antialias: true,
        alpha: true,
        // The scene is decorative and re-renders continuously, so preserving
        // the drawing buffer would cost memory for no benefit.
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      }}
      style={{ pointerEvents: 'none' }}
    >
      <PauseWhenHidden />
      <LatticeContent {...props} />
    </Canvas>
  );
}

/** Stops the render loop while the tab is hidden. */
function PauseWhenHidden() {
  const setFrameloop = useThree((state) => state.setFrameloop);

  useEffect(() => {
    function handleVisibilityChange() {
      setFrameloop(document.hidden ? 'never' : 'always');
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [setFrameloop]);

  return null;
}
