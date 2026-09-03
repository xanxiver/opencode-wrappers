import type { AgentInfo, ModelInfo, SessionInfo } from "@opencode-ai/client"

export const makeSessionInfo = (
  input: Pick<SessionInfo, "id"> & Partial<Omit<SessionInfo, "id">>,
): SessionInfo => ({
  projectID: "project",
  location: { directory: "/tmp/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...input,
})

export const makeAgentInfo = (
  input: Pick<AgentInfo, "id" | "name"> & Partial<Omit<AgentInfo, "id" | "name">>,
): AgentInfo => ({
  request: { settings: {}, headers: {}, body: {} },
  mode: "primary",
  hidden: false,
  permissions: [],
  ...input,
})

export const makeModelInfo = (providerID: string, id: string): ModelInfo => ({
  id,
  modelID: id,
  providerID,
  name: id,
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
})
