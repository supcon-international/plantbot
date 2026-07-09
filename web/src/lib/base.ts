// Deploy prefix for sub-path hosting (e.g. m3rcyzzz.club/robots).
// '' when served at the root (dev), '/robots' when built with WEB_BASE=/robots/.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
