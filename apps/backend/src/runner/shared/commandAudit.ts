import { basename } from "node:path";

export function commandAudit(executable: string, args: string[]): { executableName: string; argsCount: number } {
  return {
    executableName: basename(executable),
    argsCount: args.length
  };
}
