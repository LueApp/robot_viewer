/**
 * File operation utility functions
 */

/**
 * Read file content as text
 */
export function readFileContent(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

/**
 * Get File object from file system entry
 */
export function getFileFromEntry(entry) {
    return new Promise((resolve, reject) => {
        entry.file(resolve, reject);
    });
}

/**
 * Recursively read directory
 */
export async function readDirectory(dirEntry, fileMap) {
    const files = [];
    const reader = dirEntry.createReader();
    while (true) {
        const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!entries.length) return files;
        for (const entry of entries) {
            if (entry.isDirectory) {
                files.push(...await readDirectory(entry, fileMap));
            } else if (entry.isFile) {
                const file = await getFileFromEntry(entry);
                fileMap.set(entry.fullPath || entry.name, file);
                files.push(file);
            }
        }
    }
}

export async function readDirectoryHandle(directory, assets, path = directory.name) {
    for await (const entry of directory.values()) {
        const childPath = path + '/' + entry.name;
        if (entry.kind === 'directory') await readDirectoryHandle(entry, assets, childPath);
        else assets.set(childPath, await entry.getFile());
    }
}

/**
 * Get file type from extension
 */
export function getFileTypeFromExtension(ext) {
    const typeMap = {
        'urdf': 'urdf',
        'xacro': 'xacro',
        'xml': 'mjcf',
        'usd': 'usd',
        'usda': 'usd',
        'usdc': 'usd',
        'usdz': 'usd'
    };
    return typeMap[ext] || 'unknown';
}

/**
 * Get file display type
 */
export function getFileDisplayType(ext, fileName) {
    const modelExts = ['urdf', 'xacro', 'xml', 'usd', 'usda', 'usdc', 'usdz'];
    const meshExts = ['dae', 'stl', 'obj', 'collada'];

    if (modelExts.includes(ext)) {
        return 'model';
    } else if (meshExts.includes(ext)) {
        return 'mesh';
    }
    return 'file';
}

/**
 * Normalize path
 */
export function normalizePath(path) {
    if (!path) return '';
    return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

/**
 * Normalize path segments, resolving "." and ".." without touching protocol-like prefixes.
 */
export function cleanFilePath(path) {
    return normalizePath(path)
        .split('/')
        .reduce((parts, part) => {
            if (!part || part === '.') {
                return parts;
            }
            if (part === '..') {
                parts.pop();
                return parts;
            }
            parts.push(part);
            return parts;
        }, [])
        .join('/');
}

function stripBlobPath(path) {
    if (!path || !path.startsWith('blob:')) {
        return path;
    }

    const blobMatch = path.match(/^blob:https?:\/\/[^/]+\/(.+)$/);
    return blobMatch?.[1] || path;
}

function addCandidate(candidates, path) {
    if (!path) return;

    const withoutBlob = stripBlobPath(path);
    const normalized = normalizePath(withoutBlob);
    const cleaned = cleanFilePath(withoutBlob);

    [path, withoutBlob, normalized, cleaned].forEach(candidate => {
        if (candidate) {
            candidates.push(candidate);
        }
    });
}

function getUniqueFileByPredicate(fileMap, predicate) {
    let matchedFile = null;
    let matchCount = 0;

    for (const [key, file] of fileMap.entries()) {
        if (predicate(key)) {
            matchedFile = file;
            matchCount++;
        }
    }

    return matchCount === 1 ? matchedFile : null;
}

/**
 * Resolve a file from a path-keyed map without guessing among duplicate basenames.
 * Exact and normalized path matches are preferred; basename fallback is only used
 * when exactly one file matches.
 */
export function resolveFileFromMap(path, fileMap, options = {}) {
    if (!path || !fileMap) {
        return null;
    }

    const baseDir = options.baseDir || '';
    const candidates = [];
    const rawPath = stripBlobPath(path);

    // Resolve against this URDF's directory before looking elsewhere in the import.
    // Two revisions can contain the same ROS package and the same mesh filenames.
    if (baseDir) {
        const dirs = cleanFilePath(baseDir).split('/');
        if (rawPath.startsWith('package://')) {
            const packagePath = rawPath.slice('package://'.length);
            const relativePath = packagePath.split('/').slice(1).join('/');
            while (dirs.length) {
                const prefix = dirs.join('/') + '/';
                addCandidate(candidates, prefix + packagePath);
                addCandidate(candidates, prefix + relativePath);
                dirs.pop();
            }
        } else {
            addCandidate(candidates, dirs.join('/') + '/' + rawPath);
        }
    }
    addCandidate(candidates, rawPath);

    if (rawPath.startsWith('package://')) {
        const packagePath = rawPath.replace(/^package:\/\//, '');
        addCandidate(candidates, packagePath);

        const parts = packagePath.split('/');
        if (parts.length > 1) {
            addCandidate(candidates, parts.slice(1).join('/'));
        }
    }

    const normalizedPath = normalizePath(rawPath.replace(/^package:\/\//, ''));
    const normalizedParts = normalizedPath.split('/');
    if (normalizedParts.length > 1) {
        addCandidate(candidates, normalizedParts.slice(1).join('/'));
        if (baseDir) addCandidate(candidates, cleanFilePath(baseDir) + '/' + normalizedParts.slice(1).join('/'));
    }

    for (const candidate of candidates) {
        if (fileMap.has(candidate)) {
            return fileMap.get(candidate);
        }
    }

    const normalizedCandidates = new Set(candidates.map(candidate => cleanFilePath(candidate)));
    const exactNormalizedMatch = getUniqueFileByPredicate(fileMap, key => (
        normalizedCandidates.has(cleanFilePath(key))
    ));
    if (exactNormalizedMatch) {
        return exactNormalizedMatch;
    }

    const lowerCandidates = new Set(Array.from(normalizedCandidates, candidate => candidate.toLowerCase()));
    const exactCaseInsensitiveMatch = getUniqueFileByPredicate(fileMap, key => (
        lowerCandidates.has(cleanFilePath(key).toLowerCase())
    ));
    if (exactCaseInsensitiveMatch) {
        return exactCaseInsensitiveMatch;
    }

    const suffixMatch = getUniqueFileByPredicate(fileMap, key => {
        const normalizedKey = cleanFilePath(key).toLowerCase();
        return Array.from(lowerCandidates).some(candidate => (
            candidate && normalizedKey.endsWith('/' + candidate)
        ));
    });
    if (suffixMatch) {
        return suffixMatch;
    }

    const fileName = cleanFilePath(rawPath).split('/').pop()?.toLowerCase();
    if (!fileName) {
        return null;
    }

    return getUniqueFileByPredicate(fileMap, key => (
        cleanFilePath(key).split('/').pop()?.toLowerCase() === fileName
    ));
}
