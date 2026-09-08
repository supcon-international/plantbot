// Shared vendor configuration for managed connectors and the standalone Adapter.
export type ConnectorVendor = 'spot' | 'deeprobotics' | 'gosuncn'

export interface ConnectorField {
  key: string
  label: string
  /** text | number | password */
  type?: 'text' | 'number' | 'password'
  required?: boolean
  placeholder?: string
  hint?: string
}

interface VendorSpec {
  vendor: ConnectorVendor
  title: string
  model: string
  entry: string
  /** vendor-specific connection fields (identity fields are shared) */
  fields: ConnectorField[]
  /** map config → adapter env */
  env: (cfg: Record<string, unknown>) => Record<string, string>
}

const str = (v: unknown, d = '') => (v === undefined || v === null || v === '' ? d : String(v))

/** CALIB-page similarity transform (vendor map → site world) — optional on
 *  vendors that navigate in their own SLAM frame (Spot, X30) */
const TF_FIELDS: ConnectorField[] = [
  { key: 'tfScale', label: 'Calib scale s', type: 'number', hint: 'from Site Builder → CALIB; leave empty if the robot map origin IS the site origin' },
  { key: 'tfTheta', label: 'Calib θ (rad)', type: 'number' },
  { key: 'tfTx', label: 'Calib t.x', type: 'number' },
  { key: 'tfTz', label: 'Calib t.z', type: 'number' },
]

const tfEnv = (c: Record<string, unknown>): Record<string, string> => ({
  ...(str(c.tfScale) ? { PB_TF_SCALE: str(c.tfScale) } : {}),
  ...(str(c.tfTheta) ? { PB_TF_THETA: str(c.tfTheta) } : {}),
  ...(str(c.tfTx) ? { PB_TF_TX: str(c.tfTx) } : {}),
  ...(str(c.tfTz) ? { PB_TF_TZ: str(c.tfTz) } : {}),
})

export const VENDORS: Record<ConnectorVendor, VendorSpec> = {
  spot: {
    vendor: 'spot',
    title: 'Boston Dynamics Spot',
    model: 'Spot',
    entry: 'spot/adapter/main.ts',
    fields: [
      { key: 'host', label: 'Robot IP', required: true, placeholder: '10.0.10.4' },
      { key: 'port', label: 'gRPC port', type: 'number', placeholder: '443' },
      { key: 'user', label: 'Username', required: true, placeholder: 'admin' },
      { key: 'pass', label: 'Password', type: 'password', required: true },
      { key: 'dockX', label: 'Dock X (m)', type: 'number', hint: 'charge-pile pose in world frame' },
      { key: 'dockZ', label: 'Dock Z (m)', type: 'number' },
      { key: 'camStreamId', label: 'Spot CAM stream ID', hint: 'ID of a stream below, or a new ID with its URL' },
      { key: 'camStreamUrl', label: 'Spot CAM stream URL', type: 'password', hint: 'RTSP source for the mechanical PTZ camera' },
      { key: 'camPtz', label: 'Spot CAM PTZ name', placeholder: 'mech' },
      ...TF_FIELDS,
    ],
    env: (c) => ({
      ...(str(c.camStreamId) ? { SPOT_CAM_STREAM_ID: str(c.camStreamId) } : {}),
      ...(str(c.camStreamUrl) ? { SPOT_CAM_STREAM_URL: str(c.camStreamUrl) } : {}),
      ...(str(c.camPtz) ? { SPOT_CAM_PTZ: str(c.camPtz) } : {}),
      SPOT_HOST: str(c.host, '127.0.0.1'),
      SPOT_PORT: str(c.port, '443'),
      SPOT_USER: str(c.user, 'admin'),
      SPOT_PASS: str(c.pass),
      ...tfEnv(c),
    }),
  },
  deeprobotics: {
    vendor: 'deeprobotics',
    title: 'DeepRobotics Jueying X30',
    model: 'Jueying X30',
    entry: 'deeprobotics/adapter/main.ts',
    fields: [
      { key: 'host', label: 'Robot IP', required: true, placeholder: '192.168.1.106' },
      { key: 'port', label: 'robotserver port', type: 'number', placeholder: '30000' },
      { key: 'dockX', label: 'Dock X (m)', type: 'number', required: true, hint: 'charge-pile pose in world frame' },
      { key: 'dockZ', label: 'Dock Z (m)', type: 'number', required: true },
      ...TF_FIELDS,
    ],
    env: (c) => ({
      DR_HOST: str(c.host, '127.0.0.1'),
      DR_PORT: str(c.port, '30000'),
      ...tfEnv(c),
    }),
  },
  gosuncn: {
    vendor: 'gosuncn',
    title: 'Gosuncn GS Patrol F2',
    model: 'GS Patrol F2',
    entry: 'gosuncn/adapter/main.ts',
    fields: [
      { key: 'base', label: 'GoRobot cloud URL', required: true, placeholder: 'http://10.0.0.9:9101' },
      { key: 'user', label: 'Username', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true },
      { key: 'sn', label: 'Vendor SN', required: true, placeholder: 'F2230204117', hint: 'the robot on the GoRobot cloud this connector drives' },
      { key: 'pxPerM', label: 'px per meter', type: 'number', hint: 'from the CALIB page (laser map scale)' },
      { key: 'originX', label: 'Origin X', type: 'number' },
      { key: 'originZ', label: 'Origin Z', type: 'number' },
    ],
    env: (c) => ({
      GOSUNCN_BASE: str(c.base, 'http://127.0.0.1:9101'),
      GOSUNCN_USER: str(c.user),
      GOSUNCN_PASS: str(c.pass),
      ...(str(c.sn) ? { PB_GS_SN: str(c.sn) } : {}),
      ...(c.pxPerM !== undefined && c.pxPerM !== '' ? { GOSUNCN_PX_PER_M: str(c.pxPerM) } : {}),
      ...(c.originX !== undefined && c.originX !== '' ? { GOSUNCN_ORIGIN_X: str(c.originX) } : {}),
      ...(c.originZ !== undefined && c.originZ !== '' ? { GOSUNCN_ORIGIN_Z: str(c.originZ) } : {}),
    }),
  },
}

/** identity fields shared by every vendor (gosuncn's serial comes from its cloud) */
const IDENTITY_FIELDS: ConnectorField[] = [
  { key: 'serial', label: 'Robot serial', required: true, placeholder: 'BD-91250777' },
  { key: 'callsign', label: 'Callsign', placeholder: 'SPOT·W1' },
]

export function connectorCatalog() {
  return Object.values(VENDORS).map((v) => ({
    vendor: v.vendor,
    title: v.title,
    model: v.model,
    identity: IDENTITY_FIELDS,
    fields: v.fields,
    streamsHint: true,
  }))
}

export function validateConnectorConfig(vendor: string, cfg: Record<string, unknown>): string | null {
  const spec = VENDORS[vendor as ConnectorVendor]
  if (!spec) return `unknown vendor '${vendor}'`
  const required = [...IDENTITY_FIELDS, ...spec.fields].filter((f) => f.required)
  for (const f of required) if (str(cfg[f.key]) === '') return `missing required field '${f.key}'`
  const streams = cfg.streams
  if (streams !== undefined && !Array.isArray(streams)) return `'streams' must be an array`
  for (const s of (streams as { name?: unknown; url?: unknown }[]) ?? [])
    if (str(s.name) === '' || str(s.url) === '') return `each stream needs a name and a url`
  return null
}

