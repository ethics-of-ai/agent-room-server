import Foundation

extension AgentSession {
    var threadDisplayTitle: String {
        if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            return title
        }
        if let lastMessage = lastMessage?.trimmingCharacters(in: .whitespacesAndNewlines), !lastMessage.isEmpty {
            return lastMessage
        }
        return "Untitled thread"
    }

    var threadWorkspaceName: String {
        URL(fileURLWithPath: workspacePath).lastPathComponent
    }

    var threadSettingsLabel: String {
        let values = [
            settings?.model,
            settings?.reasoningEffort,
            settings?.serviceTier
        ].compactMap { value -> String? in
            guard let value, !value.isEmpty else {
                return nil
            }
            return value
        }
        return values.isEmpty ? "Default Codex settings" : values.joined(separator: " / ")
    }

    var threadContextUsageFraction: Double? {
        guard let used = contextWindowUsedTokens,
              let window = modelContextWindowTokens,
              window > 0 else {
            return nil
        }
        return min(Double(used) / Double(window), 1)
    }

    var threadContextUsageLabel: String {
        guard let used = contextWindowUsedTokens else {
            return "No token usage yet"
        }
        guard let window = modelContextWindowTokens, window > 0 else {
            return "\(used.formatted()) tokens"
        }
        let percent = Double(used) / Double(window)
        return "\(used.formatted()) / \(window.formatted()) tokens (\(percent.formatted(.percent.precision(.fractionLength(1)))))"
    }

    var threadIsRunning: Bool {
        status.lowercased() == "running" || activeTurnId != nil
    }

    var threadRawJSON: String {
        guard let data = try? JSONEncoder.diagnosticsEncoder.encode(self),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }
}

extension AgentSessionMessage {
    var threadRoleLabel: String {
        switch role.lowercased() {
        case "assistant":
            return "Assistant"
        case "user":
            return "User"
        case "system":
            return "System"
        case "tool":
            return "Tool"
        default:
            return role.capitalized
        }
    }

    var threadRoleSystemImage: String {
        switch role.lowercased() {
        case "assistant":
            return "sparkles"
        case "user":
            return "person"
        case "system":
            return "gearshape"
        case "tool":
            return "terminal"
        default:
            return "text.bubble"
        }
    }
}

extension AgentRoomEvent {
    var threadEventSummary: String {
        if let payload = codingPayload {
            return payload.threadEventSummary
        }
        if let error {
            return error
        }
        if let message {
            return message
        }
        return payload.displayString ?? type
    }
}

private extension CodingAgentEventPayload {
    var threadEventSummary: String {
        switch type {
        case .assistantMessageDelta:
            return delta.map { "Assistant delta: \($0)" } ?? "Assistant message updated"
        case .planUpdated:
            if let explanation, !explanation.isEmpty {
                return explanation
            }
            return plan.map { "\($0.count) plan steps" } ?? "Plan updated"
        case .diffUpdated:
            return summary ?? files.map { "\($0.count) files changed" } ?? "Diff updated"
        case .artifactStarted:
            return title.map { "Artifact: \($0)" } ?? "Artifact started"
        case .artifactDelta:
            return "Artifact updated"
        case .artifactCompleted:
            return "Artifact rendered"
        case .toolActivityStarted, .toolActivityUpdated, .toolActivityCompleted:
            let title = activity?.title ?? "Tool activity"
            guard let description = activity?.description, !description.isEmpty else {
                return title
            }
            return "\(title): \(description)"
        case .tokenUsageUpdated:
            return totalTokens.map { "\($0.formatted()) tokens used" } ?? "Token usage updated"
        case .turnStarted:
            return "Turn started"
        case .turnCompleted:
            return "Turn completed"
        case .turnFailed:
            return error ?? "Turn failed"
        case .turnCancelled:
            return "Turn cancelled"
        case .sessionStarted:
            return "Session started"
        case .sessionRestored:
            return "Session restored"
        case .permissionRequested:
            return "Permission requested"
        case .permissionResolved:
            return status.map { "Permission \($0)" } ?? "Permission resolved"
        default:
            // A newer backend's coding event type. The mirror shows the raw id
            // rather than dropping the row, since the event still happened.
            return type.rawValue
        }
    }
}
