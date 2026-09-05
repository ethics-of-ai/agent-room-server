import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [, , logPath, mode = "normal", outsidePath = ""] = process.argv;
let buffer = Buffer.alloc(0);
let activeUri = "";
let activeVersion = 0;
let serverRequestId = 10_000;

function log(event) {
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

const priorStarts = existsSync(logPath)
  ? readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes('"type":"start"')).length
  : 0;
const processNumber = priorStarts + 1;
log({ type: "start", processNumber, pid: process.pid, authToken: process.env.AUTH_TOKEN, apiKey: process.env.OPENAI_API_KEY });
if (mode === "ignore_shutdown") process.on("SIGTERM", () => log({ type: "sigterm", processNumber }));
process.stderr.write("old stderr ".repeat(10_000) + "token=super-secret\nLAST-DIAGNOSTIC");

function encoded(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload]);
}

function send(message) {
  const frame = encoded(message);
  if (mode === "fragmented") {
    process.stdout.write(frame.subarray(0, 7));
    setTimeout(() => process.stdout.write(frame.subarray(7)), 2);
  } else {
    process.stdout.write(frame);
  }
}

function request(method, params) {
  send({ jsonrpc: "2.0", id: serverRequestId++, method, params });
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    log({ type: "server_response", id: message.id, result: message.result, error: message.error });
    return;
  }
  if (message.method === "initialize") {
    if (mode === "oversized") {
      process.stdout.write("Content-Length: 5000000\r\n\r\n");
      return;
    }
    if (mode === "restart_init_fail_once" && processNumber === 2) {
      process.exit(73);
      return;
    }
    const initialized = {
      capabilities: {
        ...(mode === "utf8" ? { positionEncoding: "utf-8" } : {}),
        completionProvider: {},
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        semanticTokensProvider: {
          legend: { tokenTypes: ["class", "function"], tokenModifiers: ["declaration"] },
          full: true
        }
      }
    };
    if (mode === "delayed_initialize") setTimeout(() => response(message.id, initialized), 100);
    else response(message.id, initialized);
    return;
  }
  if (message.method === "initialized") {
    log({ type: "initialized", processNumber });
    if (mode === "server_requests") {
      request("window/workDoneProgress/create", { token: "build" });
      request("workspace/configuration", { items: [{ section: "swift" }, { section: "editor" }] });
      request("workspace/applyEdit", { edit: { changes: {} } });
      request("window/showMessageRequest", { message: "approve", actions: [{ title: "Yes" }] });
      request("client/registerCapability", { registrations: [] });
    }
    return;
  }
  if (message.method === "textDocument/didOpen") {
    activeUri = message.params.textDocument.uri;
    activeVersion = message.params.textDocument.version;
    log({ type: "open", processNumber, document: message.params.textDocument });
    if (mode === "crash_loop") process.exit(71);
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: activeUri,
        version: activeVersion,
        diagnostics: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
          message: "<b>problem</b> `here`",
          severity: 2,
          source: "fake",
          code: 7
        }]
      }
    });
    return;
  }
  if (message.method === "textDocument/didChange") {
    activeVersion = message.params.textDocument.version;
    log({ type: "change", processNumber, version: activeVersion, text: message.params.contentChanges[0].text });
    if (["crash_once", "restart_init_fail_once"].includes(mode) && processNumber === 1) process.exit(71);
    return;
  }
  if (message.method === "textDocument/didClose") {
    log({ type: "close", processNumber, uri: message.params.textDocument.uri });
    return;
  }
  if (message.method === "$/cancelRequest") {
    log({ type: "cancel", id: message.params.id });
    return;
  }
  if (message.method === "textDocument/completion") {
    log({ type: "request", processNumber, method: message.method, position: message.params.position });
    if (mode === "timeout") return;
    if (mode === "invalid_error") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: "not-a-number", message: "invalid" } });
      return;
    }
    response(message.id, { items: [
      { label: "value", kind: 6, detail: "a `detail`", documentation: { kind: "markdown", value: "[docs](command:bad)" }, textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "replacement" } },
      { label: "greet(name: string): void", kind: 3, insertText: "greet", insertTextFormat: 1 },
      { label: "command", kind: 3, command: { command: "run" } },
      { label: "snippet", kind: 3, insertTextFormat: 2, insertText: "${1:value}" }
    ] });
    return;
  }
  if (message.method === "textDocument/hover") {
    response(message.id, { contents: { kind: "markdown", value: "<script>x</script> **hover**" }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } });
    return;
  }
  if (message.method === "textDocument/definition") {
    const locations = [{ uri: activeUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } }];
    if (outsidePath) locations.push({ uri: new URL(`file://${outsidePath}`).toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
    response(message.id, locations);
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    response(message.id, [{ name: "Thing", kind: 23, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, children: [] }]);
    return;
  }
  if (message.method === "textDocument/semanticTokens/full") {
    response(message.id, { data: [0, 0, 2, 0, 0] });
    return;
  }
  if (message.method === "shutdown") {
    log({ type: "shutdown", processNumber });
    if (mode === "ignore_shutdown") return;
    response(message.id, null);
    return;
  }
  if (message.method === "exit") {
    log({ type: "exit", processNumber });
    process.exit(0);
  }
}

function parse() {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
    if (!match) process.exit(72);
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    handle(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  parse();
});
