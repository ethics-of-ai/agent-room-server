import type { AgentSession, AgentSessionMessageContext, AgentTurnContext } from "../domain/models";
import type { AgentRunnerInputPart } from "../runner/AgentRunner";
import { runnerDescriptor } from "../runner/registry";
import { WorkspaceExplorer, WorkspaceExplorerError } from "../workspace/WorkspaceExplorer";
import { AgentAttachmentError, AgentAttachmentStore } from "./AgentAttachmentStore";

export interface AssembledAgentTurnInput {
  prompt: string;
  inputParts: AgentRunnerInputPart[];
  messageContext?: AgentSessionMessageContext;
  acknowledgePromptContext?(): void;
}

export class AgentTurnContextAssemblyError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export class AgentTurnContextAssembler {
  constructor(
    private readonly deps: {
      workspaceExplorer: Pick<WorkspaceExplorer, "promptWithContext">;
      attachments: Pick<AgentAttachmentStore, "contextAttachmentsForTurn" | "inputPartsForTurn">;
      // Prepended to every assembled prompt when artifacts are enabled; omitted
      // (undefined) disables the in-band artifact convention for prompts.
      artifactInstruction?: string;
      // Standing spatial-diagram contract, prepended when the scene engine is
      // enabled; omitted (undefined) disables it. claude_code turns skip it
      // here because their runner delivers the same string once via the SDK
      // session's system prompt (runner/claudeCode/settings.ts) — per-turn injection
      // would double-deliver it.
      diagramInstruction?: string;
      // Volatile counterpart to that contract: what the human adjusted in a
      // diagram's override layer since this session's last turn. Unlike the
      // contract it goes to BOTH runner kinds per turn — a value that changes
      // between turns cannot live in Claude Code's stable, cached system prompt,
      // where it would both spoil the cache and go stale.
      diagramHumanEdits?: {
        prepareSummaryForTurn(session: AgentSession): Promise<{ summary?: string; acknowledge(): void } | undefined>;
      };
      // The other volatile diagram injection (visual-refinement Phase 6 slice
      // 1): what the diagrams this session's last turn wrote actually rendered
      // as — validation errors and compose warnings gathered at that turn's
      // settlement. Same flag, same delivery rules as the human-edit summary:
      // per turn, both runner kinds, consumed only when the turn is accepted.
      // Async because preparation waits out the session's in-flight settlement
      // reads (it never starts one), so an immediate follow-up turn still
      // carries the previous turn's feedback.
      diagramRenderFeedback?: {
        prepareSummaryForTurn(session: AgentSession): Promise<{ summary?: string; acknowledge(): void } | undefined>;
      };
    }
  ) {}

  async assemble(input: {
    session: AgentSession;
    message: string;
    context?: AgentTurnContext;
  }): Promise<AssembledAgentTurnInput> {
    try {
      const contextPrompt = await this.deps.workspaceExplorer.promptWithContext(
        input.session.workspaceId,
        input.message,
        input.context?.paths
      );
      const humanEditSummary = await this.deps.diagramHumanEdits?.prepareSummaryForTurn(input.session);
      // Render feedback precedes the human-edit summary: it closes the loop on
      // the agent's own last write before the prompt moves on to what the human
      // changed since.
      const renderFeedback = await this.deps.diagramRenderFeedback?.prepareSummaryForTurn(input.session);
      // The standing diagram contract is constant, so a runner whose descriptor
      // says `system` has already had it installed once by its own adapter
      // (Claude Code appends it to the cached SDK system prompt); repeating it
      // per turn would spoil that cache. The two volatile injections below are
      // not standing values and ride the turn prompt for every runner kind.
      const standingInstructionsRideTheTurn =
        runnerDescriptor(input.session.runnerKind).promptDelivery === "turn";
      const instructions = [
        this.deps.artifactInstruction,
        standingInstructionsRideTheTurn ? this.deps.diagramInstruction : undefined,
        renderFeedback?.summary,
        humanEditSummary?.summary
      ].filter((value): value is string => value !== undefined);
      const prompt = instructions.length > 0
        ? `${instructions.join("\n\n")}\n\n${contextPrompt}`
        : contextPrompt;
      const inputParts = await this.deps.attachments.inputPartsForTurn(input.session.id, input.context?.attachments);
      const contextAttachments = await this.deps.attachments.contextAttachmentsForTurn(
        input.session.id,
        input.context?.attachments
      );
      const messageContext = messageContextFromTurnContext(input.context, contextAttachments);
      const acknowledgements = [humanEditSummary?.acknowledge, renderFeedback?.acknowledge]
        .filter((value): value is () => void => value !== undefined);
      return {
        prompt,
        inputParts,
        ...(messageContext ? { messageContext } : {}),
        ...(acknowledgements.length > 0
          ? {
              acknowledgePromptContext: () => {
                for (const acknowledge of acknowledgements) acknowledge();
              }
            }
          : {})
      };
    } catch (error) {
      if (error instanceof WorkspaceExplorerError || error instanceof AgentAttachmentError) {
        throw new AgentTurnContextAssemblyError(error.message, error.statusCode);
      }
      throw error;
    }
  }
}

function messageContextFromTurnContext(
  context: AgentTurnContext | undefined,
  attachments: AgentSessionMessageContext["attachments"]
): AgentSessionMessageContext | undefined {
  const paths = context?.paths?.filter((path) => path.trim().length > 0);
  const messageContext: AgentSessionMessageContext = {};
  if (paths?.length) {
    messageContext.paths = [...new Set(paths)];
  }
  if (attachments?.length) {
    messageContext.attachments = attachments;
  }
  return messageContext.paths?.length || messageContext.attachments?.length
    ? messageContext
    : undefined;
}
