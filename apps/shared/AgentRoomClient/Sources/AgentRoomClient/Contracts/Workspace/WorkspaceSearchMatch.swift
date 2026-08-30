import Foundation

/// One literal-substring hit inside a workspace file. `line`, `column`, and
/// `previewColumn` are all 1-indexed (Monaco convention), and `column` and
/// `length` are UTF-16 code-unit offsets. Navigate with `line`/`column` against
/// the file itself; highlight with `previewColumn`/`length` against `preview`,
/// which is the matched line capped at 200 characters centred on the match, so
/// the two column values differ whenever the preview window was shifted.
public struct WorkspaceSearchMatch: Codable, Hashable, Identifiable {
    public var line: Int
    public var column: Int
    public var length: Int
    public var preview: String
    public var previewColumn: Int

    public var id: String { "\(line):\(column)" }

    public init(line: Int, column: Int, length: Int, preview: String, previewColumn: Int) {
        self.line = line
        self.column = column
        self.length = length
        self.preview = preview
        self.previewColumn = previewColumn
    }
}
