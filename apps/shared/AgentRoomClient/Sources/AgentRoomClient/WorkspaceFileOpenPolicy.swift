import Foundation

public enum WorkspaceFileOpenDecision: Equatable, Sendable {
    case media(WorkspaceMediaKind)
    case text
    case unavailable
    case unsupportedMetadata(WorkspaceFileMetadataProblem)
}

public enum WorkspaceFileMetadataProblem: Equatable, Sendable {
    case unknownKind(String)
    case kindMismatch(reported: WorkspaceMediaKind, inferred: WorkspaceMediaKind?)
}

public enum WorkspaceFileOpenPolicy {
    public static func decision(
        path: String,
        mediaKind: String?,
        previewable: Bool?,
        pathOnly: Bool = false
    ) -> WorkspaceFileOpenDecision {
        let reportedText = mediaKind?.trimmingCharacters(in: .whitespacesAndNewlines)
        let reported = reportedText.flatMap(WorkspaceMediaKind.init(rawValue:))
        let inferred = WorkspaceMediaKind.inferred(from: path)

        if let reportedText, !reportedText.isEmpty, reported == nil {
            return .unsupportedMetadata(.unknownKind(reportedText))
        }
        if let reported, reported != inferred {
            return .unsupportedMetadata(.kindMismatch(reported: reported, inferred: inferred))
        }
        if let inferred {
            return .media(inferred)
        }
        if previewable == true || pathOnly {
            return .text
        }
        return .unavailable
    }
}
