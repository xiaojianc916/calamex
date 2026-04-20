import { FILE_ICON_GLYPHS } from '@/constants/file-icon-glyphs';
import fileIconMap from '@/constants/file-icon-map.json';
import type {
    IFileIconGlyph,
    IFileIconMap,
    IFileIconResolveOptions,
} from '@/types/file-icon';

const FILE_ICON_MAP = fileIconMap as IFileIconMap;

export type TFileIconKey = keyof typeof FILE_ICON_GLYPHS;

const isFileIconKey = (value: string): value is TFileIconKey =>
    Object.prototype.hasOwnProperty.call(FILE_ICON_GLYPHS, value);

const getFileName = (path: string | null | undefined): string => {
    if (!path) {
        return '';
    }

    const normalizedPath = path.replace(/\\/g, '/');
    const segments = normalizedPath.split('/');
    return (segments[segments.length - 1] ?? '').toLowerCase();
};

const getExtensionCandidates = (fileName: string): string[] => {
    const segments = fileName.split('.');
    if (segments.length <= 1) {
        return [];
    }

    const candidates: string[] = [];
    for (let index = 1; index < segments.length; index += 1) {
        candidates.push(segments.slice(index).join('.'));
    }

    return candidates;
};

const resolveMappedKey = (value: string | undefined): TFileIconKey | null => {
    if (!value || !isFileIconKey(value)) {
        return null;
    }

    return value;
};

const resolveNamedFileIconKey = (fileName: string): TFileIconKey | null => {
    if (fileName === '.env' || fileName.startsWith('.env.')) {
        return 'env';
    }

    if (fileName === 'readme' || fileName.startsWith('readme.')) {
        return 'readme';
    }

    if (
        fileName === 'license'
        || fileName.startsWith('license.')
        || fileName === 'licence'
        || fileName.startsWith('licence.')
    ) {
        return 'license';
    }

    const mappedKey = resolveMappedKey(FILE_ICON_MAP.filenames[fileName]);
    if (mappedKey) {
        return mappedKey;
    }

    if (fileName.endsWith('rc')) {
        return 'config';
    }

    return null;
};

export const resolveFileIconKey = ({
    kind,
    path,
    expanded = false,
}: IFileIconResolveOptions): TFileIconKey => {
    if (kind === 'directory') {
        return expanded ? 'folder-open' : 'folder';
    }

    const fileName = getFileName(path);
    if (!fileName) {
        return 'file';
    }

    const namedKey = resolveNamedFileIconKey(fileName);
    if (namedKey) {
        return namedKey;
    }

    const extensionCandidates = getExtensionCandidates(fileName);

    for (const candidate of extensionCandidates) {
        const mappedCompoundKey = resolveMappedKey(FILE_ICON_MAP.compoundExtensions[candidate]);
        if (mappedCompoundKey) {
            return mappedCompoundKey;
        }
    }

    const extensionCandidate = extensionCandidates[extensionCandidates.length - 1] ?? '';
    const mappedExtensionKey = resolveMappedKey(FILE_ICON_MAP.extensions[extensionCandidate]);
    if (mappedExtensionKey) {
        return mappedExtensionKey;
    }

    return 'file';
};

export const resolveFileIconGlyph = (options: IFileIconResolveOptions): IFileIconGlyph =>
    FILE_ICON_GLYPHS[resolveFileIconKey(options)];