// True-3D operations map — white clay massing under an orbitable camera.
// Interaction contract matches the old SVG map: select robots/waypoints/
// events, tap-to-dispatch, planner sequencing via onWaypointClick.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { MapControls, Text, Line, Billboard, Edges } from '@react-three/drei'
import * as THREE from 'three'
import { Plus, Minus, Maximize2 } from 'lucide-react'
import { useApp, api } from '../lib/store'
import { useT } from '../lib/i18n'
import type { Building, Telemetry, Waypoint } from '../lib/types'
import { SEVERITY_COLOR } from '../lib/types'
import { RafResizeObserver } from './rafResizeObserver'

export type MapSel =
  | { kind: 'robot'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'waypoint'; id: string }
  | null

const ACCENT = '#b8ee46'
const INK2 = '#9c9c98'
const CLAY = '#e9e9e4'
const CLAY_MID = '#bdbdb6'
const HOME = { pos: new THREE.Vector3(0, 26, 22), tgt: new THREE.Vector3(0, 0, 0.5) }

const MONO = undefined // troika default — keep bundle lean

/** minimal structural type for the drei MapControls instance */
interface MapControlsImpl {
  object: THREE.Camera
  target: THREE.Vector3
  update: () => void
}

// ---------- static scene ----------

function Ground() {
  const grid = useMemo(() => {
    const pts: THREE.Vector3[] = []
    for (let x = -16; x <= 16; x += 4) pts.push(new THREE.Vector3(x, 0, -9), new THREE.Vector3(x, 0, 9))
    for (let z = -9; z <= 9; z += 4) pts.push(new THREE.Vector3(-16, 0, z), new THREE.Vector3(16, 0, z))
    return new THREE.BufferGeometry().setFromPoints(pts)
  }, [])
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[44, 30]} />
        <meshStandardMaterial color="#101010" roughness={1} metalness={0} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[32, 18]} />
        <meshStandardMaterial color="#161615" roughness={1} metalness={0} />
      </mesh>
      <lineSegments geometry={grid} position={[0, 0.005, 0]}>
        <lineBasicMaterial color="#242423" transparent opacity={0.7} />
      </lineSegments>
      {/* site boundary */}
      <Line
        points={[
          [-15.65, 0.01, -8.65],
          [15.65, 0.01, -8.65],
          [15.65, 0.01, 8.65],
          [-15.65, 0.01, 8.65],
          [-15.65, 0.01, -8.65],
        ]}
        color="#4a4a46"
        lineWidth={1}
      />
    </group>
  )
}

function Buildings({ buildings, onMiss }: { buildings: Building[]; onMiss?: () => void }) {
  return (
    <group>
      {buildings.map((b) => {
        const mid = b.tone === 'mid'
        const color = mid ? CLAY_MID : CLAY
        if (b.kind === 'box') {
          const w = b.x1 - b.x0
          const d = b.z1 - b.z0
          return (
            <group key={b.id} position={[(b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2]}>
              <mesh position={[0, b.h / 2, 0]} castShadow receiveShadow onClick={onMiss}>
                <boxGeometry args={[w, b.h, d]} />
                <meshStandardMaterial color={color} roughness={0.9} metalness={0} />
                <Edges color="#0a0a0a" threshold={20} opacity={0.32} transparent />
              </mesh>
              {b.name && (
                <Text
                  font={MONO}
                  position={[0, b.h + 0.02, d / 2 - Math.min(0.7, d * 0.24)]}
                  rotation={[-Math.PI / 2, 0, 0]}
                  fontSize={Math.min(0.42, (w * 0.8) / Math.max(4, b.name.length * 0.66))}
                  letterSpacing={0.12}
                  color="#4b4b46"
                  anchorX="center"
                  anchorY="middle"
                >
                  {b.name}
                </Text>
              )}
            </group>
          )
        }
        return (
          <group key={b.id} position={[b.cx, 0, b.cz]}>
            <mesh position={[0, b.h / 2, 0]} castShadow receiveShadow onClick={onMiss}>
              <cylinderGeometry args={[b.r, b.r, b.h, 40]} />
              <meshStandardMaterial color={color} roughness={0.9} metalness={0} />
            </mesh>
            {/* lid detail */}
            <mesh position={[0, b.h + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[b.r * 0.5, b.r * 0.55, 40]} />
              <meshBasicMaterial color="#0a0a0a" transparent opacity={0.3} />
            </mesh>
            {b.name && (
              <Text
                font={MONO}
                position={[0, b.h + 0.02, 0]}
                rotation={[-Math.PI / 2, 0, 0]}
                fontSize={Math.min(0.34, (b.r * 1.5) / Math.max(3, b.name.length * 0.62))}
                letterSpacing={0.1}
                color="#4b4b46"
                anchorX="center"
                anchorY="middle"
              >
                {b.name}
              </Text>
            )}
          </group>
        )
      })}
    </group>
  )
}

const ZONE_GLYPH: Record<string, string> = { restricted: '⊘', inspection: '◇', charging: '⚡' }

function ZoneFlat({ z, labels }: { z: ReturnType<typeof useApp.getState>['zones'][number]; labels: boolean }) {
  const tone = z.kind === 'restricted' ? SEVERITY_COLOR.critical : z.kind === 'charging' ? ACCENT : '#b0b0a8'
  const shape = useMemo(() => {
    const sh = new THREE.Shape()
    z.polygon.forEach(([x, zz], i) => (i === 0 ? sh.moveTo(x, zz) : sh.lineTo(x, zz)))
    sh.closePath()
    return sh
  }, [z])
  const lp = z.label === null ? null : (z.label ?? { x: (z.polygon[0][0] + z.polygon[2][0]) / 2, z: z.polygon[0][1] + 0.62 })
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial color={tone} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line
        points={[...z.polygon, z.polygon[0]].map(([x, zz]) => [x, 0.02, zz] as [number, number, number])}
        color={tone}
        lineWidth={1.2}
        dashed
        dashSize={0.5}
        gapSize={0.3}
        transparent
        opacity={0.6}
      />
      {labels && lp && (
        <Text
          font={MONO}
          position={[lp.x, 0.02, lp.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={0.42}
          letterSpacing={0.08}
          color={tone}
          fillOpacity={0.9}
          anchorX={lp.anchor === 'end' ? 'right' : lp.anchor === 'start' ? 'left' : 'center'}
          anchorY="middle"
        >
          {`${ZONE_GLYPH[z.kind] ?? ''} ${z.name.toUpperCase()}`}
        </Text>
      )}
    </group>
  )
}

function Zones({ labels }: { labels: boolean }) {
  const zones = useApp((s) => s.zones)
  return (
    <group>
      {zones.map((z) => (
        <ZoneFlat key={z.id} z={z} labels={labels} />
      ))}
    </group>
  )
}

// ---------- dynamic layer ----------

function WaypointMark({
  wp,
  state,
  order,
  onClick,
}: {
  wp: Waypoint
  state: 'normal' | 'selected' | 'routed'
  order?: number
  onClick?: () => void
}) {
  const hot = state !== 'normal'
  const tone = hot || wp.kind === 'dock' ? ACCENT : '#a8a8a2'
  const [hover, setHover] = useState(false)
  const s = hover ? 1.25 : 1
  return (
    <group position={[wp.x, 0, wp.z]}>
      <group
        scale={[s, s, s]}
        onClick={
          onClick
            ? (e) => {
                e.stopPropagation()
                onClick()
              }
            : undefined
        }
        onPointerOver={(e) => {
          e.stopPropagation()
          setHover(true)
          document.body.style.cursor = onClick ? 'pointer' : 'default'
        }}
        onPointerOut={() => {
          setHover(false)
          document.body.style.cursor = 'default'
        }}
      >
        {/* invisible hit pad */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} visible={false}>
          <circleGeometry args={[0.62, 12]} />
        </mesh>
        {wp.kind === 'dock' && (
          <>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <ringGeometry args={[0.26, 0.33, 28]} />
              <meshBasicMaterial color={tone} />
            </mesh>
            <mesh position={[0, 0.06, 0]}>
              <cylinderGeometry args={[0.1, 0.1, 0.12, 16]} />
              <meshBasicMaterial color={tone} />
            </mesh>
          </>
        )}
        {wp.kind === 'inspect' && (
          <>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <ringGeometry args={[0.17, 0.23, 28]} />
              <meshBasicMaterial color={tone} />
            </mesh>
            {[0, 90, 180, 270].map((a) => (
              <mesh key={a} rotation={[-Math.PI / 2, 0, (a / 180) * Math.PI]} position={[0, 0.02, 0]}>
                <planeGeometry args={[0.13, 0.045]} />
                <meshBasicMaterial color={tone} />
              </mesh>
            ))}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <circleGeometry args={[0.05, 12]} />
              <meshBasicMaterial color={tone} />
            </mesh>
          </>
        )}
        {wp.kind === 'nav' && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <ringGeometry args={[0.1, 0.15, 24]} />
            <meshBasicMaterial color={tone} />
          </mesh>
        )}
      </group>
      <Billboard position={[0, 0.62, 0]}>
        <Text font={MONO} fontSize={0.34} color={hot ? ACCENT : '#78786f'} anchorX="center" anchorY="bottom" letterSpacing={0.04}>
          {wp.id.replace('WP-', 'W')}
        </Text>
        {hover && (
          <Text font={MONO} fontSize={0.3} color="#b6b6b0" anchorX="center" anchorY="top" position={[0, -0.06, 0]}>
            {wp.name}
          </Text>
        )}
      </Billboard>
      {order != null && (
        <Billboard position={[0.5, 0.95, 0]}>
          <mesh>
            <circleGeometry args={[0.24, 24]} />
            <meshBasicMaterial color={ACCENT} />
          </mesh>
          <Text font={MONO} fontSize={0.28} color="#0a0a0a" anchorX="center" anchorY="middle" fontWeight={700}>
            {String(order)}
          </Text>
        </Billboard>
      )}
    </group>
  )
}

function RobotPuck({
  tel,
  color,
  family,
  callsign,
  selected,
  onClick,
}: {
  tel: Telemetry
  color: string
  family: string
  callsign: string
  selected: boolean
  onClick?: () => void
}) {
  const group = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (!group.current) return
    group.current.position.lerp(new THREE.Vector3(tel.x, 0, tel.z), 0.14)
    group.current.rotation.y = THREE.MathUtils.lerp(group.current.rotation.y, -tel.heading, 0.15)
    if (ring.current) {
      const mat = ring.current.material as THREE.MeshBasicMaterial
      if (tel.speed > 0.05) {
        const k = (clock.elapsedTime % 2.4) / 2.4
        ring.current.scale.setScalar(1 + k * 1.1)
        mat.opacity = 0.4 * (1 - k)
      } else {
        ring.current.scale.setScalar(1)
        mat.opacity = 0.35
      }
    }
  })
  const tone = selected ? ACCENT : color
  return (
    <group ref={group}>
      {/* FOV wedge */}
      <mesh rotation={[-Math.PI / 2, 0, -0.46]} position={[0, 0.03, 0]}>
        <circleGeometry args={[2.35, 26, 0, 0.92]} />
        <meshBasicMaterial color="#ebebe8" transparent opacity={selected ? 0.14 : 0.08} depthWrite={false} />
      </mesh>
      <group
        onClick={
          onClick
            ? (e) => {
                e.stopPropagation()
                onClick()
              }
            : undefined
        }
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = 'default')}
      >
        {family === 'ugv' ? (
          <mesh position={[0, 0.14, 0]} castShadow>
            <boxGeometry args={[0.56, 0.26, 0.56]} />
            <meshStandardMaterial color="#141414" roughness={0.6} />
          </mesh>
        ) : (
          <mesh position={[0, 0.14, 0]} castShadow>
            <cylinderGeometry args={[0.3, 0.34, 0.26, 24]} />
            <meshStandardMaterial color="#141414" roughness={0.6} />
          </mesh>
        )}
        {/* heading arrow on the deck */}
        <mesh position={[0.02, 0.28, 0]} rotation={[-Math.PI / 2, 0, -Math.PI / 2]}>
          <coneGeometry args={[0.14, 0.34, 3]} />
          <meshBasicMaterial color={tone} />
        </mesh>
        {/* rim */}
        <mesh position={[0, 0.14, 0]}>
          {family === 'ugv' ? <boxGeometry args={[0.6, 0.2, 0.6]} /> : <cylinderGeometry args={[0.35, 0.35, 0.2, 24]} />}
          <meshBasicMaterial color={tone} wireframe transparent opacity={selected ? 0.9 : 0.4} />
        </mesh>
      </group>
      {/* breathing ring */}
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.4, 0.44, 32]} />
        <meshBasicMaterial color={tone} transparent opacity={0.35} depthWrite={false} />
      </mesh>
      <Billboard position={[0, 1.05, 0]}>
        <Text
          font={MONO}
          fontSize={0.36}
          color={selected ? ACCENT : '#d8d8d2'}
          outlineWidth={0.045}
          outlineColor="#0a0a0a"
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.05}
        >
          {callsign}
        </Text>
      </Billboard>
    </group>
  )
}

function EventPin({ x, z, severity, onClick }: { x: number; z: number; severity: string; onClick?: () => void }) {
  const tone = SEVERITY_COLOR[severity as keyof typeof SEVERITY_COLOR] ?? INK2
  const mat = useRef<THREE.MeshBasicMaterial>(null)
  useFrame(({ clock }) => {
    if (mat.current && severity === 'critical') mat.current.opacity = 0.55 + 0.45 * Math.sin(clock.elapsedTime * 4)
  })
  const alarm = severity === 'critical' || severity === 'high'
  return (
    <group position={[x, 0, z]}>
      <Billboard position={[0, alarm ? 0.42 : 0.2, 0]}>
        <mesh
          onClick={
            onClick
              ? (e) => {
                  e.stopPropagation()
                  onClick()
                }
              : undefined
          }
        >
          {alarm ? <circleGeometry args={[0.26, 3, Math.PI / 2]} /> : <ringGeometry args={[0.12, 0.17, 20]} />}
          <meshBasicMaterial ref={mat} color={tone} transparent side={THREE.DoubleSide} />
        </mesh>
      </Billboard>
    </group>
  )
}

/** frame the whole yard for this viewport: distance from both FOV axes */
function fitHome(width: number, height: number, fovDeg: number) {
  const aspect = width / Math.max(1, height)
  const vfov = (fovDeg * Math.PI) / 180
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect)
  const dV = 21 / (2 * Math.tan(vfov / 2))
  const dH = 35 / (2 * Math.tan(hfov / 2))
  const dist = Math.min(58, Math.max(dV, dH) * 1.05)
  const dir = new THREE.Vector3(0, 0.76, 0.65).normalize()
  return { pos: dir.multiplyScalar(dist).add(new THREE.Vector3(0, 0, 0.5)), tgt: new THREE.Vector3(0, 0, 0.5) }
}

function CameraRig({
  controls,
  homeRef,
}: {
  controls: React.RefObject<MapControlsImpl | null>
  homeRef: React.MutableRefObject<{ pos: THREE.Vector3; tgt: THREE.Vector3 }>
}) {
  const size = useThree((s) => s.size)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const framed = useRef(false)
  useEffect(() => {
    if (framed.current || size.width < 60 || size.height < 60) return
    framed.current = true
    const home = fitHome(size.width, size.height, camera.fov)
    homeRef.current = home
    camera.position.copy(home.pos)
    if (controls.current) {
      controls.current.target.copy(home.tgt)
      controls.current.update()
    } else {
      camera.lookAt(home.tgt)
    }
  }, [size, camera, controls, homeRef])
  return null
}

// camera dolly helper for the +/− buttons
function dolly(controls: MapControlsImpl | null, factor: number) {
  if (!controls) return
  const cam = controls.object as THREE.PerspectiveCamera
  const dir = cam.position.clone().sub(controls.target)
  const len = THREE.MathUtils.clamp(dir.length() * factor, 7, 60)
  cam.position.copy(controls.target.clone().add(dir.normalize().multiplyScalar(len)))
  controls.update()
}

// ---------- main component ----------

export function Map3D({
  selection,
  onSelect,
  heightClass = 'h-[420px]',
  interactive = true,
  showEvents = true,
  labels = true,
  className = '',
  onWaypointClick,
  routePreview,
  wheelZoom = true,
}: {
  selection?: MapSel
  onSelect?: (sel: MapSel) => void
  heightClass?: string
  interactive?: boolean
  showEvents?: boolean
  labels?: boolean
  className?: string
  onWaypointClick?: (wp: Waypoint) => void
  routePreview?: string[]
  wheelZoom?: boolean
}) {
  const site = useApp((s) => s.site)
  const robots = useApp((s) => s.robots)
  const waypoints = useApp((s) => s.waypoints)
  const buildings = useApp((s) => s.buildings)
  const telemetry = useApp((s) => s.telemetry)
  const events = useApp((s) => s.events)
  const t = useT()
  const [gotoMenu, setGotoMenu] = useState<Waypoint | null>(null)
  const controls = useRef<MapControlsImpl>(null)
  const homeRef = useRef({ pos: HOME.pos.clone(), tgt: HOME.tgt.clone() })

  const pins = useMemo(
    () => (showEvents ? events.filter((e) => !e.acked).slice(0, 24) : []),
    [events, showEvents],
  )

  if (!site) return <div className={`skeleton ${heightClass} ${className}`} />

  const deselect = () => {
    onSelect?.(null)
    setGotoMenu(null)
  }

  return (
    <div className={`relative touch-none overflow-hidden bg-surface ${heightClass} ${className}`}>
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ position: HOME.pos.toArray() as [number, number, number], fov: 38, near: 0.5, far: 220 }}
        resize={{ polyfill: RafResizeObserver as any, scroll: false, debounce: 0 }}
        onPointerMissed={deselect}
      >
        <CameraRig controls={controls} homeRef={homeRef} />
        <ambientLight intensity={0.85} />
        <hemisphereLight args={['#3a3a38', '#181816', 0.5]} />
        <directionalLight
          position={[-14, 26, -10]}
          intensity={1.5}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-20}
          shadow-camera-right={20}
          shadow-camera-top={16}
          shadow-camera-bottom={-16}
          shadow-bias={-0.0004}
        />
        <Suspense fallback={null}>
          <Ground />
          <Zones labels={labels} />
          <Buildings buildings={buildings} onMiss={interactive ? deselect : undefined} />

          {/* route preview (planner) */}
          {routePreview && routePreview.length > 1 && (
            <Line
              points={routePreview
                .map((id) => waypoints.find((w) => w.id === id))
                .filter(Boolean)
                .map((w) => [w!.x, 0.05, w!.z] as [number, number, number])}
              color={ACCENT}
              lineWidth={2}
              dashed
              dashSize={0.4}
              gapSize={0.26}
              transparent
              opacity={0.85}
            />
          )}

          {/* waypoints */}
          {waypoints.map((wp) => {
            const orderIdx = routePreview ? routePreview.indexOf(wp.id) : -1
            const state =
              orderIdx >= 0 ? 'routed' : selection?.kind === 'waypoint' && selection.id === wp.id ? 'selected' : 'normal'
            return (
              <WaypointMark
                key={wp.id}
                wp={wp}
                state={state}
                order={orderIdx >= 0 ? orderIdx + 1 : undefined}
                onClick={
                  onWaypointClick
                    ? () => onWaypointClick(wp)
                    : interactive
                      ? () => {
                          onSelect?.({ kind: 'waypoint', id: wp.id })
                          setGotoMenu(wp)
                        }
                      : undefined
                }
              />
            )
          })}

          {/* event pins */}
          {pins.map((e) => (
            <EventPin
              key={e.id}
              x={e.x}
              z={e.z}
              severity={e.severity}
              onClick={interactive ? () => onSelect?.({ kind: 'event', id: e.id }) : undefined}
            />
          ))}

          {/* planned paths + robots */}
          {robots.map((r) => {
            const tel = telemetry[r.id]
            if (!tel) return null
            const sel = selection?.kind === 'robot' && selection.id === r.id
            return (
              <group key={r.id}>
                {tel.path.length > 0 && (
                  <Line
                    points={[[tel.x, 0.04, tel.z], ...tel.path.map((p) => [p.x, 0.04, p.z] as [number, number, number])]}
                    color={sel ? ACCENT : r.color}
                    lineWidth={sel ? 2 : 1.2}
                    dashed
                    dashSize={0.32}
                    gapSize={0.22}
                    transparent
                    opacity={sel ? 0.95 : 0.55}
                  />
                )}
                <RobotPuck
                  tel={tel}
                  color={r.color}
                  family={r.family}
                  callsign={r.callsign}
                  selected={!!sel}
                  onClick={interactive ? () => onSelect?.({ kind: 'robot', id: r.id }) : undefined}
                />
              </group>
            )
          })}
        </Suspense>
        <MapControls
          ref={controls as any}
          target={HOME.tgt.toArray() as [number, number, number]}
          enableZoom={wheelZoom}
          enableRotate={interactive}
          enablePan={interactive}
          enableDamping
          dampingFactor={0.12}
          minDistance={7}
          maxDistance={60}
          maxPolarAngle={Math.PI * 0.44}
          minPolarAngle={0.1}
        />
      </Canvas>

      {/* zoom / reset */}
      {interactive && (
        <div className="absolute bottom-3 right-3 z-10 flex flex-col border border-line bg-surface/90 backdrop-blur">
          <button
            onClick={() => dolly(controls.current, 0.74)}
            className="flex h-8 w-8 items-center justify-center text-ink-3 transition-colors hover:text-ink"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => dolly(controls.current, 1.35)}
            className="flex h-8 w-8 items-center justify-center border-t border-line text-ink-3 transition-colors hover:text-ink"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={() => {
              const c = controls.current
              if (!c) return
              c.object.position.copy(homeRef.current.pos)
              c.target.copy(homeRef.current.tgt)
              c.update()
            }}
            className="flex h-8 w-8 items-center justify-center border-t border-line text-ink-3 transition-colors hover:text-ink"
          >
            <Maximize2 size={12} />
          </button>
        </div>
      )}

      {/* waypoint teleop menu */}
      {gotoMenu && interactive && !onWaypointClick && (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
          <div className="panel flex items-center gap-2 px-3 py-2">
            <span className="mono text-[13px] text-ink">{gotoMenu.id}</span>
            <span className="hidden text-[13px] text-ink-3 sm:block">{gotoMenu.name}</span>
            <span className="mx-1 h-4 w-px bg-line-2" />
            <span className="microlabel">{t('c.send')}</span>
            {robots.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  api.goto(r.id, gotoMenu.x, gotoMenu.z)
                  setGotoMenu(null)
                  onSelect?.({ kind: 'robot', id: r.id })
                }}
                className="mono border border-line-2 px-1.5 py-1 text-[12px] tracking-[0.06em] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
              >
                {r.callsign}
              </button>
            ))}
            <button onClick={() => setGotoMenu(null)} className="ml-1 text-ink-3 hover:text-ink">
              ×
            </button>
          </div>
        </div>
      )}

      {/* legend + provenance — full-page map only */}
      {labels && wheelZoom && (
        <div className="pointer-events-none absolute bottom-1.5 left-2 space-y-1">
          <div className="hidden items-center gap-3 sm:flex">
            {(
              [
                [
                  'map.lg.inspect',
                  <svg key="i" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.21} fill="none" stroke="#a8a8a2" strokeWidth={0.05} />
                    {[0, 90, 180, 270].map((a) => (
                      <line key={a} x1={0.21} y1={0} x2={0.33} y2={0} stroke="#a8a8a2" strokeWidth={0.05} transform={`rotate(${a})`} />
                    ))}
                    <circle r={0.06} fill="#a8a8a2" />
                  </svg>,
                ],
                [
                  'map.lg.nav',
                  <svg key="n" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.16} fill="none" stroke="#a8a8a2" strokeWidth={0.06} />
                  </svg>,
                ],
                [
                  'map.lg.dock',
                  <svg key="d" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.32} fill="none" stroke={ACCENT} strokeWidth={0.05} />
                    <path d="M 0.06 -0.2 L -0.13 0.03 L -0.02 0.03 L -0.05 0.2 L 0.14 -0.03 L 0.03 -0.03 Z" fill={ACCENT} />
                  </svg>,
                ],
                [
                  'map.lg.alarm',
                  <svg key="a" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <path d="M 0 -0.3 L 0.3 0.22 L -0.3 0.22 Z" fill="none" stroke="var(--color-warn)" strokeWidth={0.055} strokeLinejoin="round" />
                  </svg>,
                ],
              ] as const
            ).map(([key, icon]) => (
              <span key={key} className="flex items-center gap-1.5">
                {icon}
                <span className="mono text-[10px] text-ink-3">{t(key)}</span>
              </span>
            ))}
          </div>
          <div>
            <span className="mono text-[10px] text-ink-3/80">occupancy 5 cm/px · {site.map.source} · 3D</span>
          </div>
        </div>
      )}
    </div>
  )
}
