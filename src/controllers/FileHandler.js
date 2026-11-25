/**
 * FileHandler - File handling module
 * Handles file drag-drop, loading, type detection, etc.
 */
import { disposeModelResources } from '../renderer/disposeModelResources.js';
import * as THREE from 'three';
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { readFileContent, getFileFromEntry, readDirectory, readDirectoryHandle, getFileTypeFromExtension } from '../utils/FileUtils.js';
import { supportsUSD, isUSDFile } from '../config/features.js';

export class FileHandler {
    constructor() {
        this.fileMap = new Map();
        this.availableModels = [];
        this.loadSequence = 0;
        this.projects = new Map();
        this.nextProjectId = 1;
        this.selectedProject = null;
        this.activeProject = null;
        this.projectStatus = '';
        this.currentModelFile = null;
        this.onModelLoaded = null; // Callback function
        this.usdViewerManager = null; // USD viewer manager (lazy loaded)
    }

    /**
     * Set USD viewer manager
     */
    setUSDViewerManager(manager) {
        this.usdViewerManager = manager;
    }

    /**
     * Set USD viewer initializer callback (for lazy loading)
     */
    setUSDViewerInitializer(initializer) {
        this.usdViewerInitializer = initializer;
    }

    /**
     * Setup file drag-drop
     */
    setupFileDrop() {
        const body = document.body;

        const preventDefaults = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            body.addEventListener(eventName, preventDefaults, false);
        });

        let dragCounter = 0;
        body.addEventListener('dragenter', (e) => {
            dragCounter++;
            const dropZone = document.getElementById('drop-zone');
            if (dropZone) dropZone.classList.add('drag-over');
        }, false);

        body.addEventListener('dragleave', (e) => {
            dragCounter--;
            if (dragCounter === 0) {
                const dropZone = document.getElementById('drop-zone');
                if (dropZone) dropZone.classList.remove('drag-over');
            }
        }, false);

        body.addEventListener('drop', (e) => {
            dragCounter = 0;
            const dropZone = document.getElementById('drop-zone');
            if (dropZone) dropZone.classList.remove('drag-over');
            this.handleDrop(e).catch(error => this.reportLoadError(window.i18n.t('projects'), error));
        }, false);
    }


    /**
     * Handle file drop
     */
    async handleDrop(e) {
        const droppedFiles = Array.from(e.dataTransfer.files || []);
        if (droppedFiles.length === 1 && /\.txt$/i.test(droppedFiles[0].name) && this.onInertiaReport) {
            await this.onInertiaReport(droppedFiles[0]);
            return;
        }
        // A browser grants access to dropped items during the event. Capture both
        // APIs before awaiting directory reads, including in the standalone HTML.
        const items = Array.from(e.dataTransfer.items || []).filter(item => item.kind === 'file');
        const entries = items.map(item => item.webkitGetAsEntry?.());
        const handles = await Promise.all(items.map(item => item.getAsFileSystemHandle?.().catch(() => null)));
        if (!handles.some(handle => handle?.kind === 'directory') && !entries.some(entry => entry?.isDirectory)) {
            return this.importFiles(droppedFiles);
        }
        const groups = [];
        const loose = [];
        for (const [i, entry] of entries.entries()) {
            const handle = handles[i];
            const assets = new Map();
            if (handle?.kind === 'directory') {
                await readDirectoryHandle(handle, assets);
                groups.push({ name: handle.name, assets });
            } else if (entry?.isDirectory) {
                await readDirectory(entry, assets);
                groups.push({ name: entry.name, assets });
            } else if (handle?.kind === 'file') {
                loose.push(await handle.getFile());
            } else if (entry?.isFile) {
                loose.push(await getFileFromEntry(entry));
            } else if (droppedFiles[i]) {
                loose.push(droppedFiles[i]);
            }
        }
        if (loose.length) groups.push(this.looseProject(loose));
        return this.importProjects(groups);
    }

    looseProject(files) {
        const assets = new Map();
        for (const [index, file] of files.entries()) {
            const path = assets.has(file.name) ? `${index + 1}/${file.name}` : file.name;
            assets.set(path, file);
        }
        return { name: files[0].name, assets, loose: true };
    }

    importFiles(files) {
        if (!files.length) return;
        const folders = new Map();
        const loose = [];
        for (const file of files) {
            if (!file.webkitRelativePath) {
                loose.push(file);
                continue;
            }
            const name = file.webkitRelativePath.split('/')[0];
            if (!folders.has(name)) folders.set(name, { name, assets: new Map() });
            folders.get(name).assets.set(file.webkitRelativePath, file);
        }
        const groups = [...folders.values()];
        if (loose.length) groups.push(this.looseProject(loose));
        const pair = !folders.size && loose.length === 2 && loose.every(file => /\.urdf$/i.test(file.name));
        return this.importProjects(groups, { open: !folders.size, primaryFile: pair ? loose[0] : null, referenceFile: pair ? loose[1] : null });
    }

    async importProjects(groups, { open = false, primaryFile, referenceFile } = {}) {
        const sequence = this.loadSequence;
        const added = [];
        for (const { name, assets, loose = false } of groups) {
            const models = await this.findAllLoadableFiles([...assets.values()]);
            if (!models.length) continue;
            const paths = new Map([...assets].map(([path, file]) => [file, path]));
            for (const model of models) model.path = paths.get(model.file);
            let label = name;
            for (let n = 2; [...this.projects.values()].some(p => p.name === label); n++) label = `${name} (${n})`;
            const project = { id: String(this.nextProjectId++), name: label, assets, loose, models, lastPath: null };
            this.projects.set(project.id, project);
            added.push(project);
        }
        if (!added.length) this.projectStatus = window.i18n.t('noSupportedFiles');
        this.onProjectsChanged?.();
        if (added.length && sequence === this.loadSequence && (open || !this.selectedProject)) {
            const project = added[0];
            const initial = primaryFile && project.models.find(model => model.file === primaryFile);
            await this.selectProject(project, initial?.path, referenceFile);
        }
    }

    async selectProject(project, path, referenceFile = null) {
        if (!project || !this.projects.has(project.id)) return;
        this.selectedProject = project;
        const info = project.models.find(model => model.path === (path || project.lastPath)) || project.models[0];
        const file = project.assets.get(info.path);
        this.requestedPath = info.path;
        if (file === this.currentModelFile && project === this.activeProject && !referenceFile) {
            ++this.loadSequence;
            this.requestedPath = null;
            this.projectStatus = '';
            this.onProjectsChanged?.();
            return;
        }
        this.projectStatus = window.i18n.t('loading') + ' · ' + info.name;
        this.onProjectsChanged?.();
        if (info.category === 'mesh') await this.loadMeshAsModel(file, file.name, project, info.path);
        else await this.loadFile(file, referenceFile, project, info.path);
    }

    commitSelection(project, path, file) {
        if (project) {
            project.lastPath = path;
            const entry = project.models.find(model => model.path === path);
            if (entry) entry.file = file;
            this.fileMap = project.assets;
            this.availableModels = project.models;
            this.activeProject = this.selectedProject = project;
            this.onFilesLoaded?.(project.models);
        }
        this.currentModelFile = file;
        this.requestedPath = null;
        this.projectStatus = '';
        this.onProjectsChanged?.();
    }

    async removeProject(project) {
        if (!this.projects.delete(project.id)) return;
        const selected = this.selectedProject === project;
        const active = this.activeProject === project;
        if (selected) {
            ++this.loadSequence;
            this.requestedPath = null;
            this.selectedProject = active ? null : this.activeProject;
            this.projectStatus = '';
        }
        if (active) {
            this.activeProject = null;
            this.fileMap = new Map();
            this.availableModels = [];
            this.currentModelFile = null;
            this.onModelCleared?.();
            this.onFilesLoaded?.([]);
        }
        project.assets.clear();
        project.models.length = 0;
        this.onProjectsChanged?.();
        if (this.activeProject) return;
        // An inactive or pending project can be removed without interrupting
        // a different project that is still opening.
        if (!active && this.selectedProject) return;
        const remaining = new Set([this.selectedProject, ...this.projects.values()]);
        for (const next of remaining) {
            if (!next || !this.projects.has(next.id)) continue;
            const expectedLoad = this.loadSequence + 1;
            await this.selectProject(next);
            if (this.activeProject || this.loadSequence !== expectedLoad) break;
        }
    }

    /**
     * Find all loadable files
     */
    async findAllLoadableFiles(files) {
        if (!supportsUSD && files.length && files.every(file => isUSDFile(file.name))) {
            alert(window.i18n.t('offlineUsdUnavailable'));
        }
        const supportedExtensions = {
            model: ['urdf', 'xacro', 'xml', ...(supportsUSD ? ['usd', 'usda', 'usdc', 'usdz'] : [])],
            mesh: ['dae', 'stl', 'obj', 'collada']
        };
        const loadableFiles = [];

        const checkPromises = files.map(async (file) => {
            const ext = file.name.toLowerCase().split('.').pop();

            if (supportedExtensions.model.includes(ext)) {
                if (ext === 'xml') {
                    try {
                        const content = await readFileContent(file);
                        const fileType = ModelLoaderFactory.detectFileType(file.name, content);

                        if (!fileType) {
                            return null;
                        }

                        return {
                            file: file,
                            name: file.name,
                            type: fileType,
                            path: file.webkitRelativePath || file.name,
                            category: 'model'
                        };
                    } catch (error) {
                        console.error(`Failed to read XML file: ${file.name}`, error);
                        return null;
                    }
                } else {
                    const fileType = getFileTypeFromExtension(ext);
                    return {
                        file: file,
                        name: file.name,
                        type: fileType,
                        path: file.webkitRelativePath || file.name,
                        category: 'model'
                    };
                }
            } else if (supportedExtensions.mesh.includes(ext)) {
                return {
                    file: file,
                    name: file.name,
                    type: 'mesh',
                    path: file.webkitRelativePath || file.name,
                    category: 'mesh'
                };
            }

            return null;
        });

        const results = await Promise.all(checkPromises);

        results.forEach(result => {
            if (result) {
                loadableFiles.push(result);
            }
        });

        loadableFiles.sort((a, b) => {
            if (a.category !== b.category) {
                return a.category === 'model' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        return loadableFiles;
    }

    /**
     * Load and activate a model after its assets have resolved.
     */
    async loadFile(file, referenceFile = null, project = this.activeProject, path = null) {
        const sequence = ++this.loadSequence;
        if (!supportsUSD && isUSDFile(file.name)) {
            alert(window.i18n.t('offlineUsdUnavailable'));
            return;
        }
        const assets = project?.assets || this.fileMap;
        path ??= [...assets].find(([, asset]) => asset === file)?.[0] || file.name;
        try {
            const usd = isUSDFile(file.name);
            if (usd && !this.usdViewerManager) await this.usdViewerInitializer?.();
            const content = usd ? null : await readFileContent(file);
            if (sequence !== this.loadSequence) return;
            if (this.isUSDCBinaryContent(content)) throw new Error('Binary USDC content requires a USD file extension.');
            const type = ModelLoaderFactory.detectFileType(file.name, content);
            if (!type) throw new Error(window.i18n.t('unsupportedFormat'));
            if (!assets.size) assets.set(path, file);
            const model = await ModelLoaderFactory.loadModel(type, content, path, assets, file, {
                usdViewerManager: this.usdViewerManager, requireMeshes: Boolean((project && !project.loose) || referenceFile)
            });
            if (sequence !== this.loadSequence) {
                disposeModelResources(model?.threeObject);
                return;
            }
            this.commitSelection(project, path, file);
            await this.onModelLoaded?.(model, file, false, null, { referenceFile });
            document.getElementById('drop-zone')?.classList.remove('show', 'drag-over');
        } catch (error) {
            if (sequence === this.loadSequence) this.reportLoadError(path, error);
        }
    }

    reportLoadError(path, error) {
        console.error('Failed to load file:', error);
        this.projectStatus = `${window.i18n.t('loadFailed')} · ${path} · ${error.message}`;
        if (this.activeProject && this.currentModelFile) {
            this.projectStatus += ` · ${window.i18n.t('comparisonCurrent')} · ${this.activeProject.name} / ${this.currentModelFile.name}`;
        }
        this.onProjectsChanged?.();
    }

    /**
     * Detect if file content is USDC binary format
     */
    isUSDCBinaryContent(content) {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // Detect USDC binary format characteristics
        // 1. Starts with "PXR-USDC" (USDC file magic bytes)
        if (content.startsWith('PXR-USDC')) {
            return true;
        }

        // 2. Check first 100 bytes, if contains many null bytes, likely binary
        const firstBytes = content.substring(0, 100);
        const nullCount = (firstBytes.match(/\x00/g) || []).length;
        if (nullCount > 10) {
            return true;
        }

        // 3. Check if valid ASCII USD file
        // Valid USDA files usually start with #usda or contain def keywords
        if (content.includes('#usda') ||
            (content.includes('def ') && content.includes('{'))) {
            return false;
        }

        // 4. File starts with non-printable characters (excluding newline, carriage return, tab, space)
        const firstChar = content.charCodeAt(0);
        if (firstChar < 32 && firstChar !== 10 && firstChar !== 13 && firstChar !== 9 && firstChar !== 32) {
            return true;
        }

        return false;
    }

    /**
     * Create loading snapshot
     */
    createLoadingSnapshot() {
        const canvas = document.getElementById('canvas');
        if (!canvas) return null;

        try {
            const dataURL = canvas.toDataURL('image/png');
            const snapshot = document.createElement('div');
            snapshot.id = 'canvas-snapshot';
            snapshot.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-image: url(${dataURL});
                background-size: cover;
                background-position: center;
                background-color: var(--bg-primary);
                background-repeat: no-repeat;
                z-index: 2;
                pointer-events: none;
            `;

            const canvasContainer = document.getElementById('canvas-container');
            if (canvasContainer) {
                canvasContainer.appendChild(snapshot);
            }

            return snapshot;
        } catch (error) {
            console.error('Failed to create snapshot:', error);
            return null;
        }
    }

    /**
     * Remove loading snapshot
     */
    removeLoadingSnapshot(snapshot) {
        if (!snapshot || !snapshot.parentNode) return;

        snapshot.style.transition = 'opacity 0.3s ease';
        snapshot.style.opacity = '0';

        setTimeout(() => {
            if (snapshot.parentNode) {
                snapshot.parentNode.removeChild(snapshot);
            }
        }, 300);
    }

    /**
     * Load single mesh file as model
     */
    async loadMeshAsModel(file, fileName, project = this.activeProject, path = fileName) {
        const sequence = ++this.loadSequence;
        try {
            const meshObject = await ModelLoaderFactory.loadMeshFileDirect(file, fileName);

            if (sequence !== this.loadSequence) {
                disposeModelResources(meshObject);
                return;
            }
            if (!meshObject) {
                throw new Error(window.i18n.t('cannotLoadMesh'));
            }

            // Ensure mesh materials support lighting and shadows
            meshObject.traverse((child) => {
                if (child.isMesh) {
                    if (child.material?.type === 'MeshBasicMaterial') {
                        const oldMaterial = child.material;
                        child.material = new THREE.MeshPhongMaterial({
                            color: oldMaterial.color,
                            map: oldMaterial.map,
                            transparent: oldMaterial.transparent,
                            opacity: oldMaterial.opacity,
                            side: oldMaterial.side,
                            shininess: 30
                        });
                        oldMaterial.dispose();
                        if (child.material.map) {
                            child.material.map.colorSpace = THREE.SRGBColorSpace;
                        }
                    }
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            const simpleMeshModel = {
                name: fileName,
                rootLink: 'mesh_root',
                links: new Map([
                    ['mesh_root', {
                        name: 'mesh_root',
                        threeObject: meshObject,
                        visuals: [{
                            threeObject: meshObject,
                            geometry: { mesh: fileName }
                        }],
                        inertial: null
                    }]
                ]),
                joints: new Map(),
                threeObject: meshObject
            };

            this.commitSelection(project, path, file);
            await this.onModelLoaded?.(simpleMeshModel, file, true, null);

        } catch (error) {
            if (sequence === this.loadSequence) this.reportLoadError(path, error);
        }
    }

    /**
     * Get file map
     */
    getFileMap() {
        return this.fileMap;
    }

    /**
     * Get available models list
     */
    getAvailableModels() {
        return this.availableModels;
    }

    /**
     * Get current model file
     */
    getCurrentModelFile() {
        return this.currentModelFile;
    }
}
