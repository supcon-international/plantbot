// True-3D operations map — white clay massing under an orbitable camera.
// Interaction contract matches the old SVG map: select robots/waypoints/
// events, tap-to-dispatch, planner sequencing via onWaypointClick.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { MapControls, Text, Line, Billboard, Edges } from '@react-three/drei'
import * as THREE from 'three'
import { Plus, Minus, Maximize2 } from 'lucide-react'
import { useApp, api, useCan } from '../lib/store'
import { useTheme } from '../lib/theme'
import { useT } from '../lib/i18n'
import type { Building, Waypoint } from '../lib/types'
import { RafResizeObserver } from './rafResizeObserver'
import { pushSnap, sampleSnap, INTERP_DELAY_MS, type PoseSnap } from './poseBuffer'

export type MapSel =
  | { kind: 'robot'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'waypoint'; id: string }
  | null

const HOME = { pos: new THREE.Vector3(0, 26, 22), tgt: new THREE.Vector3(0, 0, 0.5) }

const MONO = undefined // troika default — keep bundle lean

// three can't read CSS vars — the scene carries its own two palettes.
// dark = charcoal yard with white clay; light = paper board with warm shadows.
const MAP_THEME = {
  dark: {
    accent: '#b8ee46',
    clay: '#e9e9e4',
    clayMid: '#bdbdb6',
    clayEdge: '#0a0a0a',
    roofText: '#4b4b46',
    apron: '#101010',
    ground: '#161615',
    grid: '#242423',
    boundary: '#4a4a46',
    zoneNeutral: '#b0b0a8',
    zoneOutline: '#0c0c0b',
    wpNeutral: '#8a8a82',
    wpBright: '#c9c9c2',
    wpDot: '#e4e4de',
    padBg: '#0d0d0c',
    chipBg: '#0d0d0c',
    chipEdge: '#3a3a36',
    chipEdgeSoft: '#33332f',
    chipText: '#e2e2dc',
    chipTextDim: '#b6b6b0',
    chipOnActive: '#0c0c0b',
    body: '#141414',
    fov: '#ebebe8',
    badgeInk: '#0a0a0a',
    sev: { critical: '#dd5648', high: '#c2a05a', info: '#9c9c98', low: '#6b6b6f' } as Record<string, string>,
    unit: (c: string) => c,
  },
  light: {
    accent: '#5c8a00',
    clay: '#ffffff',
    clayMid: '#d6d4ca',
    clayEdge: '#4a4941',
    roofText: '#6e6c60',
    apron: '#d8d6cc',
    ground: '#e7e5dc',
    grid: '#c7c5b9',
    boundary: '#8f8d80',
    zoneNeutral: '#767468',
    zoneOutline: '#f2f1ea',
    wpNeutral: '#6d6d63',
    wpBright: '#45453d',
    wpDot: '#26261f',
    padBg: '#fbfaf5',
    chipBg: '#fbfaf5',
    chipEdge: '#a5a396',
    chipEdgeSoft: '#b6b4a7',
    chipText: '#26261f',
    chipTextDim: '#54544a',
    chipOnActive: '#fbfaf5',
    body: '#2c2c27',
    fov: '#3a3a32',
    badgeInk: '#f6f5ef',
    sev: { critical: '#bf3527', high: '#96701f', info: '#54544d', low: '#85858b' } as Record<string, string>,
    // fleet colors are pale greys tuned for the dark board — deepen them on paper
    unit: (c: string) =>
      (({ '#ebebe8': '#4c4c44', '#b4b4ac': '#5e5e55', '#8a8a82': '#6d6d63', '#d6d6ce': '#54544a', '#c2c2ba': '#63625a' }) as Record<string, string>)[c] ?? c,
  },
}
type MapPalette = (typeof MAP_THEME)['dark']

function useMapTheme(): MapPalette {
  return MAP_THEME[useTheme((s) => s.theme)]
}

/** labels/badges must never swallow the ray — clicks pass through to pads underneath */
const NO_RAYCAST = () => null

/** minimal structural type for the drei MapControls instance */
interface MapControlsImpl {
  object: THREE.Camera
  target: THREE.Vector3
  update: () => void
}

// ---------- static scene ----------

/** uploaded occupancy underlay (ROS map_server convention: origin = scene
 *  coords of the image's top-left pixel, x→east/right, z→south/down) */
function OccupancyUnderlay({ map }: { map: NonNullable<ReturnType<typeof useApp.getState>['site']>['map'] }) {
  const P = useMapTheme()
  const [tex, setTex] = useState<THREE.Texture | null>(null)
  useEffect(() => {
    if (!map) return
    let dead = false
    new THREE.TextureLoader().load(map.image, (t) => {
      if (dead) {
        t.dispose()
        return
      }
      t.colorSpace = THREE.NoColorSpace
      t.minFilter = THREE.LinearFilter
      setTex(t)
    })
    return () => {
      dead = true
      setTex((old) => {
        old?.dispose()
        return null
      })
    }
  }, [map])
  if (!map || !tex) return null
  const w = map.width * map.resolution
  const h = map.height * map.resolution
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[map.origin[0] + w / 2, 0.002, map.origin[1] + h / 2]}
      raycast={NO_RAYCAST}
    >
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={tex} transparent opacity={0.34} depthWrite={false} color={P === MAP_THEME.dark ? '#9aa39a' : '#5d6058'} />
    </mesh>
  )
}

function Ground({ bounds }: { bounds: { x: [number, number]; z: [number, number] } }) {
  const P = useMapTheme()
  const [x0, x1] = bounds.x
  const [z0, z1] = bounds.z
  const w = x1 - x0
  const d = z1 - z0
  const grid = useMemo(() => {
    const pts: THREE.Vector3[] = []
    for (let x = Math.ceil(x0 / 4) * 4; x <= x1; x += 4) pts.push(new THREE.Vector3(x, 0, z0), new THREE.Vector3(x, 0, z1))
    for (let z = Math.ceil(z0 / 4) * 4; z <= z1; z += 4) pts.push(new THREE.Vector3(x0, 0, z), new THREE.Vector3(x1, 0, z))
    return new THREE.BufferGeometry().setFromPoints(pts)
  }, [x0, x1, z0, z1])
  const inset = 0.35
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[(x0 + x1) / 2, -0.02, (z0 + z1) / 2]} receiveShadow>
        <planeGeometry args={[w + 12, d + 12]} />
        <meshStandardMaterial color={P.apron} roughness={1} metalness={0} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[(x0 + x1) / 2, -0.01, (z0 + z1) / 2]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color={P.ground} roughness={1} metalness={0} />
      </mesh>
      <lineSegments geometry={grid} position={[0, 0.005, 0]}>
        <lineBasicMaterial color={P.grid} transparent opacity={0.7} />
      </lineSegments>
      {/* site boundary */}
      <Line
        points={[
          [x0 + inset, 0.01, z0 + inset],
          [x1 - inset, 0.01, z0 + inset],
          [x1 - inset, 0.01, z1 - inset],
          [x0 + inset, 0.01, z1 - inset],
          [x0 + inset, 0.01, z0 + inset],
        ]}
        color={P.boundary}
        lineWidth={1}
      />
    </group>
  )
}

function Buildings({ buildings, onMiss }: { buildings: Building[]; onMiss?: () => void }) {
  const P = useMapTheme()
  return (
    <group>
      {buildings.map((b) => {
        const mid = b.tone === 'mid'
        const color = mid ? P.clayMid : P.clay
        if (b.kind === 'box') {
          const w = b.x1 - b.x0
          const d = b.z1 - b.z0
          return (
            <group key={b.id} position={[(b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2]}>
              <mesh position={[0, b.h / 2, 0]} castShadow receiveShadow onClick={onMiss}>
                <boxGeometry args={[w, b.h, d]} />
                <meshStandardMaterial color={color} roughness={0.9} metalness={0} />
                <Edges color={P.clayEdge} threshold={20} opacity={0.32} transparent />
              </mesh>
              {b.name && (
                <Text
                  font={MONO}
                  position={[0, b.h + 0.02, d / 2 - Math.min(0.7, d * 0.24)]}
                  rotation={[-Math.PI / 2, 0, 0]}
                  fontSize={Math.min(0.42, (w * 0.8) / Math.max(4, b.name.length * 0.66))}
                  letterSpacing={0.12}
                  color={P.roofText}
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
              <meshBasicMaterial color={P.clayEdge} transparent opacity={0.3} />
            </mesh>
            {b.name && (
              <Text
                font={MONO}
                position={[0, b.h + 0.02, 0]}
                rotation={[-Math.PI / 2, 0, 0]}
                fontSize={Math.min(0.34, (b.r * 1.5) / Math.max(3, b.name.length * 0.62))}
                letterSpacing={0.1}
                color={P.roofText}
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
  const P = useMapTheme()
  const tone = z.kind === 'restricted' ? P.sev.critical : z.kind === 'charging' ? P.accent : P.zoneNeutral
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
          fontSize={0.46}
          letterSpacing={0.09}
          color={tone}
          fillOpacity={0.95}
          outlineWidth={0.05}
          outlineColor={P.zoneOutline}
          outlineOpacity={0.85}
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

/** billboarded label with a theme-aware backing plate — readable over any surface */
function LabelChip({
  text,
  tone,
  edge,
  active = false,
  y = 0.7,
  size = 0.3,
  pointer = false,
}: {
  text: string
  tone?: string
  edge?: string
  active?: boolean
  y?: number
  size?: number
  pointer?: boolean
}) {
  const P = useMapTheme()
  const w = text.length * size * 0.64 + size * 1.1
  const h = size * 1.7
  const bg = active ? P.accent : P.chipBg
  const fg = active ? P.chipOnActive : (tone ?? P.chipText)
  return (
    <Billboard position={[0, y, 0]}>
      <group raycast={NO_RAYCAST}>
        {/* backing plate + hairline edge */}
        <mesh raycast={NO_RAYCAST}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color={bg} transparent opacity={active ? 0.96 : 0.86} depthWrite={false} />
        </mesh>
        <mesh raycast={NO_RAYCAST} position={[0, 0, -0.001]}>
          <planeGeometry args={[w + 0.05, h + 0.05]} />
          <meshBasicMaterial color={edge ?? (active ? P.accent : P.chipEdge)} transparent opacity={active ? 1 : 0.9} depthWrite={false} />
        </mesh>
        {pointer && (
          <mesh raycast={NO_RAYCAST} position={[0, -h / 2 - 0.07, 0]} rotation={[0, 0, Math.PI]}>
            <circleGeometry args={[0.09, 3, Math.PI / 2]} />
            <meshBasicMaterial color={edge ?? P.chipEdge} transparent opacity={0.95} depthWrite={false} />
          </mesh>
        )}
        <Text
          raycast={NO_RAYCAST}
          font={MONO}
          fontSize={size}
          color={fg}
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.08}
        >
          {text}
        </Text>
      </group>
    </Billboard>
  )
}

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
  const P = useMapTheme()
  const hot = state !== 'normal'
  const checkpoint = wp.id.startsWith('CP')
  const tone = hot ? P.accent : wp.kind === 'dock' ? P.accent : checkpoint ? P.wpBright : P.wpNeutral
  const [hover, setHover] = useState(false)
  const s = hover ? 1.2 : 1
  const shortId = wp.id.replace('WP-', 'W·').replace('CP-', 'CP·').replace('LOT-', 'LOT·')
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
        {/* transparent hit pad — must stay raycastable, so no visible={false} */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
          <circleGeometry args={[0.62, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        {wp.kind === 'dock' && (
          <>
            {/* charge pad: dark disc, lime bolt */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
              <circleGeometry args={[0.4, 28]} />
              <meshBasicMaterial color={P.padBg} transparent opacity={0.9} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
              <ringGeometry args={[0.34, 0.4, 28]} />
              <meshBasicMaterial color={P.accent} />
            </mesh>
            <Text
              raycast={NO_RAYCAST}
              font={MONO}
              position={[0, 0.03, 0.02]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={0.42}
              color={P.accent}
              anchorX="center"
              anchorY="middle"
            >
              ⚡
            </Text>
          </>
        )}
        {wp.kind === 'inspect' && checkpoint && (
          <>
            {/* checkpoint: diamond plate + center dot — the "stop & check" mark */}
            <mesh rotation={[-Math.PI / 2, 0, Math.PI / 4]} position={[0, 0.02, 0]}>
              <ringGeometry args={[0.26, 0.34, 4]} />
              <meshBasicMaterial color={tone} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, Math.PI / 4]} position={[0, 0.015, 0]}>
              <circleGeometry args={[0.26, 4]} />
              <meshBasicMaterial color={P.padBg} transparent opacity={0.72} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
              <circleGeometry args={[0.07, 12]} />
              <meshBasicMaterial color={hot ? P.accent : P.wpDot} />
            </mesh>
          </>
        )}
        {wp.kind === 'inspect' && !checkpoint && (
          <>
            {/* inspect reticle */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <ringGeometry args={[0.2, 0.27, 28]} />
              <meshBasicMaterial color={tone} />
            </mesh>
            {[0, 90, 180, 270].map((a) => (
              <mesh key={a} rotation={[-Math.PI / 2, 0, (a / 180) * Math.PI]} position={[0.31 * Math.cos((a / 180) * Math.PI), 0.02, -0.31 * Math.sin((a / 180) * Math.PI)]}>
                <planeGeometry args={[0.16, 0.05]} />
                <meshBasicMaterial color={tone} />
              </mesh>
            ))}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <circleGeometry args={[0.06, 12]} />
              <meshBasicMaterial color={tone} />
            </mesh>
          </>
        )}
        {wp.kind === 'nav' && (
          <>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <ringGeometry args={[0.09, 0.13, 20]} />
              <meshBasicMaterial color={tone} transparent opacity={0.8} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <circleGeometry args={[0.035, 10]} />
              <meshBasicMaterial color={tone} transparent opacity={0.8} />
            </mesh>
          </>
        )}
      </group>
      {/* labels: checkpoints & docks always carry a chip; nav/inspect reveal on hover */}
      {(checkpoint || wp.kind === 'dock' || hot || hover) && (
        <LabelChip
          text={hover ? `${shortId} ${wp.name.toUpperCase()}` : wp.kind === 'dock' ? 'DOCK' : shortId}
          tone={checkpoint || wp.kind === 'dock' ? P.chipText : P.chipTextDim}
          edge={hot ? P.accent : checkpoint ? P.chipEdge : P.chipEdgeSoft}
          active={hot}
          y={0.66}
          size={0.26}
          pointer
        />
      )}
      {order != null && (
        <Billboard position={[checkpoint || wp.kind === 'dock' ? 0.85 : 0.55, 1.05, 0]}>
          <mesh raycast={NO_RAYCAST}>
            <circleGeometry args={[0.26, 24]} />
            <meshBasicMaterial color={P.accent} />
          </mesh>
          <mesh raycast={NO_RAYCAST} position={[0, 0, -0.001]}>
            <circleGeometry args={[0.3, 24]} />
            <meshBasicMaterial color={P.chipBg} />
          </mesh>
          <Text raycast={NO_RAYCAST} font={MONO} fontSize={0.3} color={P.badgeInk} anchorX="center" anchorY="middle" fontWeight={700}>
            {String(order)}
          </Text>
        </Billboard>
      )}
    </group>
  )
}

function RobotPuck({
  robotId,
  color,
  family,
  callsign,
  selected,
  onClick,
}: {
  robotId: string
  color: string
  family: string
  callsign: string
  selected: boolean
  onClick?: () => void
}) {
  const P = useMapTheme()
  const group = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  const buf = useRef<PoseSnap[]>([])
  const lastTel = useRef<unknown>(null)
  // telemetry arrives at 4 Hz — buffer the snapshots and render the pose as it
  // was INTERP_DELAY_MS ago, linearly interpolated between the two snapshots
  // around that instant: constant velocity between ticks, zero stair-stepping
  useFrame(({ clock }) => {
    const g = group.current
    const tel = useApp.getState().telemetry[robotId]
    if (!g) return
    if (tel && tel !== lastTel.current) {
      lastTel.current = tel
      pushSnap(buf.current, tel.x, tel.z, tel.heading, performance.now())
    }
    const s = sampleSnap(buf.current, performance.now() - INTERP_DELAY_MS)
    g.visible = !!s // no pose yet → stay hidden, never pile up at the origin
    if (!s || !tel) return
    g.position.set(s.x, 0, s.z)
    g.rotation.y = -s.h
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
  const tone = selected ? P.accent : P.unit(color)
  return (
    <group ref={group} visible={false}>
      {/* FOV wedge */}
      <mesh rotation={[-Math.PI / 2, 0, -0.46]} position={[0, 0.03, 0]}>
        <circleGeometry args={[2.35, 26, 0, 0.92]} />
        <meshBasicMaterial color={P.fov} transparent opacity={selected ? 0.14 : 0.08} depthWrite={false} />
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
            <meshStandardMaterial color={P.body} roughness={0.6} />
          </mesh>
        ) : (
          <mesh position={[0, 0.14, 0]} castShadow>
            <cylinderGeometry args={[0.3, 0.34, 0.26, 24]} />
            <meshStandardMaterial color={P.body} roughness={0.6} />
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
      <LabelChip text={callsign} edge={selected ? P.accent : P.unit(color)} active={selected} y={1.12} size={0.3} pointer />
    </group>
  )
}

/** planned-path ribbon — its own 4 Hz subscription so path churn never re-renders the tree.
 *  Drawn from the plan's own points (not the live pose): the dashes hold still
 *  while the puck glides, instead of the whole ribbon twitching every tick. */
function PathLine({ robotId, color, selected }: { robotId: string; color: string; selected: boolean }) {
  const P = useMapTheme()
  const tel = useApp((s) => s.telemetry[robotId])
  if (!tel || tel.path.length < 2) return null
  return (
    <Line
      points={tel.path.map((p) => [p.x, 0.04, p.z] as [number, number, number])}
      color={selected ? P.accent : P.unit(color)}
      lineWidth={selected ? 2 : 1.2}
      dashed
      dashSize={0.32}
      gapSize={0.22}
      transparent
      opacity={selected ? 0.95 : 0.55}
    />
  )
}

function EventPin({ x, z, severity, onClick }: { x: number; z: number; severity: string; onClick?: () => void }) {
  const P = useMapTheme()
  const tone = P.sev[severity] ?? P.sev.info
  const mat = useRef<THREE.MeshBasicMaterial>(null)
  const pulse = useRef<THREE.Mesh>(null)
  const alarm = severity === 'critical' || severity === 'high'
  useFrame(({ clock }) => {
    if (mat.current && severity === 'critical') mat.current.opacity = 0.6 + 0.4 * Math.sin(clock.elapsedTime * 4)
    if (pulse.current && alarm) {
      const k = (clock.elapsedTime % 1.9) / 1.9
      pulse.current.scale.setScalar(0.6 + k * 1.6)
      ;(pulse.current.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - k)
    }
  })
  const stop = onClick
    ? (e: { stopPropagation: () => void }) => {
        e.stopPropagation()
        onClick()
      }
    : undefined
  if (!alarm)
    return (
      <group position={[x, 0, z]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} onClick={stop}>
          <ringGeometry args={[0.12, 0.17, 20]} />
          <meshBasicMaterial color={tone} transparent opacity={0.8} />
        </mesh>
      </group>
    )
  return (
    <group position={[x, 0, z]}>
      {/* ground pulse anchors “where”, the leader line lifts the badge clear of clutter */}
      <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={NO_RAYCAST}>
        <ringGeometry args={[0.24, 0.3, 28]} />
        <meshBasicMaterial color={tone} transparent opacity={0.4} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <circleGeometry args={[0.09, 14]} />
        <meshBasicMaterial color={tone} />
      </mesh>
      <mesh position={[0, 0.42, 0]} raycast={NO_RAYCAST}>
        <cylinderGeometry args={[0.012, 0.012, 0.8, 5]} />
        <meshBasicMaterial color={tone} transparent opacity={0.55} depthTest={false} />
      </mesh>
      {/* alarm badge: outlined triangle + ! — renders through buildings, alarms are never hidden */}
      <Billboard position={[0, 1.0, 0]} renderOrder={40}>
        <mesh onClick={stop} renderOrder={40}>
          <circleGeometry args={[0.33, 3, Math.PI / 2]} />
          <meshBasicMaterial color={P.chipBg} transparent opacity={0.9} depthTest={false} />
        </mesh>
        <mesh raycast={NO_RAYCAST} renderOrder={41} position={[0, 0, 0.001]}>
          <ringGeometry args={[0.26, 0.315, 3, 1, Math.PI / 2]} />
          <meshBasicMaterial ref={mat} color={tone} transparent depthTest={false} />
        </mesh>
        <Text
          raycast={NO_RAYCAST}
          font={MONO}
          renderOrder={42}
          position={[0, -0.045, 0.002]}
          fontSize={0.3}
          color={tone}
          anchorX="center"
          anchorY="middle"
          fontWeight={700}
          material-depthTest={false}
        >
          !
        </Text>
      </Billboard>
    </group>
  )
}

/** frame the whole yard for this viewport: distance from both FOV axes */
function fitHome(width: number, height: number, fovDeg: number, span: { w: number; d: number }) {
  const aspect = width / Math.max(1, height)
  const vfov = (fovDeg * Math.PI) / 180
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect)
  const dV = (span.d + 3) / (2 * Math.tan(vfov / 2))
  const dH = (span.w + 3) / (2 * Math.tan(hfov / 2))
  const dist = Math.min(120, Math.max(dV, dH) * 1.05)
  const dir = new THREE.Vector3(0, 0.76, 0.65).normalize()
  return { pos: dir.multiplyScalar(dist).add(new THREE.Vector3(0, 0, 0.5)), tgt: new THREE.Vector3(0, 0, 0.5) }
}

function CameraRig({
  controls,
  homeRef,
  span,
}: {
  controls: React.RefObject<MapControlsImpl | null>
  homeRef: React.MutableRefObject<{ pos: THREE.Vector3; tgt: THREE.Vector3 }>
  span: { w: number; d: number }
}) {
  const size = useThree((s) => s.size)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const framedFor = useRef('')
  useEffect(() => {
    if (size.width < 60 || size.height < 60) return
    const home = fitHome(size.width, size.height, camera.fov, span)
    homeRef.current = home // reset target follows every resize
    const key = `${span.w}x${span.d}`
    if (framedFor.current === key) return // don't yank the camera mid-interaction
    framedFor.current = key
    camera.position.copy(home.pos)
    if (controls.current) {
      controls.current.target.copy(home.tgt)
      controls.current.update()
    } else {
      camera.lookAt(home.tgt)
    }
  }, [size, camera, controls, homeRef, span])
  return null
}

/** soft fence for panning: the orbit target may not leave the yard (+margin).
 *  The clamp delta is applied to the camera too, so the view stops instead of
 *  stretching — the site can never be dragged out of frame and lost. */
function PanFence({
  controls,
  bounds,
}: {
  controls: React.RefObject<MapControlsImpl | null>
  bounds: { x: [number, number]; z: [number, number] }
}) {
  useFrame(() => {
    const c = controls.current
    if (!c) return
    const m = 3
    const t = c.target
    const nx = THREE.MathUtils.clamp(t.x, bounds.x[0] - m, bounds.x[1] + m)
    const nz = THREE.MathUtils.clamp(t.z, bounds.z[0] - m, bounds.z[1] + m)
    const dx = nx - t.x
    const dz = nz - t.z
    if (dx !== 0 || dz !== 0) {
      t.x = nx
      t.z = nz
      c.object.position.x += dx
      c.object.position.z += dz
      c.update()
    }
    if (t.y !== 0) {
      c.object.position.y -= t.y
      t.y = 0
      c.update()
    }
  })
  return null
}

// camera dolly helper for the +/− buttons
function dolly(controls: MapControlsImpl | null, factor: number) {
  if (!controls) return
  const cam = controls.object as THREE.PerspectiveCamera
  const dir = cam.position.clone().sub(controls.target)
  const len = THREE.MathUtils.clamp(dir.length() * factor, 12, 130)
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
  const P = useMapTheme()
  const site = useApp((s) => s.site)
  const robots = useApp((s) => s.robots)
  const waypoints = useApp((s) => s.waypoints)
  const buildings = useApp((s) => s.buildings)
  const events = useApp((s) => s.events)
  const t = useT()
  const canOperate = useCan('operator')
  const [gotoMenu, setGotoMenu] = useState<Waypoint | null>(null)
  const controls = useRef<MapControlsImpl>(null)
  const homeRef = useRef({ pos: HOME.pos.clone(), tgt: HOME.tgt.clone() })

  const pins = useMemo(
    () => (showEvents ? events.filter((e) => !e.acked).slice(0, 24) : []),
    [events, showEvents],
  )

  if (!site) return <div className={`skeleton ${heightClass} ${className}`} />

  const bounds = { x: site.bounds.x as [number, number], z: site.bounds.z as [number, number] }
  const span = { w: bounds.x[1] - bounds.x[0], d: bounds.z[1] - bounds.z[0] }

  const deselect = () => {
    onSelect?.(null)
    setGotoMenu(null)
  }

  return (
    <div className={`relative touch-none overflow-hidden bg-surface ${heightClass} ${className}`}>
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ position: HOME.pos.toArray() as [number, number, number], fov: 24, near: 0.5, far: 320 }}
        resize={{ polyfill: RafResizeObserver as any, scroll: false, debounce: 0 }}
        onPointerMissed={deselect}
        onCreated={({ setEvents, gl }) =>
          // r3f's eventPrefix compute divides raw client coords by canvas size
          // without subtracting the canvas origin — every embedded map picked
          // offset by its viewport position. Measure the rect per event instead
          // (correct under page scroll, sidebars, and the resize polyfill).
          setEvents({
            compute: (event, state) => {
              const rect = gl.domElement.getBoundingClientRect()
              state.pointer.set(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                (-(event.clientY - rect.top) / rect.height) * 2 + 1,
              )
              state.raycaster.setFromCamera(state.pointer, state.camera)
            },
          })
        }
      >
        <CameraRig controls={controls} homeRef={homeRef} span={span} />
        <PanFence controls={controls} bounds={bounds} />
        <ambientLight intensity={P === MAP_THEME.dark ? 0.85 : 1.0} />
        <hemisphereLight args={P === MAP_THEME.dark ? ['#3a3a38', '#181816', 0.5] : ['#ffffff', '#c9c7ba', 0.55]} />
        <directionalLight
          position={[-14, 26, -10]}
          intensity={1.5}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-26}
          shadow-camera-right={26}
          shadow-camera-top={20}
          shadow-camera-bottom={-20}
          shadow-bias={-0.0004}
        />
        <Suspense fallback={null}>
          <Ground bounds={bounds} />
          {site.map && <OccupancyUnderlay map={site.map} />}
          <Zones labels={labels} />
          <Buildings buildings={buildings} onMiss={interactive ? deselect : undefined} />

          {/* route preview (planner) */}
          {routePreview && routePreview.length > 1 && (
            <Line
              points={routePreview
                .map((id) => waypoints.find((w) => w.id === id))
                .filter(Boolean)
                .map((w) => [w!.x, 0.05, w!.z] as [number, number, number])}
              color={P.accent}
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

          {/* planned paths + robots — pose glides per-frame off transient reads;
              only the path ribbon re-renders on the 4 Hz telemetry beat */}
          {robots.map((r) => {
            const sel = selection?.kind === 'robot' && selection.id === r.id
            return (
              <group key={r.id}>
                <PathLine robotId={r.id} color={r.color} selected={!!sel} />
                <RobotPuck
                  robotId={r.id}
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
          zoomToCursor
          minDistance={12}
          maxDistance={130}
          maxPolarAngle={Math.PI * 0.38}
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

      {/* waypoint teleop menu — dispatching needs the operator role */}
      {gotoMenu && interactive && !onWaypointClick && canOperate && (
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
                  'map.lg.checkpoint',
                  <svg key="c" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <rect x={-0.24} y={-0.24} width={0.48} height={0.48} fill="none" stroke="var(--color-ink-2)" strokeWidth={0.06} transform="rotate(45)" />
                    <circle r={0.07} fill="var(--color-ink)" />
                  </svg>,
                ],
                [
                  'map.lg.inspect',
                  <svg key="i" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.21} fill="none" stroke="var(--color-ink-3)" strokeWidth={0.05} />
                    {[0, 90, 180, 270].map((a) => (
                      <line key={a} x1={0.21} y1={0} x2={0.33} y2={0} stroke="var(--color-ink-3)" strokeWidth={0.05} transform={`rotate(${a})`} />
                    ))}
                    <circle r={0.06} fill="var(--color-ink-3)" />
                  </svg>,
                ],
                [
                  'map.lg.nav',
                  <svg key="n" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.16} fill="none" stroke="var(--color-ink-3)" strokeWidth={0.06} />
                  </svg>,
                ],
                [
                  'map.lg.dock',
                  <svg key="d" viewBox="-0.42 -0.42 0.84 0.84" className="h-3 w-3">
                    <circle r={0.32} fill="none" stroke="var(--color-accent)" strokeWidth={0.05} />
                    <path d="M 0.06 -0.2 L -0.13 0.03 L -0.02 0.03 L -0.05 0.2 L 0.14 -0.03 L 0.03 -0.03 Z" fill="var(--color-accent)" />
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
            <span className="mono text-[10px] text-ink-3/80">
              {site.map ? `occupancy ${Math.round(site.map.resolution * 100)} cm/px · ${site.map.source}` : site.name} · 3D
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
