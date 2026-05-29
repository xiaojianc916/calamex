import availableFigSpecs from '@withfig/autocomplete';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const legacyOutputFilePath = path.join(workspaceRoot, 'src', 'generated', 'fig-shell-command-catalog.ts');

const availableSpecSet = new Set(availableFigSpecs);
const specCache = new Map();

const toArray = (value) => {
    if (Array.isArray(value)) {
        return value;
    }

    if (value == null) {
        return [];
    }

    return [value];
};

const normalizeText = (value) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

const normalizeDetail = (value) => {
    const normalizedDetail = normalizeText(value);
    if (!normalizedDetail || GENERATED_PLACEHOLDER_PATTERN.test(normalizedDetail)) {
        return undefined;
    }

    return normalizedDetail;
};

const normalizeNames = (value) => {
    const names = [];
    const seenNames = new Set();

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

const selectPrimaryName = (names) => names[0] ?? null;

const normalizeInsertValue = (value) => {
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

const toOptionArgumentList = (entry) => {
    if (entry.arg) {
        return [entry.arg];
    }

    return entry.args ?? [];
};

const toOptionArgumentFields = (argumentList) => {
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

const pruneValueSuggestionSpec = (suggestionSpec) => {
    const prunedSuggestionSpec = {
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

const pruneArgumentSpec = (argumentSpec) => {
    const prunedArgumentSpec = {
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

const pruneOptionSpec = (optionSpec) => {
    const prunedOptionSpec = {
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

const pruneCommandNode = (commandNode) => {
    const prunedCommandNode = {
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

const sharesName = (leftEntry, rightEntry) => {
    const leftNames = new Set(leftEntry.names);
    return rightEntry.names.some((name) => leftNames.has(name));
};

const mergeNames = (primaryNames, secondaryNames) => {
    const mergedNames = [];
    const seenNames = new Set();

    for (const name of [...primaryNames, ...secondaryNames]) {
        if (!name || seenNames.has(name)) {
            continue;
        }

        seenNames.add(name);
        mergedNames.push(name);
    }

    return mergedNames;
};

const mergeValueSuggestionSpec = (baseSuggestionSpec, overrideSuggestionSpec) =>
    pruneValueSuggestionSpec({
        names: mergeNames(overrideSuggestionSpec.names, baseSuggestionSpec.names),
        detail: overrideSuggestionSpec.detail || baseSuggestionSpec.detail,
        insertText: overrideSuggestionSpec.insertText ?? baseSuggestionSpec.insertText,
        insertAsSnippet: overrideSuggestionSpec.insertAsSnippet ?? baseSuggestionSpec.insertAsSnippet,
        priority: overrideSuggestionSpec.priority ?? baseSuggestionSpec.priority,
    });

const mergeValueSuggestionList = (baseSuggestions, overrideSuggestions) => {
    const mergedSuggestions = [...baseSuggestions];

    for (const overrideSuggestion of overrideSuggestions) {
        const matchedSuggestionIndex = mergedSuggestions.findIndex((baseSuggestion) =>
            sharesName(baseSuggestion, overrideSuggestion));
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

const mergeArgumentSpec = (baseArgumentSpec, overrideArgumentSpec) =>
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

const mergeArgumentList = (baseArguments, overrideArguments) => {
    if (baseArguments.length === 0) {
        return overrideArguments;
    }

    if (overrideArguments.length === 0) {
        return baseArguments;
    }

    const mergedArguments = [];
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

const mergeOptionSpec = (baseOptionSpec, overrideOptionSpec) => {
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

const mergeOptionList = (baseOptions, overrideOptions) => {
    const mergedOptions = [...baseOptions];

    for (const overrideOption of overrideOptions) {
        const matchedOptionIndex = mergedOptions.findIndex((baseOption) =>
            sharesName(baseOption, overrideOption));
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

const mergeCommandNode = (baseCommandNode, overrideCommandNode) =>
    pruneCommandNode({
        names: mergeNames(overrideCommandNode.names, baseCommandNode.names),
        detail: overrideCommandNode.detail || baseCommandNode.detail,
        priority: overrideCommandNode.priority ?? baseCommandNode.priority,
        args: mergeArgumentList(baseCommandNode.args ?? [], overrideCommandNode.args ?? []),
        flags: mergeOptionList(baseCommandNode.flags ?? [], overrideCommandNode.flags ?? []),
        subcommands: mergeCommandList(baseCommandNode.subcommands ?? [], overrideCommandNode.subcommands ?? []),
    });

const mergeCommandList = (baseCommands, overrideCommands) => {
    const mergedCommands = [...baseCommands];

    for (const overrideCommand of overrideCommands) {
        const matchedCommandIndex = mergedCommands.findIndex((baseCommand) =>
            sharesName(baseCommand, overrideCommand));
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

const loadSpecFile = async (specName) => {
    if (specCache.has(specName)) {
        return specCache.get(specName);
    }

    const specPromise = (async () => {
        try {
            const specFilePath = path.join(autocompleteBuildDirectory, `${specName}.js`);
            const importedModule = await import(pathToFileURL(specFilePath).href);
            return importedModule.default ?? null;
        } catch (error) {
            console.warn(`Skipping Fig spec '${specName}': ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    })();

    specCache.set(specName, specPromise);
    return specPromise;
};

const resolveLoadedSpec = async (specDefinition, loadSpecStack = new Set()) => {
    if (!specDefinition || typeof specDefinition !== 'object') {
        return null;
    }

    const loadSpecName = typeof specDefinition.loadSpec === 'string' ? specDefinition.loadSpec : null;
    if (!loadSpecName || loadSpecStack.has(loadSpecName)) {
        return specDefinition;
    }

    const nextLoadSpecStack = new Set(loadSpecStack);
    nextLoadSpecStack.add(loadSpecName);

    const loadedSpec = await loadSpecFile(loadSpecName);
    if (!loadedSpec) {
        return specDefinition;
    }

    const resolvedLoadedSpec = await resolveLoadedSpec(loadedSpec, nextLoadSpecStack);
    return {
        ...resolvedLoadedSpec,
        ...specDefinition,
        description:
            normalizeText(specDefinition.description) || normalizeText(resolvedLoadedSpec?.description) || '',
        args: toArray(specDefinition.args).length > 0 ? specDefinition.args : resolvedLoadedSpec?.args,
        options: [...toArray(resolvedLoadedSpec?.options), ...toArray(specDefinition.options)],
        subcommands: [...toArray(resolvedLoadedSpec?.subcommands), ...toArray(specDefinition.subcommands)],
    };
};

const transformValueSuggestion = (suggestionDefinition) => {
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

    const suggestionNames = normalizeNames(suggestionDefinition.name ?? suggestionDefinition.insertValue);
    const primarySuggestionName = selectPrimaryName(suggestionNames);
    if (!primarySuggestionName) {
        return null;
    }

    return pruneValueSuggestionSpec({
        names: suggestionNames,
        detail: normalizeDetail(suggestionDefinition.description),
        ...normalizeInsertValue(suggestionDefinition.insertValue),
    });
};

const transformArgument = (argumentDefinition) => {
    if (!argumentDefinition || typeof argumentDefinition !== 'object') {
        return null;
    }

    const argumentLabel = normalizeText(argumentDefinition.name) || 'value';
    const transformedSuggestions = [];
    for (const suggestionDefinition of toArray(argumentDefinition.suggestions)) {
        const transformedSuggestion = transformValueSuggestion(suggestionDefinition);
        if (transformedSuggestion) {
            transformedSuggestions.push(transformedSuggestion);
        }
    }

    return pruneArgumentSpec({
        label: argumentLabel,
        detail: normalizeDetail(argumentDefinition.description),
        isOptional: Boolean(argumentDefinition.isOptional),
        isVariadic: Boolean(argumentDefinition.isVariadic),
        suggestions: mergeValueSuggestionList([], transformedSuggestions),
    });
};

const transformOption = async (optionDefinition) => {
    if (!optionDefinition || optionDefinition.hidden || optionDefinition.deprecated) {
        return null;
    }

    const optionNames = normalizeNames(optionDefinition.name);
    const primaryOptionName = selectPrimaryName(optionNames);
    if (!primaryOptionName) {
        return null;
    }

    const argumentDefinitions = toArray(optionDefinition.args);
    const transformedArgs = [];
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
        detail: normalizeDetail(optionDefinition.description),
        ...toOptionArgumentFields(mergeArgumentList([], transformedArgs)),
    });
};

const transformCommand = async (commandDefinition, loadSpecStack = new Set()) => {
    if (!commandDefinition || commandDefinition.hidden || commandDefinition.deprecated) {
        return null;
    }

    const resolvedCommandDefinition = await resolveLoadedSpec(commandDefinition, loadSpecStack);
    if (!resolvedCommandDefinition) {
        return null;
    }

    const commandNames = normalizeNames(resolvedCommandDefinition.name);
    const primaryCommandName = selectPrimaryName(commandNames);
    if (!primaryCommandName) {
        return null;
    }

    const transformedFlags = [];
    for (const optionDefinition of toArray(resolvedCommandDefinition.options)) {
        const transformedOption = await transformOption(optionDefinition);
        if (transformedOption) {
            transformedFlags.push(transformedOption);
        }
    }

    const transformedArgs = [];
    for (const argumentDefinition of toArray(resolvedCommandDefinition.args)) {
        const transformedArgument = transformArgument(argumentDefinition);
        if (transformedArgument) {
            transformedArgs.push(transformedArgument);
        }
    }

    const transformedSubcommands = [];
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

const generateCommandCatalog = async () => {
    const missingRootSpecs = ROOT_SPEC_NAMES.filter((specName) => !availableSpecSet.has(specName));
    if (missingRootSpecs.length > 0) {
        console.warn(`Unavailable Fig root specs: ${missingRootSpecs.join(', ')}`);
    }

    const generatedCommands = [];
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

const formatJson = async (value) => `${JSON.stringify(value, null, 2)}\n`;

const hasErrorCode = (error, code) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const readTextFileIfExists = async (filePath) => {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return null;
        }

        throw error;
    }
};

const writeFileIfChanged = async (filePath, fileContent) => {
    const existingContent = await readTextFileIfExists(filePath);
    if (existingContent === fileContent) {
        return false;
    }

    await writeFile(filePath, fileContent, 'utf8');
    return true;
};

const writeGeneratedCatalog = async (generatedCatalog) => {
    await mkdir(generatedDirectory, { recursive: true });

    const indexEntries = [];
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