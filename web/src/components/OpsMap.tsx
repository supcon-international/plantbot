// The operations map is now a true-3D scene (see three/Map3D). This shell
// keeps the old import surface and lazy-loads the heavy three.js chunk.

import { lazy, Suspense, type ComponentProps } from 'react'
import type { Map3D as Map3DType } from '../three/Map3D'

export type { MapSel } from '../three/Map3D'

const Map3D = lazy(() => import('../three/Map3D').then((m) => ({ default: m.Map3D })))

type Props = ComponentProps<typeof Map3DType>

export function OpsMap(props: Props) {
  return (
    <Suspense fallback={<div className={`skeleton ${props.heightClass ?? 'h-[420px]'} ${props.className ?? ''}`} />}>
      <Map3D {...props} />
    </Suspense>
  )
}
