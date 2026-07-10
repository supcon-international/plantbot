import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Line, Grid, Html } from '@react-three/drei'
// @ts-expect-error no bundled types
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d'
import * as THREE from 'three'
import { RafResizeObserver } from './rafResizeObserver'
import { pushSnap, sampleSnap, INTERP_DELAY_MS, type PoseSnap } from './poseBuffer'
import { useApp } from '../lib/store'
import { BASE } from '../lib/base'
import type { DetectionEvent, RobotSpec } from '../lib/types'
// THREE.Color can't parse CSS var() — mirror the palette as literals
const SEVERITY_COLOR: Record<string, string> = { critical: '#dd5648', high: '#c2a05a', info: '#9c9c98', low: '#6b6b6f' }
import type { MapSel } from '../components/OpsMap'

// Calibration of the public "train" 3DGS capture into our site frame.
// COLMAP y-down → y-up; 0.562 rad yaw from PCA of the hull point cloud.
// tandt "truck" capture: COLMAP y-down, yaw 0.705 rad from hull PCA,
// ground plane at y≈0.5 — open-yard footprint fills the site frame.
// bump when the baked scene file changes — busts the browser's cache
const SCENE_REV = 11

// the scene file is pre-leveled and pre-scaled by scripts/level_splat.py —
// identity here is the guarantee that nothing renders crooked
export const SPLAT_CALIB = {
  position: [0, -0.03, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: 1,
}

/** resolve a MapAsset url: '/'-prefixed → server URL (PUB baked in); else web asset under BASE */
export function assetUrl(url: string) {
  return url.startsWith('/') ? url : `${BASE}/${url}`
}

function SplatStage({ url }: { url: string }) {
  const [calib, setCalib] = useState(SPLAT_CALIB)
  const [viewer] = useState(() => {
    const v = new GaussianSplats3D.DropInViewer({
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: false, // no COOP/COEP needed
      freeIntermediateSplatData: true,
      // the radial reveal animation stalls under our render loop — show all
      sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    })
    v.addSplatScene(assetUrl(url) + '?v=' + SCENE_REV, {
      format: GaussianSplats3D.SceneFormat.Splat,
      splatAlphaRemovalThreshold: 5,
      showLoadingUI: false,
      // progressive + non-shared-memory drops sections beyond the first —
      // load whole; the chip covers the wait
      progressiveLoad: false,
    })
      .then(() => {
        // the library's radial reveal stalls under our render loop — the
        // Instant mode flag isn't forwarded by DropInViewer, so force the
        // visible region open once the scene is in memory
        const sm = (v as any).viewer?.splatMesh ?? (v as any).splatMesh
        if (sm) {
          sm.visibleRegionFadeStartRadius = 1000
          sm.visibleRegionRadius = 1000
          sm.visibleRegionBufferRadius = 1000
        }
        window.dispatchEvent(new CustomEvent('aegis:splat-ready'))
      })
      .catch(() => window.dispatchEvent(new CustomEvent('aegis:splat-ready')))
    ;(window as any).__viewer = v
    return v
  })
  useEffect(() => {
    ;(window as any).__splat = (position: number[], rotation: number[], scale: number) =>
      setCalib({ position, rotation, scale } as typeof SPLAT_CALIB)
    return () => {
      viewer.dispose?.()
    }
  }, [viewer])
  return (
    <group position={calib.position as any} rotation={calib.rotation as any} scale={calib.scale}>
      <primitive object={viewer} />
    </group>
  )
}

function RobotMarker({ r, selected, onSelect }: { r: RobotSpec; selected: boolean; onSelect: () => void }) {
  const group = useRef<THREE.Group>(null)
  const pulse = useRef<THREE.Mesh>(null)
  const buf = useRef<PoseSnap[]>([])
  const lastTel = useRef<unknown>(null)

  useFrame(({ clock }) => {
    const tel = useApp.getState().telemetry[r.id]
    const g = group.current
    if (!g) return
    // snapshot interpolation over the 4 Hz beat — constant-velocity glide
    if (tel && tel !== lastTel.current) {
      lastTel.current = tel
      pushSnap(buf.current, tel.x, tel.z, tel.heading, performance.now())
    }
    const s = sampleSnap(buf.current, performance.now() - INTERP_DELAY_MS)
    g.visible = !!s
    if (!s) return
    g.position.set(s.x, 0, s.z)
    g.rotation.y = s.h
    const t = clock.elapsedTime
    if (pulse.current) {
      const k = (t % 1.8) / 1.8
      pulse.current.scale.setScalar(1 + k * 1.7)
      ;(pulse.current.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - k)
    }
  })

  const color = selected ? '#b8ee46' : r.color

  return (
    <group ref={group} visible={false} onClick={(e) => (e.stopPropagation(), onSelect())}>
      {r.family === 'ugv' ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.4, 0.48, 4]} />
          <meshBasicMaterial color={color} transparent opacity={0.95} side={THREE.DoubleSide} />
        </mesh>
      ) : (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.42, 0.5, 40]} />
          <meshBasicMaterial color={color} transparent opacity={0.95} side={THREE.DoubleSide} />
        </mesh>
      )}
      <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <ringGeometry args={[0.42, 0.46, 40]} />
        <meshBasicMaterial color={r.color} transparent opacity={0.25} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, -Math.PI / 2]} position={[0.62, 0.03, 0]}>
        <circleGeometry args={[0.17, 3]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {selected && (
        <mesh position={[0, 0.9, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 1.8, 6]} />
          <meshBasicMaterial color="#b8ee46" transparent opacity={0.3} />
        </mesh>
      )}
      <Html center position={[0, 1.15, 0]} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }} zIndexRange={[10, 0]}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.1em',
            color: selected ? '#b8ee46' : 'rgba(230,232,234,0.85)',
            background: 'rgba(12,13,15,0.78)',
            border: `1px solid ${selected ? 'rgba(242,244,246,0.5)' : 'rgba(47,53,60,0.9)'}`,
            padding: '2px 6px',
          }}
        >
          {r.callsign}
        </span>
      </Html>
    </group>
  )
}

function LivePath({ robotId, color }: { robotId: string; color: string }) {
  // subscribe at 4 Hz via the store; never setState inside useFrame.
  // Drawn from the plan's own points (not the live pose) so the ribbon
  // holds still while the marker glides between snapshots.
  const tel = useApp((s) => s.telemetry[robotId])
  const pts = useMemo(() => {
    if (!tel || tel.path.length < 2) return null
    return tel.path.map((p) => [p.x, 0.04, p.z] as [number, number, number])
  }, [tel])
  if (!pts) return null
  return <Line points={pts} color={color} lineWidth={1.2} dashed dashSize={0.4} gapSize={0.26} transparent opacity={0.75} />
}

function EventPin({ ev, onSelect, selected }: { ev: DetectionEvent; onSelect: () => void; selected: boolean }) {
  const color = SEVERITY_COLOR[ev.severity]
  const head = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (head.current && ev.severity === 'critical') {
      const s = 1 + 0.25 * Math.sin(clock.elapsedTime * 5)
      head.current.scale.setScalar(s)
    }
  })
  return (
    <group position={[ev.x, 0, ev.z]} onClick={(e) => (e.stopPropagation(), onSelect())}>
      <mesh position={[0, 0.45, 0]}>
        <cylinderGeometry args={[0.014, 0.014, 0.9, 6]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.9 : 0.45} />
      </mesh>
      <mesh ref={head} position={[0, 0.95, 0]}>
        <octahedronGeometry args={[0.12]} />
        <meshBasicMaterial color={color} wireframe={!selected} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.14, 0.18, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function CameraRig({ selection, follow }: { selection: MapSel; follow: boolean }) {
  const controls = useRef<any>(null)
  useFrame(() => {
    if (!controls.current) return
    if (follow && selection?.kind === 'robot') {
      const tel = useApp.getState().telemetry[selection.id]
      if (tel) {
        controls.current.target.lerp(new THREE.Vector3(tel.x, 0.3, tel.z), 0.06)
        controls.current.update()
      }
    }
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={[0, 0.4, 0]}
      minDistance={9}
      maxDistance={38}
      maxPolarAngle={Math.PI * 0.36}
      enableDamping
      dampingFactor={0.08}
    />
  )
}

export function SceneMap({
  selection,
  onSelect,
  follow,
  quality,
}: {
  selection: MapSel
  onSelect: (s: MapSel) => void
  follow: boolean
  quality: 'high' | 'lite'
}) {
  const robots = useApp((s) => s.robots)
  const events = useApp((s) => s.events)
  const splat = useApp((s) => s.maps.find((m) => m.kind === 'splat'))
  const pins = useMemo(
    () => events.filter((e) => !e.acked && Date.now() - e.ts < 45 * 60_000).slice(0, 12),
    [events],
  )
  // sites without a 3DGS scan still resolve the loader chip immediately
  useEffect(() => {
    if (!splat) window.dispatchEvent(new CustomEvent('aegis:splat-ready'))
  }, [splat])
  return (
    <Canvas
      eventPrefix="client"
      dpr={quality === 'high' ? [1, 1.75] : 1}
      camera={{ position: [10, 24, 15], fov: 42, near: 0.1, far: 300 }}
      gl={{ antialias: false, alpha: true, powerPreference: 'high-performance' }}
      style={{ touchAction: 'none' }}
      resize={{ polyfill: RafResizeObserver as any, scroll: false, debounce: 0 }}
      onPointerMissed={() => onSelect(null)}
    >
      <hemisphereLight intensity={0.35} color="#c3ccd6" groundColor="#0c0d0f" />
      {splat && (
        <Suspense fallback={null}>
          <SplatStage key={splat.url} url={splat.url} />
        </Suspense>
      )}

      <Grid
        position={[0, 0.005, 0]}
        args={[32, 18]}
        cellSize={1}
        cellThickness={0.35}
        cellColor="#232322"
        sectionSize={4}
        sectionThickness={0.7}
        sectionColor="#34342f"
        fadeDistance={46}
        fadeStrength={1.6}
      />
      <Line
        points={[
          [-16, 0.02, -9],
          [16, 0.02, -9],
          [16, 0.02, 9],
          [-16, 0.02, 9],
          [-16, 0.02, -9],
        ]}
        color="#4a4a46"
        lineWidth={1}
      />

      {robots.map((r) => (
        <group key={r.id}>
          <LivePath robotId={r.id} color={selection?.kind === 'robot' && selection.id === r.id ? '#b8ee46' : r.color} />
          <RobotMarker
            r={r}
            selected={selection?.kind === 'robot' && selection.id === r.id}
            onSelect={() => onSelect({ kind: 'robot', id: r.id })}
          />
        </group>
      ))}

      {pins.map((ev) => (
        <EventPin
          key={ev.id}
          ev={ev}
          selected={selection?.kind === 'event' && selection.id === ev.id}
          onSelect={() => onSelect({ kind: 'event', id: ev.id })}
        />
      ))}

      <CameraRig selection={selection} follow={follow} />
    </Canvas>
  )
}
