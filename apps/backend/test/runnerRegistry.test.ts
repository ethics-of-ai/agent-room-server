import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { agentRunnerKindSchema as domainRunnerKindSchema } from "../src/domain/schemas";
import type { ServiceConfig } from "../src/domain/models";
import {
  agentRunnerKindSchema,
  allRunnerDescriptors,
  isRegisteredRunnerKind,
  managedSettingScope,
  publicRunnerDescriptors,
  runnerManagedSettings,
  registeredRunnerKinds,
  runnerAvailability,
  runnerDescriptor,
  workspaceSkillsAvailable
} from "../src/runner/registry";

const backendSrc = resolve(__dirname, "../src");

const config = (overrides: Partial<ServiceConfig> = {}): ServiceConfig =>
  ({
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: "/tmp/workspaces",
    stateDir: "/tmp/state",
    editorCatalogDir: "/tmp/catalog-assets",
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  }) as ServiceConfig;

describe("runner registry", () => {
  it("registers exactly the runner ids this build ships", () => {
    // The rollout gate from docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md, which
    // opened for `deepseek` on 2026-08-18
    // (docs/engineering/DEEPSEEK_HARNESS_RUNNER.md). It still guards something
    // specific: a bundled id reaches `global.runnerKind`, which is a *known*
    // settings key, so an older AgentRoom that meets a file naming this runner
    // treats the whole file as unusable and drops the operator's trust posture
    // onto defaults. Adding an id here is that decision being made, so this
    // assertion is the gate rather than a tautology.
    expect([...registeredRunnerKinds]).toEqual(["codex", "claude_code", "deepseek"]);
  });

  it("has one descriptor per registered id, keyed by its own id", () => {
    expect(allRunnerDescriptors().map((descriptor) => descriptor.id)).toEqual([...registeredRunnerKinds]);
    for (const kind of registeredRunnerKinds) {
      expect(runnerDescriptor(kind).id).toBe(kind);
      expect(runnerDescriptor(kind).displayName.length).toBeGreaterThan(0);
      // A runner that loads no workspace skills declares no skill directories:
      // the list is what the bounded skills read scans, and scanning for a
      // runner that would ignore the result is what `mode: "none"` rules out.
      expect(runnerDescriptor(kind).skillSourceDirs.length > 0).toBe(
        runnerDescriptor(kind).workspaceSkills.mode !== "none"
      );
      expect(runnerDescriptor(kind).skillInvocationPrefix.length).toBeGreaterThan(0);
    }
  });

  it("is the single source of the runner-id schema the domain re-exports", () => {
    // Not two schemas that agree — the same schema. A second hand-maintained
    // enum is the leak this phase retires.
    expect(domainRunnerKindSchema).toBe(agentRunnerKindSchema);
    for (const kind of registeredRunnerKinds) {
      expect(agentRunnerKindSchema.parse(kind)).toBe(kind);
    }
    expect(agentRunnerKindSchema.safeParse("acp_demo").success).toBe(false);
    expect(isRegisteredRunnerKind("acp_demo")).toBe(false);
    expect(isRegisteredRunnerKind("codex")).toBe(true);
  });

  it("does not treat inherited Object properties as registered runners", () => {
    expect(isRegisteredRunnerKind("toString")).toBe(false);
    expect(isRegisteredRunnerKind("constructor")).toBe(false);
  });

  it("declares the policies the capability matrix specifies", () => {
    const codex = runnerDescriptor("codex");
    expect(codex.promptDelivery).toBe("turn");
    expect(codex.turnDiffSource).toBe("runner");
    expect(codex.clarifyingQuestions.mode).toBe("native");
    expect(codex.workspaceSkills.mode).toBe("native");
    expect([...codex.skillSourceDirs]).toEqual([".codex/skills", ".agents/skills"]);
    expect(codex.skillInvocationPrefix).toBe("$");
    expect(codex.restoreStrategy).toBe("native_resume");

    const claudeCode = runnerDescriptor("claude_code");
    expect(claudeCode.promptDelivery).toBe("system");
    expect(claudeCode.turnDiffSource).toBe("settle_time_git");
    expect(claudeCode.clarifyingQuestions.mode).toBe("native");
    expect(claudeCode.workspaceSkills.mode).toBe("gated");
    expect([...claudeCode.skillSourceDirs]).toEqual([".claude/skills"]);
    expect(claudeCode.skillInvocationPrefix).toBe("/");
    expect(claudeCode.restoreStrategy).toBe("native_resume");

    const deepseek = runnerDescriptor("deepseek");
    // No system-prompt parameter on the SDK wire, and no diff event in the
    // session log, so the standing contract rides the turn prompt and the diff
    // is derived at settlement.
    expect(deepseek.promptDelivery).toBe("turn");
    expect(deepseek.turnDiffSource).toBe("settle_time_git");
    expect(deepseek.clarifyingQuestions.mode).toBe("prompt_contract");
    if (deepseek.clarifyingQuestions.mode === "prompt_contract") {
      expect(deepseek.clarifyingQuestions.instruction).toContain("<agentroom-question>");
    }
    // Whether a composition loads workspace skills is the profile's answer, not
    // one this backend can read off the wire, so the honest report is none —
    // advertising invocations a session would ignore is what the skills read
    // exists to avoid.
    expect(deepseek.workspaceSkills.mode).toBe("none");
    expect([...deepseek.skillSourceDirs]).toEqual([]);
    expect(deepseek.restoreStrategy).toBe("unsupported");
  });

  describe("workspace-skill availability", () => {
    it("is unconditional for a native loader", () => {
      expect(workspaceSkillsAvailable("codex", config())).toBe(true);
      expect(workspaceSkillsAvailable("codex", config({ claudeCodeLoadWorkspaceSkills: false }))).toBe(true);
    });

    it("defers to the adapter's own trust rule for a gated loader", () => {
      // The gate stays Claude Code's: the toggle honored only under
      // `bypassPermissions` (docs/safety/TRUST_AND_SAFETY.md). The registry
      // names that a gate exists; it must not restate what the gate is.
      expect(workspaceSkillsAvailable("claude_code", config())).toBe(true);
      expect(
        workspaceSkillsAvailable("claude_code", config({ claudeCodeLoadWorkspaceSkills: false }))
      ).toBe(false);
      expect(
        workspaceSkillsAvailable("claude_code", config({ claudeCodePermissionMode: "acceptEdits" }))
      ).toBe(false);
    });
  });

  describe("availability states", () => {
    it("reports an unregistered id as registered: false rather than throwing", () => {
      expect(runnerAvailability("acp_demo", config())).toEqual({
        runnerKind: "acp_demo",
        registered: false,
        configured: false,
        enabled: false
      });
    });

    it("separates registered from configured", () => {
      // Collapsing these is what produces the "ready in the UI, unusable by the
      // backend" failure: Codex is registered whether or not the operator has
      // supplied CODEX_EXECUTABLE, and only the second makes it usable.
      expect(runnerAvailability("codex", config())).toEqual({
        runnerKind: "codex",
        registered: true,
        configured: false,
        enabled: true
      });
      expect(runnerAvailability("codex", config({ codexExecutable: "/usr/local/bin/codex" }))).toEqual({
        runnerKind: "codex",
        registered: true,
        configured: true,
        enabled: true
      });
    });

    it("treats Claude Code as configured without an executable path", () => {
      // The Agent SDK resolves its own bundled CLI, so there is no bootstrap
      // value the backend must hold. Whether the operator is signed in is Mac
      // bootstrap readiness — a different authority, and Phase 6's problem.
      expect(runnerAvailability("claude_code", config()).configured).toBe(true);
    });
  });

  describe("managed setting scopes", () => {
    it("keeps every runner's settings prefix unambiguous", () => {
      // One prefix being a prefix of another would silently resolve a runner's
      // keys to its neighbour, so this is the invariant that lets
      // `managedSettingScope` be a loop over descriptors rather than a table.
      const prefixes = allRunnerDescriptors().map((descriptor) => descriptor.settingsKeyPrefix);
      for (const prefix of prefixes) {
        expect(prefix.length).toBeGreaterThan(0);
        expect(prefixes.filter((other) => other !== prefix && other.startsWith(prefix))).toEqual([]);
      }
    });

    it("declares each runner's own managed settings, so adding one is adding a row", () => {
      // Leak 8 of the plan: the per-runner keys used to be spelled out in the
      // settings schema, the env table, the tier table, the defaults map, and
      // both Swift mirrors. A runner that declares them owns them.
      const codex = runnerDescriptor("codex").settings.map((setting) => setting.field);
      expect(codex).toContain("sandboxMode");
      expect(codex).toContain("workspaceNetworkAccess");
      expect(runnerDescriptor("claude_code").settings.map((setting) => setting.field))
        .toContain("permissionMode");

      for (const { runnerKind, key, definition } of runnerManagedSettings()) {
        expect(key.startsWith(runnerDescriptor(runnerKind).settingsKeyPrefix)).toBe(true);
        expect(definition.env).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect([1, 2]).toContain(definition.tier);
        // Every runner setting must reach the settings layer at the address the
        // registry gives it, or a registered runner would have settings the
        // file, the metadata, and the patch schema could not name.
        expect(managedSettingScope(key)).toEqual({ scope: "runner", runnerKind, field: definition.field });
      }
    });

    it("addresses a runner's flat key under its own version-2 namespace", () => {
      expect(managedSettingScope("codexSandboxMode"))
        .toEqual({ scope: "runner", runnerKind: "codex", field: "sandboxMode" });
      expect(managedSettingScope("claudeCodeLoadWorkspaceSkills"))
        .toEqual({ scope: "runner", runnerKind: "claude_code", field: "loadWorkspaceSkills" });
    });

    it("leaves the keys no runner owns global", () => {
      for (const key of ["runnerKind", "terminalEnabled", "gitNetworkTimeoutMs", "artifactsEnabled"]) {
        expect(managedSettingScope(key)).toEqual({ scope: "global" });
      }
    });

    it("requires a case boundary, so a merely similar key belongs to nobody", () => {
      // `codexish` must not become `runners.codex.ish`.
      expect(managedSettingScope("codexish")).toEqual({ scope: "global" });
      expect(managedSettingScope("codex")).toEqual({ scope: "global" });
    });
  });

  describe("public descriptor projection", () => {
    it("carries the display name and the availability states, and nothing else", () => {
      const projected = publicRunnerDescriptors(config({ codexExecutable: "/usr/local/bin/codex" }));

      expect(projected).toEqual([
        { runnerKind: "codex", displayName: "Codex", registered: true, configured: true, enabled: true },
        { runnerKind: "claude_code", displayName: "Claude Code", registered: true, configured: true, enabled: true },
        // Registered but not configured: no DEEPSEEK_EXECUTABLE in this config.
        // The states stay separate precisely so a client cannot read one as
        // another and offer a runner the backend could not start.
        { runnerKind: "deepseek", displayName: "DeepSeek Harness", registered: true, configured: false, enabled: true }
      ]);
    });

    it("projects no policy field a client could act on", () => {
      // The registry answers `promptDelivery`, `turnDiffSource`,
      // `clarifyingQuestions`, `workspaceSkills`, and `restoreStrategy` *for the
      // backend*. Putting them on the wire would invite a client to re-derive a
      // decision the boundary exists to keep on this side of it.
      const serialized = JSON.stringify(publicRunnerDescriptors(config()));
      for (const field of [
        "promptDelivery",
        "turnDiffSource",
        "clarifyingQuestions",
        "workspaceSkills",
        "restoreStrategy",
        "skillSourceDirs",
        "settingsKeyPrefix",
        // A descriptor's settings declare env var names and trust defaults. They
        // are not secret, but they are the backend's own configuration surface,
        // and a client renders settings from `/api/config` — never from here.
        "settings",
        "isConfigured"
      ]) {
        expect(serialized).not.toContain(field);
      }
    });
  });

  describe("acceptance criterion", () => {
    /**
     * The two compatibility shims are the documented exception from Phase 2:
     * they rebuild the legacy per-runner wire blocks and are the only files in
     * the mapper allowed to spell a runner's name. They are deletable whole once
     * the advertised contract floor moves past 2.
     */
    const allowedOutsideRunner = new Set([
      "protocol/coding/legacyMetadata.ts",
      "protocol/coding/legacySessionMetadata.ts"
    ]);

    async function typescriptSources(root: string): Promise<string[]> {
      const found: string[] = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) found.push(...(await typescriptSources(path)));
        else if (entry.name.endsWith(".ts")) found.push(path);
      }
      return found;
    }

    const runnerKindValues = new Set<string>(registeredRunnerKinds);
    const comparisonOperators = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken
    ]);

    /**
     * AST-backed enforcement for the Phase 3 acceptance criterion:
     * **no file outside `runner/` and the registry makes a behavioral decision
     * from runner identity.** A runner id used as a key, a default, a label, or
     * a value passed through is data; equality/switch decisions, membership
     * predicates, and identity-prefix predicates are policy branches.
     *
     * The small constant resolver follows file-local aliases and collections so
     * equivalent syntax cannot evade the check merely by changing quote style,
     * wrapping a comparison over several lines, or moving ids into a Set/array.
     */
    function runnerIdentityDecisionLocations(source: string, fileName = "runner-policy.ts"): string[] {
      const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const bindings = new Map<string, ts.VariableDeclaration[]>();
      const locations = new Set<string>();

      const collectBindings = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const declarations = bindings.get(node.name.text) ?? [];
          declarations.push(node);
          bindings.set(node.name.text, declarations);
        }
        ts.forEachChild(node, collectBindings);
      };
      collectBindings(sourceFile);

      const bindingFor = (identifier: ts.Identifier): ts.Expression | undefined => {
        const referencePosition = identifier.getStart(sourceFile);
        return bindings.get(identifier.text)
          ?.filter((declaration) => {
            let scope: ts.Node = declaration;
            while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) {
              scope = scope.parent;
            }
            return declaration.getStart(sourceFile) < referencePosition
              && scope.getStart(sourceFile) <= referencePosition
              && scope.end >= referencePosition;
          })
          .sort((left, right) => right.getStart(sourceFile) - left.getStart(sourceFile))[0]
          ?.initializer;
      };

      const stringValues = (node: ts.Node, resolving = new Set<string>()): string[] => {
        const values = new Set<string>();
        const visit = (current: ts.Node): void => {
          if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
            values.add(current.text);
            return;
          }
          if (ts.isIdentifier(current)) {
            const initializer = bindingFor(current);
            if (initializer && !resolving.has(current.text)) {
              const nextResolving = new Set(resolving).add(current.text);
              for (const value of stringValues(initializer, nextResolving)) values.add(value);
            }
            return;
          }
          if (ts.isParenthesizedExpression(current)
            || ts.isAsExpression(current)
            || ts.isTypeAssertionExpression(current)
            || ts.isNonNullExpression(current)
            || ts.isSatisfiesExpression(current)) {
            visit(current.expression);
            return;
          }
          if (ts.isArrayLiteralExpression(current)) {
            current.elements.forEach(visit);
            return;
          }
          if (ts.isNewExpression(current)) {
            current.arguments?.forEach(visit);
            return;
          }
          if (ts.isCallExpression(current)) {
            if (ts.isPropertyAccessExpression(current.expression)) {
              visit(current.expression.expression);
            }
            current.arguments.forEach(visit);
            return;
          }
          if (ts.isBinaryExpression(current)) {
            visit(current.left);
            visit(current.right);
            return;
          }
          if (ts.isConditionalExpression(current)) {
            visit(current.condition);
            visit(current.whenTrue);
            visit(current.whenFalse);
            return;
          }
          if (ts.isSpreadElement(current)) visit(current.expression);
        };
        visit(node);
        return [...values];
      };

      const containsRunnerKindReference = (node: ts.Node, resolving = new Set<string>()): boolean => {
        let found = false;
        const visit = (current: ts.Node): void => {
          if (found) return;
          if (ts.isIdentifier(current)) {
            if (current.text.toLowerCase().includes("runnerkind")) {
              found = true;
              return;
            }
            const initializer = bindingFor(current);
            if (initializer && !resolving.has(current.text)) {
              const nextResolving = new Set(resolving).add(current.text);
              found = containsRunnerKindReference(initializer, nextResolving);
            }
            return;
          }
          ts.forEachChild(current, visit);
        };
        visit(node);
        return found;
      };

      const containsRegisteredKind = (node: ts.Node): boolean =>
        stringValues(node).some((value) => runnerKindValues.has(value));

      const containsRegisteredKindFragment = (node: ts.Node): boolean =>
        stringValues(node).some((value) =>
          value.length >= 3
          && registeredRunnerKinds.some((kind) => kind.startsWith(value) || kind.endsWith(value))
        );

      const report = (node: ts.Node): void => {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        locations.add(`${position.line + 1}:${position.character + 1}`);
      };

      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node)
          && comparisonOperators.has(node.operatorToken.kind)
          && containsRegisteredKind(node)) {
          report(node);
        }

        if (ts.isCaseClause(node) && containsRegisteredKind(node.expression)) {
          report(node.expression);
        }

        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          if ((method === "includes" || method === "has") && containsRegisteredKind(node)) {
            report(node);
          }
          if ((method === "startsWith" || method === "endsWith")
            && containsRunnerKindReference(node.expression.expression)
            && node.arguments.some((argument) => containsRegisteredKindFragment(argument))) {
            report(node);
          }
        }

        const condition = ts.isIfStatement(node)
          || ts.isWhileStatement(node)
          || ts.isDoStatement(node)
          || ts.isConditionalExpression(node)
          ? node.expression
          : ts.isForStatement(node)
            ? node.condition
            : undefined;
        if (condition
          && containsRunnerKindReference(condition)
          && containsRegisteredKind(condition)) {
          report(condition);
        }

        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return [...locations].sort();
    }

    it.each([
      ["single-quoted comparisons", "if (runnerKind === 'claude_code') {}"],
      ["multiline comparisons", "if (\n  runnerKind ===\n  \"codex\"\n) {}"],
      ["array membership", "if ([\"claude_code\"].includes(runnerKind)) {}"],
      ["Set membership", "if (new Set([\"codex\"]).has(runnerKind)) {}"],
      ["file-local aliases", "const claude = \"claude_code\"; if (runnerKind === claude) {}"],
      ["scoped aliases", `
        function policy() { const target = "codex"; if (runnerKind === target) {} }
        function presentation() { const target = "display-name"; publish(target); }
      `],
      ["identity-prefix predicates", "if (session.runnerKind.startsWith(\"claude\")) {}"]
    ])("detects %s", (_name, source) => {
      expect(runnerIdentityDecisionLocations(source)).not.toEqual([]);
    });

    it("allows runner ids used as data rather than policy", () => {
      expect(runnerIdentityDecisionLocations(`
        const defaultRunnerKind = "codex";
        const runners = { codex: codexRunner, claude_code: claudeCodeRunner };
        publish({ runnerKind: defaultRunnerKind, runner: runners.codex });
      `)).toEqual([]);
    });

    it("leaves no runner-identity decision outside runner/ and the legacy shims", async () => {
      const offenders: string[] = [];
      for (const path of await typescriptSources(backendSrc)) {
        const relativePath = relative(backendSrc, path);
        // The adapters own their protocol, and the registry is where identity
        // is allowed to decide anything at all.
        if (relativePath.startsWith("runner/")) continue;
        if (allowedOutsideRunner.has(relativePath)) continue;
        const source = await readFile(path, "utf8");
        for (const location of runnerIdentityDecisionLocations(source, relativePath)) {
          offenders.push(`${relativePath}:${location}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
