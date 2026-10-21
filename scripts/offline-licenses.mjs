import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function collectDependencyNotices(repo, dependencies) {
    const seen = new Set();
    const notices = [];
    async function collect(name, from = repo) {
        let directory = from;
        let found;
        while (true) {
            try { found = await realpath(path.join(directory, 'node_modules', name)); break; } catch {}
            const parent = path.dirname(directory);
            if (parent === directory) throw new Error(`Cannot resolve dependency license: ${name}`);
            directory = parent;
        }
        if (seen.has(found)) return;
        seen.add(found);
        const info = JSON.parse(await readFile(path.join(found, 'package.json'), 'utf8'));
        notices.push(`\n=== ${info.name}@${info.version} (${info.license ?? 'see package'}) ===\n`);
        for (const file of await readdir(found)) if (/^(license|copying|notice)(\.|$)/i.test(file)) {
            try { notices.push(await readFile(path.join(found, file), 'utf8')); } catch {}
        }
        for (const dependency of Object.keys(info.dependencies ?? {})) await collect(dependency, found);
    }
    for (const dependency of Object.keys(dependencies)) await collect(dependency);
    return notices.join('\n');
}
