// Northbound client — now maintained as the standalone TypeScript SDK
// (@plantbot/adapter-sdk, sdk/adapter-sdk-ts). This module re-exports it so
// the bundled adapters and the SDK can never drift apart: the SDK source IS
// the client the platform's own adapters run.

export {
  PlantbotClient,
  type Logger,
  type MissionStep,
  type PlantbotOrder,
  type Factsheet,
  type StateReport,
  type EventReport,
  type SiteFactsheet,
} from '@plantbot/adapter-sdk'
