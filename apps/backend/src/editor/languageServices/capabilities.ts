/** Fixed client capabilities. Descriptors may not widen the request surface. */
export const languageServiceClientCapabilities = {
  general: { positionEncodings: ["utf-16"] },
  workspace: { configuration: true, workspaceFolders: true },
  window: { workDoneProgress: true },
  textDocument: {
    publishDiagnostics: { relatedInformation: false, versionSupport: true },
    completion: { dynamicRegistration: false },
    hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
    definition: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    semanticTokens: {
      dynamicRegistration: false,
      requests: { full: true, range: false },
      tokenTypes: [
        "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
        "parameter", "variable", "property", "enumMember", "event", "function", "method",
        "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator",
        "decorator"
      ],
      tokenModifiers: [
        "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
        "modification", "documentation", "defaultLibrary"
      ],
      formats: ["relative"]
    }
  }
} as const;
