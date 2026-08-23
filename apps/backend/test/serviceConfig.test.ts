import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getServiceConfig, toPublicConfig } from "../src/config/serviceConfig";

describe("service config", () => {
  it("defaults to Codex local agent bridge integration", () => {
    withCleanEnv(() => {
      const config = getServiceConfig();

      expect(config.runnerKind).toBe("codex");
      expect(config.workspaceRoot).toContain(".agentroom/workspaces");
      expect(config.stateDir).toContain(".agentroom/state");
      expect(config.editorCatalogDir).toContain(".agentroom/catalog-assets");
      expect(config.codexRunnerProtocol).toBe("jsonrpc");
      expect(config.codexApprovalPolicy).toBe("never");
      expect(config.codexSandboxMode).toBe("workspace-write");
      expect(config.codexWorkspaceNetworkAccess).toBe(false);
      expect(config.terminalMaxSessions).toBe(8);
      expect(toPublicConfig(config).codexRunnerProtocol).toBe("jsonrpc");
      expect(toPublicConfig(config)).not.toHaveProperty("terminalMaxSessions");
    });
  });

  it("resolves the global terminal session cap from environment", () => {
    withCleanEnv(() => {
      process.env.TERMINAL_MAX_SESSIONS = "12";

      const config = getServiceConfig();

      expect(config.terminalMaxSessions).toBe(12);
      expect(toPublicConfig(config)).not.toHaveProperty("terminalMaxSessions");
    });
  });

  it("rejects terminal session caps outside the schema bounds", () => {
    withCleanEnv(() => {
      process.env.TERMINAL_MAX_SESSIONS = "0";
      expect(() => getServiceConfig()).toThrow();
    });
    withCleanEnv(() => {
      process.env.TERMINAL_MAX_SESSIONS = "65";
      expect(() => getServiceConfig()).toThrow();
    });
    withCleanEnv(() => {
      process.env.TERMINAL_MAX_SESSIONS = "1.5";
      expect(() => getServiceConfig()).toThrow();
    });
  });

  it("allows exec protocol as an explicit compatibility fallback", () => {
    withCleanEnv(() => {
      process.env.CODEX_RUNNER_PROTOCOL = "exec";

      const config = getServiceConfig();

      expect(config.codexRunnerProtocol).toBe("exec");
      expect(toPublicConfig(config).codexRunnerProtocol).toBe("exec");
    });
  });

  it("resolves Codex reasoning effort from environment", () => {
    withCleanEnv(() => {
      process.env.CODEX_REASONING_EFFORT = "high";

      const config = getServiceConfig();

      expect(config.codexReasoningEffort).toBe("high");
    });
  });

  it("resolves Codex permission and network policy from environment", () => {
    withCleanEnv(() => {
      process.env.CODEX_APPROVAL_POLICY = "on-request";
      process.env.CODEX_SANDBOX_MODE = "workspace-write";
      process.env.CODEX_WORKSPACE_NETWORK_ACCESS = "true";

      const config = getServiceConfig();

      expect(config.codexApprovalPolicy).toBe("on-request");
      expect(config.codexSandboxMode).toBe("workspace-write");
      expect(config.codexWorkspaceNetworkAccess).toBe(true);
      expect(toPublicConfig(config)).toMatchObject({
        codexApprovalPolicy: "on-request",
        codexSandboxMode: "workspace-write",
        codexWorkspaceNetworkAccess: true
      });
    });
  });

  it("defaults claudeCodeLoadWorkspaceSkills to true and exposes it publicly", () => {
    withCleanEnv(() => {
      const config = getServiceConfig();

      expect(config.claudeCodeLoadWorkspaceSkills).toBe(true);
      expect(toPublicConfig(config).claudeCodeLoadWorkspaceSkills).toBe(true);
    });
  });

  it("resolves CLAUDE_CODE_LOAD_WORKSPACE_SKILLS=false for full settings isolation", () => {
    withCleanEnv(() => {
      process.env.CLAUDE_CODE_LOAD_WORKSPACE_SKILLS = "false";

      const config = getServiceConfig();

      expect(config.claudeCodeLoadWorkspaceSkills).toBe(false);
      expect(toPublicConfig(config).claudeCodeLoadWorkspaceSkills).toBe(false);
    });
  });

  it("uses AGENTROOM_HOME for packaged runtime data paths", () => {
    withCleanEnv(() => {
      const agentRoomHome = join("/tmp", "AgentRoom");
      process.env.AGENTROOM_HOME = agentRoomHome;

      const config = getServiceConfig();

      expect(config.agentRoomHome).toBe(agentRoomHome);
      expect(config.workspaceRoot).toBe(join(agentRoomHome, "workspaces"));
      expect(config.stateDir).toBe(join(agentRoomHome, "state"));
      expect(config.editorCatalogDir).toBe(join(agentRoomHome, "catalog-assets"));
      expect(toPublicConfig(config)).toMatchObject({
        agentRoomHome,
        workspaceRoot: join(agentRoomHome, "workspaces"),
        stateDir: join(agentRoomHome, "state")
      });
    });
  });

  it("defaults Claude Code runner settings to subscription auth and bypassPermissions", () => {
    withCleanEnv(() => {
      const config = getServiceConfig();

      expect(config.runnerKind).toBe("codex");
      expect(config.claudeCodePermissionMode).toBe("bypassPermissions");
      expect(config.claudeCodeInheritProviderAuth).toBe(false);
      expect(toPublicConfig(config)).toMatchObject({
        claudeCodePermissionMode: "bypassPermissions",
        claudeCodeInheritProviderAuth: false
      });
    });
  });

  it("resolves Claude Code runner settings from environment", () => {
    withCleanEnv(() => {
      process.env.RUNNER_KIND = "claude_code";
      process.env.CLAUDE_CODE_EXECUTABLE = "/usr/local/bin/claude";
      process.env.CLAUDE_CODE_MODEL = "claude-fable-5";
      process.env.CLAUDE_CODE_REASONING_EFFORT = "xhigh";
      process.env.CLAUDE_CODE_PERMISSION_MODE = "acceptEdits";
      process.env.CLAUDE_CODE_INHERIT_PROVIDER_AUTH = "true";

      const config = getServiceConfig();

      expect(config.runnerKind).toBe("claude_code");
      expect(config.claudeCodeExecutable).toBe("/usr/local/bin/claude");
      expect(config.claudeCodeModel).toBe("claude-fable-5");
      expect(config.claudeCodeReasoningEffort).toBe("xhigh");
      expect(config.claudeCodePermissionMode).toBe("acceptEdits");
      expect(config.claudeCodeInheritProviderAuth).toBe(true);
      expect(toPublicConfig(config).runnerKind).toBe("claude_code");
    });
  });

  it("enables the language catalog by default and keeps the flag out of public config", () => {
    withCleanEnv(() => {
      const config = getServiceConfig();

      expect(config.languageCatalogEnabled).toBe(true);
      // Like artifactsEnabled, the catalog flag is internal; clients discover
      // availability by fetching, so it must not leak into the public config.
      expect(toPublicConfig(config)).not.toHaveProperty("languageCatalogEnabled");
      expect(toPublicConfig(config)).not.toHaveProperty("artifactsEnabled");
    });
  });

  it("disables the language catalog when LANGUAGE_CATALOG_ENABLED is false", () => {
    withCleanEnv(() => {
      process.env.LANGUAGE_CATALOG_ENABLED = "false";

      expect(getServiceConfig().languageCatalogEnabled).toBe(false);
    });
  });

  it("rejects unknown runner kinds and Claude Code permission modes", () => {
    withCleanEnv(() => {
      process.env.RUNNER_KIND = "copilot";
      expect(() => getServiceConfig()).toThrow();
    });
    withCleanEnv(() => {
      process.env.CLAUDE_CODE_PERMISSION_MODE = "plan";
      expect(() => getServiceConfig()).toThrow();
    });
  });

  it("lets explicit workspace and state paths override the app-managed storage defaults", () => {
    withCleanEnv(() => {
      const agentRoomHome = join("/tmp", "AgentRoom");
      process.env.AGENTROOM_HOME = agentRoomHome;
      process.env.WORKSPACE_ROOT = "/Volumes/AgentRoom/workspaces";
      process.env.STATE_DIR = "/Volumes/AgentRoom/state";

      const config = getServiceConfig();

      expect(config.workspaceRoot).toBe("/Volumes/AgentRoom/workspaces");
      expect(config.stateDir).toBe("/Volumes/AgentRoom/state");
    });
  });

  it("lets EDITOR_CATALOG_DIR override the editor catalog directory", () => {
    withCleanEnv(() => {
      process.env.AGENTROOM_HOME = join("/tmp", "AgentRoom");
      process.env.EDITOR_CATALOG_DIR = "/Volumes/AgentRoom/catalog";

      const config = getServiceConfig();

      expect(config.editorCatalogDir).toBe("/Volumes/AgentRoom/catalog");
      // It is an internal filesystem path; clients discover the catalog by fetching.
      expect(toPublicConfig(config)).not.toHaveProperty("editorCatalogDir");
    });
  });
});

function withCleanEnv(run: () => void): void {
  const names = [
    "CODEX_REASONING_EFFORT",
    "CODEX_APPROVAL_POLICY",
    "CODEX_SANDBOX_MODE",
    "CODEX_WORKSPACE_NETWORK_ACCESS",
    "CODEX_RUNNER_PROTOCOL",
    "RUNNER_KIND",
    "CLAUDE_CODE_EXECUTABLE",
    "CLAUDE_CODE_MODEL",
    "CLAUDE_CODE_REASONING_EFFORT",
    "CLAUDE_CODE_PERMISSION_MODE",
    "CLAUDE_CODE_INHERIT_PROVIDER_AUTH",
    "AGENTROOM_HOME",
    "WORKSPACE_ROOT",
    "STATE_DIR",
    "EDITOR_CATALOG_DIR",
    "LANGUAGE_CATALOG_ENABLED",
    "TERMINAL_MAX_SESSIONS"
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    delete process.env[name];
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
