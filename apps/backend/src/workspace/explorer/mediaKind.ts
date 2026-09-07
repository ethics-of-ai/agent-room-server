import { extname } from "node:path";

export type WorkspaceMediaKind = "image" | "pdf" | "usdz";

export function workspaceMediaKind(path: string): WorkspaceMediaKind | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
      return "image";
    case ".pdf":
      return "pdf";
    case ".usdz":
      return "usdz";
    default:
      return undefined;
  }
}

export function workspaceMediaContentType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".usdz":
      return "model/vnd.usdz+zip";
    default:
      return undefined;
  }
}
