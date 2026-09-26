import { registerAgentTool } from "../../src/agentTools/catalog";

// Transport conformance needs a second tool, independent of product features.
export const PROBE_TOOL_LOGICAL_ID = "test.probe";
export const PROBE_TOOL_NAME = "agentroom_test_probe";
registerAgentTool({
  logicalId: PROBE_TOOL_LOGICAL_ID,
  name: PROBE_TOOL_NAME,
  description: "Return a transport probe result.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "string" },
  unavailableResult: "Probe unavailable.",
  requiredCapability: "questions"
});
