import Foundation

public struct AgentSessionAttachmentResponse: Codable, Hashable {
    public var attachment: AgentSessionAttachment

    public init(attachment: AgentSessionAttachment) {
        self.attachment = attachment
    }
}
