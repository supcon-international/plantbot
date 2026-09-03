/**
 * RobotSilhouette — inline SVG side-view line art for robot families that have
 * no URDF twin yet (fleet-card / detail placeholder, in place of a 3D turntable).
 *
 * Carbon industrial look: straight lines, mitered corners, `currentColor` stroke
 * at 1.5px, no fills/gradients; the only curves are the wheels and the PTZ dome.
 * The SVG carries a viewBox but no intrinsic size — the caller sets width via
 * `className` and height follows the aspect ratio.
 */
export function RobotSilhouette({ family, className }: { family: 'ugv' | 'quadruped'; className?: string }) {
  return (
    <svg
      viewBox="0 0 160 90"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="miter"
      strokeLinecap="butt"
      role="img"
      aria-hidden="true"
    >
      {family === 'ugv' ? <Ugv /> : <Quadruped />}
    </svg>
  )
}

/** Wheeled security patrol vehicle (e.g. GS Patrol F2): boxy body, wheels, a
 *  roof mast carrying a PTZ dome, and a side status-light bar. */
function Ugv() {
  return (
    <g>
      {/* ground */}
      <line x1="26" y1="78" x2="134" y2="78" opacity="0.35" />
      {/* off-side wheels — imply a four-wheel chassis behind the near pair */}
      <g opacity="0.45">
        <circle cx="44" cy="67" r="6" />
        <circle cx="106" cy="67" r="6" />
      </g>
      {/* boxy chassis with a slight front bevel */}
      <path d="M30 66 V50 L38 44 H116 L128 52 V66 Z" />
      {/* side status-light bar + LED segments */}
      <rect x="42" y="56" width="60" height="4" />
      <line x1="58" y1="56" x2="58" y2="60" />
      <line x1="74" y1="56" x2="74" y2="60" />
      <line x1="90" y1="56" x2="90" y2="60" />
      {/* front sensor block */}
      <rect x="119" y="54" width="6" height="7" />
      {/* roof mast + PTZ gimbal dome (with lens) */}
      <line x1="80" y1="44" x2="80" y2="26" />
      <circle cx="80" cy="20" r="6" />
      <circle cx="83" cy="20" r="1.8" />
      {/* near-side wheels (tyre + hub) */}
      <circle cx="48" cy="70" r="8" />
      <circle cx="48" cy="70" r="2.5" />
      <circle cx="110" cy="70" r="8" />
      <circle cx="110" cy="70" r="2.5" />
    </g>
  )
}

/** Simplified side-view quadruped: chamfered torso, top lidar puck, front sensor
 *  head, and four bent legs (near pair solid, off-side pair faded). */
function Quadruped() {
  return (
    <g>
      {/* ground */}
      <line x1="28" y1="78" x2="132" y2="78" opacity="0.35" />
      {/* off-side legs — imply the far pair behind the near legs */}
      <g opacity="0.45">
        <polyline points="64,52 59,64 64,75" />
        <polyline points="98,52 103,64 98,75" />
      </g>
      {/* chamfered torso box */}
      <path d="M48 33 H112 L118 39 V47 L112 53 H48 L42 47 V39 Z" />
      {/* top lidar/sensor puck */}
      <rect x="72" y="27" width="14" height="6" />
      {/* front sensor head + lens */}
      <path d="M118 37 L134 41 V49 L118 51" />
      <circle cx="129" cy="45" r="2" />
      {/* near-side legs (hip → knee → foot) */}
      <polyline points="54,52 48,64 54,76" />
      <polyline points="108,52 114,64 108,76" />
      {/* feet */}
      <line x1="50" y1="76" x2="58" y2="76" />
      <line x1="104" y1="76" x2="112" y2="76" />
    </g>
  )
}
