import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import availableFigSpecs from '@withfig/autocomplete';

interface FigDefinition {
  name?: unknown;
  description?: unknown;
  hidden?: unknown;
  deprecated?: unknown;
  isOptional?: unknown;
  isVariadic?: unknown;
  insertValue?: unknown;
  loadSpec?: unknown;
  arg?: unknown;
  args?: unknown;
  options?: unknown;
  subcommands?: unknown;
  suggestions?: unknown;
  [key: string]: unknown;
}

interface ValueSuggestionSpec {
  names: string[];
  detail?: string;
  priority?: number;
  insertText?: string;
  insertAsSnippet?: boolean;
}

interface ArgumentSpec {
  label: string;
  detail?: string;
  isOptional?: boolean;
  isVariadic?: boolean;
  suggestions?: ValueSuggestionSpec[];
}

interface OptionSpec {
  names: string[];
  detail?: string;
  priority?: number;
  insertText?: string;
  insertAsSnippet?: boolean;
  arg?: ArgumentSpec;
  args?: ArgumentSpec[];
}

interface CommandNode {
  names: string[];
  detail?: string;
  priority?: number;
  args?: ArgumentSpec[];
  flags?: OptionSpec[];
  subcommands?: CommandNode[];
}

const ROOT_SPEC_NAMES = [
  'ansible',
  'ansible-playbook',
  'apt',
  'cargo',
  'crontab',
  'curl',
  'df',
  'dig',
  'docker',
  'du',
  'fdisk',
  'find',
  'git',
  'grep',
  'helm',
  'htop',
  'kill',
  'killall',
  'kubectl',
  'lsblk',
  'lsof',
  'mount',
  'nc',
  'nmap',
  'npm',
  'pip',
  'pnpm',
  'podman',
  'ps',
  'python',
  'rsync',
  'scp',
  'sed',
  'sftp',
  'ssh',
  'systemctl',
  'tar',
  'top',
  'traceroute',
  'uname',
  'uv',
  'visudo',
  'wget',
  'yarn',
];

const GENERATED_PLACEHOLDER_PATTERN = /^Fig generated (?:command|option|argument|value)\b/i;

const require = createRequire(import.meta.url);
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);
const workspaceRoot = path.resolve(currentDirectory, '..');
const autocompleteBuildDirectory = path.dirname(require.resolve('@withfig/autocomplete'));
const generatedDirectory = path.join(workspaceRoot, 'src', 'generated', 'shell-catalog');
const generatedIndexFilePath = path.join(generatedDirectory, 'index.json');
const legacyOutputFilePath = path.join(
  workspaceRoot,
  'src',
  'generated',
  'fig-shell-command-catalog.ts',
);

const availableSpecSet = new Set<string>(availableFigSpecs as string[]);
const specCache = new Map<string, Promise<FigDefinition | null>>();

const toArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }

  if (value == null) {
    return [];
  }

  return [value];
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

const normalizeDetail = (value: unknown): string | undefined => {
  const normalizedDetail = normalizeText(value);
  if (!normalizedDetail || GENERATED_PLACEHOLDER_PATTERN.test(normalizedDetail)) {
    return undefined;
  }

  return normalizedDetail;
};

const normalizeNames = (value: unknown): string[] => {
  const names: string[] = [];
  const seenNames = new Set<string>();

  for (const rawName of toArray(value)) {
    const normalizedName = normalizeText(rawName);
    if (!normalizedName || seenNames.has(normalizedName)) {
      continue;
    }

    seenNames.add(normalizedName);
    names.push(normalizedName);
  }

  return names;
};

const selectPrimaryName = (names: string[]): string | null => names[0] ?? null;

const normalizeInsertValue = (
  value: unknown,
): { insertText?: string; insertAsSnippet?: boolean } => {
  if (typeof value !== 'string' || value.length === 0) {
    return {};
  }

  if (!value.includes('{cursor}')) {
    return {
      insertText: value,
    };
  }

  return {
    insertText: value.replaceAll('{cursor}', '${1}'),
    insertAsSnippet: true,
  };
};

const toOptionArgumentList = (entry: OptionSpec): ArgumentSpec[] => {
  if (entry.arg) {
    return [entry.arg];
  }

  return entry.args ?? [];
};

const toOptionArgumentFields = (
  argumentList: ArgumentSpec[],
): { arg?: ArgumentSpec; args?: ArgumentSpec[] } => {
  if (argumentList.length === 0) {
    return {};
  }

  if (argumentList.length === 1) {
    return {
      arg: argumentList[0],
    };
  }

  return {
    args: argumentList,
  };
};

const pruneValueSuggestionSpec = (suggestionSpec: ValueSuggestionSpec): ValueSuggestionSpec => {
  const prunedSuggestionSpec: ValueSuggestionSpec = {
    names: suggestionSpec.names,
  };

  if (suggestionSpec.detail) {
    prunedSuggestionSpec.detail = suggestionSpec.detail;
  }

  if (typeof suggestionSpec.priority === 'number') {
    prunedSuggestionSpec.priority = suggestionSpec.priority;
  }

  if (suggestionSpec.insertText) {
    prunedSuggestionSpec.insertText = suggestionSpec.insertText;
  }

  if (suggestionSpec.insertAsSnippet) {
    prunedSuggestionSpec.insertAsSnippet = true;
  }

  return prunedSuggestionSpec;
};

const pruneArgumentSpec = (argumentSpec: ArgumentSpec): ArgumentSpec => {
  const prunedArgumentSpec: ArgumentSpec = {
    label: argumentSpec.label,
  };

  if (argumentSpec.detail) {
    prunedArgumentSpec.detail = argumentSpec.detail;
  }

  if (argumentSpec.isOptional) {
    prunedArgumentSpec.isOptional = true;
  }

  if (argumentSpec.isVariadic) {
    prunedArgumentSpec.isVariadic = true;
  }

  if (argumentSpec.suggestions?.length) {
    prunedArgumentSpec.suggestions = argumentSpec.suggestions;
  }

  return prunedArgumentSpec;
};

const pruneOptionSpec = (optionSpec: OptionSpec): OptionSpec => {
  const prunedOptionSpec: OptionSpec = {
    names: optionSpec.names,
  };

  if (optionSpec.detail) {
    prunedOptionSpec.detail = optionSpec.detail;
  }

  if (typeof optionSpec.priority === 'number') {
    prunedOptionSpec.priority = optionSpec.priority;
  }

  if (optionSpec.insertText) {
    prunedOptionSpec.insertText = optionSpec.insertText;
  }

  if (optionSpec.insertAsSnippet) {
    prunedOptionSpec.insertAsSnippet = true;
  }

  Object.assign(prunedOptionSpec, toOptionArgumentFields(toOptionArgumentList(optionSpec)));

  return prunedOptionSpec;
};

const pruneCommandNode = (commandNode: CommandNode): CommandNode => {
  const prunedCommandNode: CommandNode = {
    names: commandNode.names,
  };

  if (commandNode.detail) {
    prunedCommandNode.detail = commandNode.detail;
  }

  if (typeof commandNode.priority === 'number') {
    prunedCommandNode.priority = commandNode.priority;
  }

  if (commandNode.args?.length) {
    prunedCommandNode.args = commandNode.args;
  }

  if (commandNode.flags?.length) {
    prunedCommandNode.flags = commandNode.flags;
  }

  if (commandNode.subcommands?.length) {
    prunedCommandNode.subcommands = commandNode.subcommands;
  }

  return prunedCommandNode;
};

const sharesName = (leftEntry: { names: string[] }, rightEntry: { names: string[] }): boolean => {
  const leftNames = new Set(leftEntry.names);
  return rightEntry.names.some((name) => leftNames.has(name));
};

const mergeNames = (primaryNames: string[], secondaryNames: string[]): string[] => {
  const mergedNames: string[] = [];
  const seenNames = new Set<string>();

  for (const name of [...primaryNames, ...secondaryNames]) {
    if (!name || seenNames.has(name)) {
      continue;
    }

    seenNames.add(name);
    mergedNames.push(name);
  }

  return mergedNames;
};

const mergeValueSuggestionSpec = (
  baseSuggestionSpec: ValueSuggestionSpec,
  overrideSuggestionSpec: ValueSuggestionSpec,
): ValueSuggestionSpec =>
  pruneValueSuggestionSpec({
    names: mergeNames(overrideSuggestionSpec.names, baseSuggestionSpec.names),
    detail: overrideSuggestionSpec.detail || baseSuggestionSpec.detail,
    insertText: overrideSuggestionSpec.insertText ?? baseSuggestionSpec.insertText,
    insertAsSnippet: overrideSuggestionSpec.insertAsSnippet ?? baseSuggestionSpec.insertAsSnippet,
    priority: overrideSuggestionSpec.priority ?? baseSuggestionSpec.priority,
  });

const mergeValueSuggestionList = (
  baseSuggestions: ValueSuggestionSpec[],
  overrideSuggestions: ValueSuggestionSpec[],
): ValueSuggestionSpec[] => {
  const mergedSuggestions = [...baseSuggestions];

  for (const overrideSuggestion of overrideSuggestions) {
    const matchedSuggestionIndex = mergedSuggestions.findIndex((baseSuggestion) =>
      sharesName(baseSuggestion, overrideSuggestion),
    );
    if (matchedSuggestionIndex === -1) {
      mergedSuggestions.push(overrideSuggestion);
      continue;
    }

    mergedSuggestions[matchedSuggestionIndex] = mergeValueSuggestionSpec(
      mergedSuggestions[matchedSuggestionIndex],
      overrideSuggestion,
    );
  }

  return mergedSuggestions;
};

const mergeArgumentSpec = (
  baseArgumentSpec: ArgumentSpec,
  overrideArgumentSpec: ArgumentSpec,
): ArgumentSpec =>
  pruneArgumentSpec({
    label: overrideArgumentSpec.label || baseArgumentSpec.label,
    detail: overrideArgumentSpec.detail || baseArgumentSpec.detail,
    isOptional: overrideArgumentSpec.isOptional ?? baseArgumentSpec.isOptional,
    isVariadic: overrideArgumentSpec.isVariadic ?? baseArgumentSpec.isVariadic,
    suggestions: mergeValueSuggestionList(
      baseArgumentSpec.suggestions ?? [],
      overrideArgumentSpec.suggestions ?? [],
    ),
  });

const mergeArgumentList = (
  baseArguments: ArgumentSpec[],
  overrideArguments: ArgumentSpec[],
): ArgumentSpec[] => {
  if (baseArguments.length === 0) {
    return overrideArguments;
  }

  if (overrideArguments.length === 0) {
    return baseArguments;
  }

  const mergedArguments: ArgumentSpec[] = [];
  const mergedLength = Math.max(baseArguments.length, overrideArguments.length);

  for (let index = 0; index < mergedLength; index += 1) {
    const baseArgument = baseArguments[index] ?? null;
    const overrideArgument = overrideArguments[index] ?? null;

    if (baseArgument && overrideArgument) {
      mergedArguments.push(mergeArgumentSpec(baseArgument, overrideArgument));
      continue;
    }

    if (overrideArgument) {
      mergedArguments.push(overrideArgument);
      continue;
    }

    if (baseArgument) {
      mergedArguments.push(baseArgument);
    }
  }

  return mergedArguments;
};

const mergeOptionSpec = (
  baseOptionSpec: OptionSpec,
  overrideOptionSpec: OptionSpec,
): OptionSpec => {
  const mergedArguments = mergeArgumentList(
    toOptionArgumentList(baseOptionSpec),
    toOptionArgumentList(overrideOptionSpec),
  );

  return pruneOptionSpec({
    names: mergeNames(overrideOptionSpec.names, baseOptionSpec.names),
    detail: overrideOptionSpec.detail || baseOptionSpec.detail,
    insertText: overrideOptionSpec.insertText ?? baseOptionSpec.insertText,
    insertAsSnippet: overrideOptionSpec.insertAsSnippet ?? baseOptionSpec.insertAsSnippet,
    priority: overrideOptionSpec.priority ?? baseOptionSpec.priority,
    ...toOptionArgumentFields(mergedArguments),
  });
};

const mergeOptionList = (
  baseOptions: OptionSpec[],
  overrideOptions: OptionSpec[],
): OptionSpec[] => {
  const mergedOptions = [...baseOptions];

  for (const overrideOption of overrideOptions) {
    const matchedOptionIndex = mergedOptions.findIndex((baseOption) =>
      sharesName(baseOption, overrideOption),
    );
    if (matchedOptionIndex === -1) {
      mergedOptions.push(overrideOption);
      continue;
    }

    mergedOptions[matchedOptionIndex] = mergeOptionSpec(
      mergedOptions[matchedOptionIndex],
      overrideOption,
    );
  }

  return mergedOptions;
};

const mergeCommandNode = (
  baseCommandNode: CommandNode,
  overrideCommandNode: CommandNode,
): CommandNode =>
  pruneCommandNode({
    names: mergeNames(overrideCommandNode.names, baseCommandNode.names),
    detail: overrideCommandNode.detail || baseCommandNode.detail,
    priority: overrideCommandNode.priority ?? baseCommandNode.priority,
    args: mergeArgumentList(baseCommandNode.args ?? [], overrideCommandNode.args ?? []),
    flags: mergeOptionList(baseCommandNode.flags ?? [], overrideCommandNode.flags ?? []),
    subcommands: mergeCommandList(
      baseCommandNode.subcommands ?? [],
      overrideCommandNode.subcommands ?? [],
    ),
  });

const mergeCommandList = (
  baseCommands: CommandNode[],
  overrideCommands: CommandNode[],
): CommandNode[] => {
  const mergedCommands = [...baseCommands];

  for (const overrideCommand of overrideCommands) {
    const matchedCommandIndex = mergedCommands.findIndex((baseCommand) =>
      sharesName(baseCommand, overrideCommand),
    );
    if (matchedCommandIndex === -1) {
      mergedCommands.push(overrideCommand);
      continue;
    }

    mergedCommands[matchedCommandIndex] = mergeCommandNode(
      mergedCommands[matchedCommandIndex],
      overrideCommand,
    );
  }

  return mergedCommands;
};

const loadSpecFile = async (specName: string): Promise<FigDefinition | null> => {
  if (specCache.has(specName)) {
    return specCache.get(specName)!;
  }

  const specPromise = (async (): Promise<FigDefinition | null> => {
    try {
      const specFilePath = path.join(autocompleteBuildDirectory, `${specName}.js`);
      const importedModule = await import(pathToFileURL(specFilePath).href);
      return importedModule.default ?? null;
    } catch (error) {
      console.warn(
        `Skipping Fig spec '${specName}': ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  })();

  specCache.set(specName, specPromise);
  return specPromise;
};

const resolveLoadedSpec = async (
  specDefinition: unknown,
  loadSpecStack: Set<string> = new Set(),
): Promise<FigDefinition | null> => {
  if (!specDefinition || typeof specDefinition !== 'object') {
    return null;
  }

  const definition = specDefinition as FigDefinition;
  const loadSpecName = typeof definition.loadSpec === 'string' ? definition.loadSpec : null;
  if (!loadSpecName || loadSpecStack.has(loadSpecName)) {
    return definition;
  }

  const nextLoadSpecStack = new Set(loadSpecStack);
  nextLoadSpecStack.add(loadSpecName);

  const loadedSpec = await loadSpecFile(loadSpecName);
  if (!loadedSpec) {
    return definition;
  }

  const resolvedLoadedSpec = await resolveLoadedSpec(loadedSpec, nextLoadSpecStack);
  return {
    ...resolvedLoadedSpec,
    ...definition,
    description:
      normalizeText(definition.description) || normalizeText(resolvedLoadedSpec?.description) || '',
    args: toArray(definition.args).length > 0 ? definition.args : resolvedLoadedSpec?.args,
    options: [...toArray(resolvedLoadedSpec?.options), ...toArray(definition.options)],
    subcommands: [...toArray(resolvedLoadedSpec?.subcommands), ...toArray(definition.subcommands)],
  } as FigDefinition;
};

const transformValueSuggestion = (suggestionDefinition: unknown): ValueSuggestionSpec | null => {
  if (!suggestionDefinition) {
    return null;
  }

  if (typeof suggestionDefinition === 'string') {
    const normalizedName = normalizeText(suggestionDefinition);
    if (!normalizedName) {
      return null;
    }

    return pruneValueSuggestionSpec({
      names: [normalizedName],
    });
  }

  if (typeof suggestionDefinition !== 'object') {
    return null;
  }

  const definition = suggestionDefinition as FigDefinition;
  const suggestionNames = normalizeNames(definition.name ?? definition.insertValue);
  const primarySuggestionName = selectPrimaryName(suggestionNames);
  if (!primarySuggestionName) {
    return null;
  }

  return pruneValueSuggestionSpec({
    names: suggestionNames,
    detail: normalizeDetail(definition.description),
    ...normalizeInsertValue(definition.insertValue),
  });
};

const transformArgument = (argumentDefinition: unknown): ArgumentSpec | null => {
  if (!argumentDefinition || typeof argumentDefinition !== 'object') {
    return null;
  }

  const definition = argumentDefinition as FigDefinition;
  const argumentLabel = normalizeText(definition.name) || 'value';
  const transformedSuggestions: ValueSuggestionSpec[] = [];
  for (const suggestionDefinition of toArray(definition.suggestions)) {
    const transformedSuggestion = transformValueSuggestion(suggestionDefinition);
    if (transformedSuggestion) {
      transformedSuggestions.push(transformedSuggestion);
    }
  }

  return pruneArgumentSpec({
    label: argumentLabel,
    detail: normalizeDetail(definition.description),
    isOptional: Boolean(definition.isOptional),
    isVariadic: Boolean(definition.isVariadic),
    suggestions: mergeValueSuggestionList([], transformedSuggestions),
  });
};

const transformOption = async (optionDefinition: unknown): Promise<OptionSpec | null> => {
  const definition = optionDefinition as FigDefinition | null;
  if (!definition || definition.hidden || definition.deprecated) {
    return null;
  }

  const optionNames = normalizeNames(definition.name);
  const primaryOptionName = selectPrimaryName(optionNames);
  if (!primaryOptionName) {
    return null;
  }

  const argumentDefinitions = toArray(definition.args);
  const transformedArgs: ArgumentSpec[] = [];
  for (const argumentDefinition of argumentDefinitions) {
    const transformedArgument = transformArgument(argumentDefinition);
    if (transformedArgument) {
      transformedArgs.push(transformedArgument);
    }
  }

  if (argumentDefinitions.length > 0 && transformedArgs.length === 0) {
    transformedArgs.push(
      pruneArgumentSpec({
        label: 'value',
      }),
    );
  }

  return pruneOptionSpec({
    names: optionNames,
    detail: normalizeDetail(definition.description),
    ...toOptionArgumentFields(mergeArgumentList([], transformedArgs)),
  });
};

const transformCommand = async (
  commandDefinition: unknown,
  loadSpecStack: Set<string> = new Set(),
): Promise<CommandNode | null> => {
  const definition = commandDefinition as FigDefinition | null;
  if (!definition || definition.hidden || definition.deprecated) {
    return null;
  }

  const resolvedCommandDefinition = await resolveLoadedSpec(definition, loadSpecStack);
  if (!resolvedCommandDefinition) {
    return null;
  }

  const commandNames = normalizeNames(resolvedCommandDefinition.name);
  const primaryCommandName = selectPrimaryName(commandNames);
  if (!primaryCommandName) {
    return null;
  }

  const transformedFlags: OptionSpec[] = [];
  for (const optionDefinition of toArray(resolvedCommandDefinition.options)) {
    const transformedOption = await transformOption(optionDefinition);
    if (transformedOption) {
      transformedFlags.push(transformedOption);
    }
  }

  const transformedArgs: ArgumentSpec[] = [];
  for (const argumentDefinition of toArray(resolvedCommandDefinition.args)) {
    const transformedArgument = transformArgument(argumentDefinition);
    if (transformedArgument) {
      transformedArgs.push(transformedArgument);
    }
  }

  const transformedSubcommands: CommandNode[] = [];
  for (const subcommandDefinition of toArray(resolvedCommandDefinition.subcommands)) {
    const transformedSubcommand = await transformCommand(subcommandDefinition, loadSpecStack);
    if (transformedSubcommand) {
      transformedSubcommands.push(transformedSubcommand);
    }
  }

  return pruneCommandNode({
    names: commandNames,
    detail: normalizeDetail(resolvedCommandDefinition.description),
    args: mergeArgumentList([], transformedArgs),
    flags: mergeOptionList([], transformedFlags),
    subcommands: mergeCommandList([], transformedSubcommands),
  });
};

const generateCommandCatalog = async (): Promise<CommandNode[]> => {
  const missingRootSpecs = ROOT_SPEC_NAMES.filter((specName) => !availableSpecSet.has(specName));
  if (missingRootSpecs.length > 0) {
    console.warn(`Unavailable Fig root specs: ${missingRootSpecs.join(', ')}`);
  }

  const generatedCommands: CommandNode[] = [];
  for (const specName of ROOT_SPEC_NAMES) {
    if (!availableSpecSet.has(specName)) {
      continue;
    }

    const specDefinition = await loadSpecFile(specName);
    if (!specDefinition) {
      continue;
    }

    const transformedCommand = await transformCommand(specDefinition);
    if (transformedCommand) {
      generatedCommands.push(transformedCommand);
    }
  }

  return mergeCommandList([], generatedCommands);
};

const formatJson = async (value: unknown): Promise<string> => `${JSON.stringify(value, null, 2)}\n`;

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === code;

const readTextFileIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }
};

const writeFileIfChanged = async (filePath: string, fileContent: string): Promise<boolean> => {
  const existingContent = await readTextFileIfExists(filePath);
  if (existingContent === fileContent) {
    return false;
  }

  await writeFile(filePath, fileContent, 'utf8');
  return true;
};

const writeGeneratedCatalog = async (
  generatedCatalog: CommandNode[],
): Promise<{ updatedFileCount: number }> => {
  await mkdir(generatedDirectory, { recursive: true });

  const indexEntries: Array<{ label: string; file: string; aliases?: string[]; detail?: string }> =
    [];
  const nextFileNames = new Set(['index.json']);
  let updatedFileCount = 0;

  for (const commandSpec of generatedCatalog) {
    const label = selectPrimaryName(commandSpec.names);
    if (!label) {
      continue;
    }

    const fileName = `${label}.json`;
    nextFileNames.add(fileName);
    const aliases = commandSpec.names.slice(1);
    indexEntries.push({
      label,
      file: fileName,
      aliases: aliases.length > 0 ? aliases : undefined,
      detail: commandSpec.detail,
    });

    const fileContent = await formatJson(commandSpec);
    if (await writeFileIfChanged(path.join(generatedDirectory, fileName), fileContent)) {
      updatedFileCount += 1;
    }
  }

  const indexFileContent = await formatJson({ commands: indexEntries });
  if (await writeFileIfChanged(generatedIndexFilePath, indexFileContent)) {
    updatedFileCount += 1;
  }

  const existingEntries = await readdir(generatedDirectory, { withFileTypes: true });
  for (const entry of existingEntries) {
    if (!entry.isFile() || nextFileNames.has(entry.name)) {
      continue;
    }

    await rm(path.join(generatedDirectory, entry.name), { force: true });
    updatedFileCount += 1;
  }

  await rm(legacyOutputFilePath, { force: true });

  return {
    updatedFileCount,
  };
};

const generatedCatalog = await generateCommandCatalog();
const { updatedFileCount } = await writeGeneratedCatalog(generatedCatalog);

console.log(
  `Generated ${generatedCatalog.length} Fig root command specs at ${path.relative(
    workspaceRoot,
    generatedDirectory,
  )} (${updatedFileCount} files updated)`,
);
