export const baseLanguageServiceEnvironmentKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME"
] as const;

export const jvmLanguageServiceEnvironmentKeys = [
  ...baseLanguageServiceEnvironmentKeys,
  "GRADLE_HOME",
  "JAVA_HOME",
  "MAVEN_HOME"
] as const;

const environmentNamePattern = /^[A-Z_][A-Z0-9_]{0,63}$/;
const credentialNamePattern = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD)$/;

/** Environment names an external language service may receive explicitly. */
export function isGrantableLanguageServiceEnvironmentName(name: string): boolean {
  return environmentNamePattern.test(name)
    && name !== "AUTH_TOKEN"
    && !credentialNamePattern.test(name)
    && !/^(?:ANTHROPIC|OPENAI|CURSOR|DEEPSEEK|AWS)_/.test(name);
}
