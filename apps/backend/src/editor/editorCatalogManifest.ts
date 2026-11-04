import { z } from "zod";
import { boundedUtf8String, utf8Bytes } from "./languageServices/text";

export const editorCatalogBounds = {
  languages: 256,
  detectionClaims: 4_096,
  detectionClaimsPerLanguage: 64,
  primaryGrammars: 256,
  scopeGrammars: 512,
  dependenciesPerGrammar: 128,
  dependencyDepth: 8,
  grammarBytes: 2 * 1_024 * 1_024,
  languageConfigBytes: 64 * 1_024,
  wasmBytes: 2 * 1_024 * 1_024,
  aggregateAssetBytes: 32 * 1_024 * 1_024,
  inlineJsonBytes: 2 * 1_024 * 1_024,
  jsonNestingDepth: 32,
  identifierBytes: 64,
  themes: 64,
  themeRules: 4_096,
  scopeBytes: 256,
  claimBytes: 255,
  displayNameBytes: 128,
  pathBytes: 1_024
} as const;

// The visionOS editor resolves its light and dark appearance by these two theme
// names, so a catalog that lacks either would be accepted here and then refused
// whole by every client. Requiring them makes the backend reject it at load and
// log why, so clients keep their bundled assets.
const editorCatalogRequiredThemeNames = ["AgentRoom-Light", "AgentRoom-Dark"] as const;

const boundedString = (name: string, maxBytes: number) =>
  boundedUtf8String(maxBytes, `${name} exceeds ${maxBytes} UTF-8 bytes`, z.string().min(1));

/** A catalog or language-service language identifier, named the way the catalog names it. */
export const languageIdentifierSchema = (label = "identifier") =>
  boundedUtf8String(
    editorCatalogBounds.identifierBytes,
    `${label} exceeds ${editorCatalogBounds.identifierBytes} UTF-8 bytes`,
    z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, `${label} contains unsupported characters`)
  );
const identifierSchema = languageIdentifierSchema();
const claimSchema = boundedString("detection claim", editorCatalogBounds.claimBytes);
const lowerClaimSchema = claimSchema.refine((value) => value === value.toLowerCase(), "claim must be lowercase");
const basenameClaimSchema = claimSchema.refine(
  (value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..",
  "claim must be a basename"
);
const filenameGlobSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._+@*?-]+$/, "glob contains unsupported characters")
  .refine(
    (value) => utf8Bytes(value) <= editorCatalogBounds.claimBytes,
    `glob exceeds ${editorCatalogBounds.claimBytes} UTF-8 bytes`
  )
  .refine((value) => value !== "." && value !== "..", "glob must be a basename")
  .refine((value) => value.includes("*") || value.includes("?"), "glob must contain * or ?");

const editorLanguageSyntaxSourceSchema = z.enum(["monaco", "textmate", "plaintext"]);

const editorLanguageSchema = z
  .object({
    id: identifierSchema,
    displayName: boundedString("display name", editorCatalogBounds.displayNameBytes),
    syntaxSource: editorLanguageSyntaxSourceSchema,
    extensions: z.array(lowerClaimSchema).max(editorCatalogBounds.detectionClaimsPerLanguage).optional(),
    filenames: z.array(basenameClaimSchema).max(editorCatalogBounds.detectionClaimsPerLanguage).optional(),
    filenameGlobs: z.array(filenameGlobSchema).max(editorCatalogBounds.detectionClaimsPerLanguage).optional(),
    compoundSuffixes: z.array(lowerClaimSchema).max(editorCatalogBounds.detectionClaimsPerLanguage).optional(),
    shebangInterpreters: z.array(lowerClaimSchema).max(editorCatalogBounds.detectionClaimsPerLanguage).optional(),
    modelineIds: z.array(lowerClaimSchema).max(editorCatalogBounds.detectionClaimsPerLanguage).optional(),
    aliases: z.array(claimSchema).max(editorCatalogBounds.detectionClaimsPerLanguage).optional()
  })
  .strict();

export const editorLanguageMapSchema = z
  .object({
    version: z.literal(3),
    languages: z.array(editorLanguageSchema).min(1).max(editorCatalogBounds.languages)
  })
  .strict()
  .superRefine((map, context) => {
    const languageIds = new Set<string>();
    const normalizedLanguageIds = new Set<string>();
    const selectors = new Set(map.languages.map((language) => language.id.toLowerCase()));
    const owners = new Map<string, Set<string>>();
    let claimCount = 0;

    for (const [languageIndex, language] of map.languages.entries()) {
      if (languageIds.has(language.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate language id: ${language.id}` });
      }
      languageIds.add(language.id);
      const normalizedLanguageId = language.id.toLowerCase();
      if (normalizedLanguageIds.has(normalizedLanguageId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `language ids must be unique ignoring case: ${language.id}`
        });
      }
      normalizedLanguageIds.add(normalizedLanguageId);

      const allClaimGroups: ReadonlyArray<readonly [string, readonly string[]]> = [
        ["extension", language.extensions ?? []],
        ["filename", language.filenames ?? []],
        ["filenameGlob", language.filenameGlobs ?? []],
        ["compoundSuffix", language.compoundSuffixes ?? []],
        ["shebangInterpreter", language.shebangInterpreters ?? []],
        ["modelineId", language.modelineIds ?? []]
      ];
      const perLanguageClaims = allClaimGroups.reduce((count, [, claims]) => count + claims.length, 0);
      if (perLanguageClaims > editorCatalogBounds.detectionClaimsPerLanguage) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["languages", languageIndex],
          message: `language exceeds ${editorCatalogBounds.detectionClaimsPerLanguage} detection claims`
        });
      }
      claimCount += perLanguageClaims;
      for (const [kind, claims] of allClaimGroups) {
        const local = new Set<string>();
        for (const claim of claims) {
          const key = `${kind}:${kind === "filename" || kind === "filenameGlob" ? claim : claim.toLowerCase()}`;
          if (local.has(key)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate detection claim: ${key}` });
          }
          local.add(key);
          const claimOwners = owners.get(key) ?? new Set<string>();
          claimOwners.add(language.id);
          owners.set(key, claimOwners);
        }
      }

      for (const alias of language.aliases ?? []) {
        const key = alias.toLowerCase();
        if (selectors.has(key)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate language alias: ${alias}` });
        }
        selectors.add(key);
      }
    }

    if (claimCount > editorCatalogBounds.detectionClaims) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `catalog exceeds ${editorCatalogBounds.detectionClaims} detection claims`
      });
    }

    for (const [key, claimOwners] of owners) {
      if (claimOwners.size > 1) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `ambiguous detection claim: ${key}` });
      }
    }
  });

const themeNameSchema = boundedString("theme name", editorCatalogBounds.identifierBytes);
const colorSchema = boundedString("theme color", editorCatalogBounds.identifierBytes);
const monacoThemeRuleSchema = z
  .object({
    // Monaco styles default text with the rule whose token is the empty string.
    token: z.literal("").or(claimSchema),
    foreground: colorSchema.optional(),
    background: colorSchema.optional(),
    fontStyle: boundedString("font style", editorCatalogBounds.identifierBytes).optional()
  })
  .strict();
const monacoThemeSchema = z
  .object({
    base: z.enum(["vs", "vs-dark", "hc-black", "hc-light"]),
    inherit: z.boolean().optional(),
    // False keeps semantic tokens from recoloring the theme's TextMate colors.
    semanticHighlighting: z.boolean().optional(),
    rules: z.array(monacoThemeRuleSchema).max(editorCatalogBounds.themeRules),
    colors: z.record(colorSchema).optional()
  })
  .strict();
const refineThemeMap =
  (label: string) =>
  (themes: Record<string, unknown>, context: z.RefinementCtx): void => {
    const names = Object.keys(themes);
    if (names.length === 0 || names.length > editorCatalogBounds.themes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must contain between 1 and ${editorCatalogBounds.themes} themes`
      });
    }
    for (const name of names) {
      // The editor passes the key to Monaco's `defineTheme`, which throws on any name
      // outside this set and would leave the page without a theme.
      if (!themeNameSchema.safeParse(name).success || !/^[A-Za-z0-9-]+$/.test(name)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `invalid ${label} name: ${name}` });
      }
    }
    for (const required of editorCatalogRequiredThemeNames) {
      if (!(required in themes)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} lacks required theme: ${required}` });
      }
    }
  };

export const editorThemeMapSchema = z.record(monacoThemeSchema).superRefine(refineThemeMap("theme map"));

const textMateSettingsSchema = z
  .object({
    foreground: colorSchema.optional(),
    background: colorSchema.optional(),
    fontStyle: boundedString("font style", editorCatalogBounds.identifierBytes).optional()
  })
  .strict();
const textMateRuleSchema = z
  .object({
    scope: z.union([claimSchema, z.array(claimSchema).max(editorCatalogBounds.themeRules)]).optional(),
    settings: textMateSettingsSchema
  })
  .strict();
const textMateThemeSchema = z
  .object({
    name: themeNameSchema.optional(),
    settings: z.array(textMateRuleSchema).max(editorCatalogBounds.themeRules)
  })
  .strict();
export const editorTextMateThemeMapSchema = z
  .record(textMateThemeSchema)
  .superRefine(refineThemeMap("TextMate theme map"));

const catalogPathSchema = boundedString("catalog path", editorCatalogBounds.pathBytes);
const scopeNameSchema = boundedString("scope name", editorCatalogBounds.scopeBytes);
const provenanceSchema = z
  .object({
    family: identifierSchema,
    source: boundedString("provenance source", editorCatalogBounds.pathBytes),
    version: boundedString("provenance version", editorCatalogBounds.identifierBytes),
    license: boundedString("license", editorCatalogBounds.displayNameBytes)
  })
  .strict();

const grammarIndexEntryBase = {
  scopeName: scopeNameSchema,
  grammar: catalogPathSchema,
  injectionScopes: z.array(scopeNameSchema).max(editorCatalogBounds.dependenciesPerGrammar).optional(),
  provenance: provenanceSchema
};
const primaryGrammarIndexEntrySchema = z
  .object({
    languageId: identifierSchema,
    ...grammarIndexEntryBase,
    languageConfig: catalogPathSchema.optional(),
    embeddedLanguages: z.record(identifierSchema).optional()
  })
  .strict();
const scopeGrammarIndexEntrySchema = z.object(grammarIndexEntryBase).strict();

export const editorGrammarsIndexSchema = z
  .object({
    version: z.number().int().positive().optional(),
    schemaVersion: z.literal(2),
    grammars: z.array(primaryGrammarIndexEntrySchema).max(editorCatalogBounds.primaryGrammars),
    scopeGrammars: z.array(scopeGrammarIndexEntrySchema).max(editorCatalogBounds.scopeGrammars).optional()
  })
  .strict()
  .superRefine((index, context) => {
    for (const entry of index.grammars) {
      if (Object.keys(entry.embeddedLanguages ?? {}).length > editorCatalogBounds.dependenciesPerGrammar) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `too many embedded languages: ${entry.scopeName}` });
      }
      for (const scope of Object.keys(entry.embeddedLanguages ?? {})) {
        if (!scopeNameSchema.safeParse(scope).success) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `invalid embedded scope: ${scope}` });
        }
      }
    }
  });

const editorCatalogAssetRefSchema = z
  .object({
    path: catalogPathSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative()
  })
  .strict();

const assembledGrammarFields = {
  scopeName: scopeNameSchema,
  grammar: editorCatalogAssetRefSchema,
  injectionScopes: z.array(scopeNameSchema).max(editorCatalogBounds.dependenciesPerGrammar).optional(),
  // Derived at assembly from the grammar's own `include` rules, never declared: the
  // catalog scopes this grammar reaches, so a client can load a language's closure
  // and a reader can see which embedded blocks will tokenize.
  dependencyScopes: z.array(scopeNameSchema).max(editorCatalogBounds.dependenciesPerGrammar).optional(),
  provenance: provenanceSchema
};
const editorCatalogGrammarSchema = z
  .object({
    languageId: identifierSchema,
    ...assembledGrammarFields,
    languageConfig: z.string().optional(),
    embeddedLanguages: z.record(identifierSchema).optional()
  })
  .strict();
const editorCatalogScopeGrammarSchema = z.object(assembledGrammarFields).strict();

export const editorCatalogManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    languageMap: editorLanguageMapSchema,
    grammars: z.array(editorCatalogGrammarSchema).max(editorCatalogBounds.primaryGrammars),
    scopeGrammars: z.array(editorCatalogScopeGrammarSchema).max(editorCatalogBounds.scopeGrammars).optional(),
    themes: editorThemeMapSchema,
    textMateThemes: editorTextMateThemeMapSchema,
    engine: z.object({ onigWasm: editorCatalogAssetRefSchema }).strict()
  })
  .strict()
  .superRefine((manifest, context) => {
    const languageIds = new Set(manifest.languageMap.languages.map((language) => language.id));
    const scopes = new Set<string>();
    for (const grammar of [...manifest.grammars, ...(manifest.scopeGrammars ?? [])]) {
      if (scopes.has(grammar.scopeName)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate grammar scope: ${grammar.scopeName}` });
      }
      scopes.add(grammar.scopeName);
    }
    const grammarLanguages = new Set<string>();
    for (const grammar of manifest.grammars) {
      if (!languageIds.has(grammar.languageId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `grammar references unknown language: ${grammar.languageId}` });
      }
      if (grammarLanguages.has(grammar.languageId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate grammar language: ${grammar.languageId}` });
      }
      grammarLanguages.add(grammar.languageId);
      for (const embeddedLanguage of Object.values(grammar.embeddedLanguages ?? {})) {
        if (!languageIds.has(embeddedLanguage)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `unknown embedded language: ${embeddedLanguage}` });
        }
      }
    }
    for (const language of manifest.languageMap.languages) {
      if (language.syntaxSource === "textmate" && !grammarLanguages.has(language.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `TextMate language lacks a grammar: ${language.id}` });
      }
    }
    for (const grammar of [...manifest.grammars, ...(manifest.scopeGrammars ?? [])]) {
      for (const dependency of [...(grammar.injectionScopes ?? []), ...(grammar.dependencyScopes ?? [])]) {
        if (!scopes.has(dependency)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `missing grammar dependency: ${dependency}` });
        }
      }
    }
  });

export type EditorCatalogAssetRef = z.infer<typeof editorCatalogAssetRefSchema>;
export type EditorCatalogGrammar = z.infer<typeof editorCatalogGrammarSchema>;
export type EditorCatalogScopeGrammar = z.infer<typeof editorCatalogScopeGrammarSchema>;
export type EditorCatalogManifest = z.infer<typeof editorCatalogManifestSchema>;
