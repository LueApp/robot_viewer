/**
 * FileHandler - File handling module
 * Handles file drag-drop, loading, type detection, etc.
 */
import * as THREE from 'three';
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { readFileContent, getFileFromEntry, readDirectory, getFileTypeFromExtension } from '../utils/FileUtils.js';
import { supportsUSD, isUSDFile } from '../config/features.js';

export class FileHandler {
    constructor() {
        this.fileMap = new Map();
        this.availableModels = [];
        this.loadSequence = 0;
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
            this.handleDrop(e);
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
        const sequence = ++this.loadSequence;
        const entries = Array.from(e.dataTransfer.items || [], item => item.webkitGetAsEntry?.()).filter(Boolean);
        const imported = new Map();
        const files = [];
        if (entries.length) {
            for (const entry of entries) {
                if (entry.isDirectory) {
                    files.push(...await readDirectory(entry, imported));
                } else if (entry.isFile) {
                    const file = await getFileFromEntry(entry);
                    imported.set(entry.fullPath || file.name, file);
                    files.push(file);
                }
            }
        } else {
            for (const file of droppedFiles) {
                imported.set(file.webkitRelativePath || file.name, file);
                files.push(file);
            }
        }
        const models = await this.findAllLoadableFiles(files);
        if (!files.length || sequence !== this.loadSequence) return;

        // Selecting two loose URDFs is a pair import. A folder can hold many independent robots.
        const isPair = files.length === 2 && files.every(f => /\.urdf$/i.test(f.name) && !f.webkitRelativePath)
            && !entries.some(entry => entry.isDirectory);
        if (isPair && imported.size === 1) {
            // Browsers can give two files dragged from different windows the same path.
            imported.clear();
            files.forEach((file, i) => imported.set(`${i + 1}/${file.name}`, file));
        }
        this.setImportedFiles(imported, models);
        if (isPair) {
            await this.loadFile(files[0], files[1]);
        } else if (models.length) {
            await this.loadFileOrMesh(models[0]);
        }
    }

    setImportedFiles(assets, models) {
        // The editor shares this Map instance.
        this.fileMap.clear();
        for (const [path, file] of assets) this.fileMap.set(path, file);
        this.availableModels = models;
        this.onFilesLoaded?.(models);
    }

    async loadComparisonPrimary({ file, path, assets }, isCurrent) {
        const sequence = ++this.loadSequence;
        const [content, models] = await Promise.all([
            readFileContent(file),
            this.findAllLoadableFiles([...assets.values()])
        ]);
        if (sequence !== this.loadSequence || !isCurrent()) return;
        const model = await ModelLoaderFactory.loadModel('urdf', content, path, assets, file, { requireMeshes: true });
        if (sequence !== this.loadSequence || !isCurrent()) return;
        // Commit the new project only after its URDF parses successfully.
        this.setImportedFiles(assets, models);
        this.currentModelFile = file;
        await this.onModelLoaded?.(model, file, false, null, { keepReference: true });
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
     * Load file or mesh
     */
    async loadFileOrMesh(fileInfo) {
        if (fileInfo.category === 'model') {
            await this.loadFile(fileInfo.file);
        } else if (fileInfo.category === 'mesh') {
            await this.loadMeshAsModel(fileInfo.file, fileInfo.name);
        }
    }

    /**
     * Load model file
     */
    async loadFile(file, referenceFile = null) {
        const sequence = ++this.loadSequence;
        if (!supportsUSD && isUSDFile(file.name)) {
            alert(window.i18n.t('offlineUsdUnavailable'));
            return;
        }
        this.currentModelFile = file;

        try {
            const fileName = file.name.toLowerCase();

            // Get the full path from fileMap
            let fullPath = file.name;
            for (const [path, f] of this.fileMap.entries()) {
                if (f === file) {
                    fullPath = path;
                    break;
                }
            }

            // Handle USD format files (all USD formats use WASM)
            const isUSD = fileName.endsWith('.usd') || fileName.endsWith('.usda') ||
                         fileName.endsWith('.usdc') || fileName.endsWith('.usdz');
            if (isUSD) {
                // Ensure USD viewer is initialized
                if (!this.usdViewerManager && this.usdViewerInitializer) {
                    try {
                        await this.usdViewerInitializer();
                    } catch (error) {
                        console.error('USD viewer initialization failed:', error);
                        return;
                    }
                }

                if (this.fileMap.size === 0) {
                    this.fileMap.set(file.name, file);
                }

                // USD files need File object passed
                const model = await ModelLoaderFactory.loadModel(
                    'usd',
                    null,
                    fullPath,
                    this.fileMap,
                    file,
                    { usdViewerManager: this.usdViewerManager }
                );

                if (sequence !== this.loadSequence) return;
                await this.onModelLoaded?.(model, file, false, null);
                document.getElementById('drop-zone')?.classList.remove('show');
                document.getElementById('drop-zone')?.classList.remove('drag-over');
                return;
            }

            // For other files, read text content
            const content = await readFileContent(file);
            if (sequence !== this.loadSequence) return;

            // Detect if USDC binary format (based on content)
            if (this.isUSDCBinaryContent(content)) {
                console.error('Cannot load USDC binary format, please convert to USDZ or USDA');
                return;
            }

            const fileType = ModelLoaderFactory.detectFileType(file.name, content);

            if (!fileType) {
                console.error(`${window.i18n.t('unsupportedFormat')}: ${file.name}`);
                return;
            }

            if (this.fileMap.size === 0) {
                this.fileMap.set(file.name, file);
            }

            const model = await ModelLoaderFactory.loadModel(
                fileType,
                content,
                fullPath,  // Use full path instead of just file.name
                this.fileMap,
                file,
                { usdViewerManager: this.usdViewerManager, requireMeshes: Boolean(referenceFile) }
            );

            // Notify model loaded (pass null as snapshot, let main.js create it)
            if (sequence !== this.loadSequence) return;
            await this.onModelLoaded?.(model, file, false, null, { referenceFile });

            document.getElementById('drop-zone')?.classList.remove('show');
            document.getElementById('drop-zone')?.classList.remove('drag-over');

        } catch (error) {
            console.error('Failed to load file:', error);

            // If error message contains USDC related content
            if (error.message && (error.message.includes('USDC') || error.message.includes('binary format'))) {
                console.error('Cannot load USDC binary format, please convert to USDZ or USDA');
            } else {
                console.error(`${window.i18n.t('loadFailed')}: ${error.message}`);
            }

            // Remove snapshot if exists
            const snapshot = document.getElementById('canvas-snapshot');
            if (snapshot?.parentNode) {
                snapshot.parentNode.removeChild(snapshot);
            }
        }
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
    async loadMeshAsModel(file, fileName) {
        const sequence = ++this.loadSequence;
        try {
            const meshObject = await ModelLoaderFactory.loadMeshFileDirect(file, fileName);

            if (sequence !== this.loadSequence) return;
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

            this.currentModelFile = file;
            this.onModelLoaded?.(simpleMeshModel, file, true, null);

        } catch (error) {
            console.error('Failed to load mesh file:', error);

            const snapshot = document.getElementById('canvas-snapshot');
            if (snapshot?.parentNode) {
                snapshot.parentNode.removeChild(snapshot);
            }
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
