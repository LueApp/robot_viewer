/**
 * Model Loader Factory
 * Selects appropriate adapter based on file type
 */
import * as THREE from 'three';
import { loadSTLGeometry } from './STLGeometry.js';
import { URDFAdapter } from '../adapters/URDFAdapter.js';
import { MJCFAdapter } from '../adapters/MJCFAdapter.js';
import { USDAdapter } from '../adapters/USDAdapter.js';
import { XacroAdapter } from '../adapters/XacroAdapter.js';
import { normalizePath, resolveFileFromMap } from '../utils/FileUtils.js';

export class ModelLoaderFactory {
    /**
     * Detect file type
     */
    static detectFileType(fileName, content) {
        const ext = fileName.toLowerCase().split('.').pop();

        switch (ext) {
            case 'urdf':
                return 'urdf';
            case 'xacro':
                return 'xacro';
            case 'xml':
                // XML files are MJCF format, verify if it's a robot file by content
                if (content) {
                    // Verify if it's a valid robot MJCF file (has joints or actuators)
                    if (this.isValidRobotMJCF(content)) {
                        return 'mjcf';
                    } else {
                        return null;
                    }
                }
                return null;
            case 'usd':
            case 'usda':
            case 'usdc':
            case 'usdz':
                return 'usd';
            default:
                return null;
        }
    }

    /**
     * Verify if XML is a valid robot description file
     * @param {string} content - XML file content
     * @returns {boolean} Whether it's a valid robot description file
     */
    static isValidRobotDescriptionXML(content) {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // Remove comments and extra whitespace
        const cleanContent = content.trim();

        // Check if valid XML
        if (!cleanContent.startsWith('<?xml') && !cleanContent.startsWith('<')) {
            return false;
        }

        // XML files are MJCF format, verify if it's a robot file (not a scene file)
        return this.isValidRobotMJCF(cleanContent);
    }

    /**
     * Verify if MJCF file is a robot description file (not a scene file)
     * @param {string} content - MJCF file content
     * @returns {boolean} Whether it's a robot MJCF file
     */
    static isValidRobotMJCF(content) {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // Must contain <mujoco> root element
        if (!content.includes('<mujoco')) {
            return false;
        }

        // Core characteristic of robot files: must have joints or actuators
        const hasJoints = content.includes('<joint');
        const hasActuators = content.includes('<actuator');

        // If has joint or actuator, it's a robot file
        if (hasJoints || hasActuators) {
            return true;
        }

        // If neither joint nor actuator, not a robot file
        // MJCF file without joints or actuators is considered a scene file
        return false;
    }

    /**
     * Load model
     * @param {string} fileType - File type
     * @param {string} content - File content
     * @param {string} fileName - File name (key in fileMap)
     * @param {Map} fileMap - File map (path -> File object), for loading mesh files
     * @param {File} file - Original file object (optional)
     * @param {Object} options - Additional options (e.g., usdViewerManager)
     */
    static async loadModel(fileType, content, fileName, fileMap = null, file = null, options = {}) {
        // Extract base path from fileName for MJCF include resolution
        let basePath = null;
        if (fileName) {
            const lastSlash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
            if (lastSlash > 0) {
                basePath = fileName.substring(0, lastSlash);
            }
        }

        switch (fileType) {
            case 'urdf':
                return await this.loadURDF(content, fileName, fileMap, file, options);
            case 'xacro':
                return await this.loadXacro(content, fileName, fileMap, file);
            case 'mjcf':
                return await this.loadMJCF(content, fileMap, basePath);
            case 'usd':
                return await this.loadUSD(content, fileMap, file, options);
            default:
                throw new Error(`Unsupported file type: ${fileType}`);
        }
    }

    /**
     * Load URDF
     * @param {string} content - URDF content
     * @param {string} fileName - URDF file key in fileMap (includes path)
     * @param {Map} fileMap - File map
     * @param {File} file - Original file object (optional)
     */
    static async loadURDF(content, fileName, fileMap = null, file = null, { visualOnly = false, requireMeshes = visualOnly } = {}) {
        const { default: URDFLoader } = await import('urdf-loader');
        // A loader and its URL modifier belong to one version, including late texture requests.
        const manager = new THREE.LoadingManager();
        const loader = new URDFLoader(manager);
        loader.parseCollision = !visualOnly;
        const urdfDir = normalizePath(fileName).split('/').slice(0, -1).join('/');
        const meshLoads = [];

        if (fileMap) {
            const assets = new Map();
            for (const [path, asset] of fileMap) assets.set(normalizePath(path), asset);
            const resolveAsset = path => resolveFileFromMap(path, assets, { baseDir: urdfDir });
            loader.packages = pkg => 'package://' + pkg;
            const objectUrls = new Set();
            manager.setURLModifier(url => {
                // Mesh loaders already hold a valid object URL for the main mesh.
                if (url.startsWith('blob:') && !/\.\w+$/.test(url)) return url;
                const asset = resolveAsset(url);
                if (!asset) return url;
                const objectUrl = URL.createObjectURL(asset);
                objectUrls.add(objectUrl);
                return objectUrl;
            });
            manager.onLoad = () => {
                for (const url of objectUrls) URL.revokeObjectURL(url);
                objectUrls.clear();
            };

            const defaultLoadMesh = loader.loadMeshCb;
            loader.loadMeshCb = (path, manager, done) => {
                const asset = resolveAsset(path);
                if (!asset && !requireMeshes) {
                    defaultLoadMesh(path.replace(/^package:\/\//, ''), manager, done);
                    return;
                }

                const loadMesh = async () => {
                    if (!asset) throw new Error(`Missing mesh: ${path}`);
                    const ext = asset.name.toLowerCase().split('.').pop();
                    const mesh = await this.loadMeshFileAsync(asset, ext, manager);
                    if (!mesh) throw new Error(`Cannot load mesh: ${path}`);
                    done(mesh);
                };
                if (requireMeshes) {
                    meshLoads.push(loadMesh());
                } else {
                    loadMesh().catch(error => done(null, error));
                }
            };
        }

        const xml = new DOMParser().parseFromString(content, 'text/xml');
        if (xml.documentElement.nodeName !== 'robot' || !xml.querySelector('robot > link')) {
            throw new Error('Expected a URDF robot with at least one link.');
        }
        let robot;
        try {
            robot = loader.parse(xml);
        } finally {
            // Mesh loading starts during parse. Wait even if a later link fails to parse.
            await Promise.all(meshLoads);
        }
        return URDFAdapter.convert(robot, content);
    }

    /**
     * Load Xacro
     * @param {string} content - Xacro content
     * @param {string} fileName - Xacro file key in fileMap (includes path)
     * @param {Map} fileMap - File map
     * @param {File} file - Original file object (optional)
     */
    static async loadXacro(content, fileName, fileMap = null, file = null) {
        try {
            const model = await XacroAdapter.parse(content, fileName, fileMap, file);
            return model;
        } catch (error) {
            console.error('Xacro parsing error:', error);
            throw new Error('Xacro parsing failed: ' + error.message);
        }
    }

    /**
     * Extract all used package names from URDF content
     * @param {string} urdfContent - URDF file content
     * @returns {Set<string>} Set of package names
     */
    static extractPackagesFromURDF(urdfContent) {
        const packages = new Set();
        // Match package://package_name/... format
        const packageRegex = /package:\/\/([^\/]+)/g;
        let match;
        while ((match = packageRegex.exec(urdfContent)) !== null) {
            packages.add(match[1]);
        }
        return packages;
    }

    /**
     * Resolve URDF path (supports package paths and relative paths)
     * Reference urdf-loaders resolvePath implementation
     * @param {string} path - File path (urdf-loader already removed package:// prefix)
     * @param {string} pkg - Package name
     * @param {Map} fileMap - File map
     * @param {string} fileName - URDF file name
     * @returns {Promise<ArrayBuffer>}
     */
    static async resolveURDFPath(path, pkg, fileMap, fileName) {
        // path is already relative path with package:// prefix removed
        // Example: meshes/wheel.stl or wheel.stl

        // Build list of possible paths
        const possiblePaths = [];

        // If has package name, try package-related paths
        if (pkg) {
            // package://package_name/path/to/file -> package_name/path/to/file
            possiblePaths.push(`${pkg}/${path}`);
            possiblePaths.push(`/${pkg}/${path}`); // Support paths starting with /

            // Also try direct filename (if path contains subdirectories)
            const fileNameOnly = path.split('/').pop();
            possiblePaths.push(`${pkg}/${fileNameOnly}`);
            possiblePaths.push(`/${pkg}/${fileNameOnly}`);
            possiblePaths.push(`${pkg}/meshes/${fileNameOnly}`);
            possiblePaths.push(`/${pkg}/meshes/${fileNameOnly}`);
            possiblePaths.push(`${pkg}/urdf/${fileNameOnly}`);
            possiblePaths.push(`${pkg}/models/${fileNameOnly}`);

            // Find if fileMap has directories starting with package name
            const pkgLower = pkg.toLowerCase();
            for (const [key] of fileMap.entries()) {
                const keyLower = key.toLowerCase();
                // Check if key contains package name
                if (keyLower.includes(pkgLower)) {
                    // Extract relative path after package
                    const pkgIndex = keyLower.indexOf(pkgLower);
                    const relativePath = key.substring(pkgIndex + pkg.length);
                    const fileNameOnly = path.split('/').pop();

                    // Check if matches
                    if (relativePath.endsWith(path) ||
                        relativePath.endsWith(`/${path}`) ||
                        relativePath.endsWith(fileNameOnly) ||
                        relativePath.endsWith(`/${fileNameOnly}`) ||
                        relativePath.includes(fileNameOnly)) {
                        possiblePaths.push(key);
                    }
                }
            }
        }

        // Try relative paths
        const dir = fileName.substring(0, fileName.lastIndexOf('/') + 1);
        possiblePaths.push(path);
        possiblePaths.push(dir + path);

        // Try filename only
        const fileNameOnly = path.split('/').pop();
        possiblePaths.push(fileNameOnly);

        // Try each path one by one
        for (const tryPath of possiblePaths) {
            let file = fileMap.get(tryPath);
            if (file) {
                return await file.arrayBuffer();
            }
        }

        // Try fuzzy matching (filename matching, reference dragAndDrop.js logic)
        const cleaned = this.cleanFilePath(path);
        const fileNames = Array.from(fileMap.keys()).map(n => this.cleanFilePath(n));

        for (const fileKey of fileNames) {
            // Check if filename endings match
            const len = Math.min(fileKey.length, cleaned.length);
            if (cleaned.substr(cleaned.length - len) === fileKey.substr(fileKey.length - len)) {
                const file = fileMap.get(fileKey);
                if (file) {
                    return await file.arrayBuffer();
                }
            }
        }

        // If not found, log warning but don't throw error
        console.warn(`Cannot find URDF file: ${path} (package: ${pkg})`);

        // Return empty ArrayBuffer instead of throwing error
        return new ArrayBuffer(0);
    }

    /**
     * Clean file path (remove '..' and '.', normalize slashes)
     * Reference dragAndDrop.js cleanFilePath
     */
    static cleanFilePath(path) {
        return path
            .replace(/\\/g, '/')
            .split(/\//g)
            .reduce((acc, el) => {
                if (el === '..') acc.pop();
                else if (el !== '.') acc.push(el);
                return acc;
            }, [])
            .join('/');
    }

    static normalizeRelativePath(path) {
        const parts = path.replace(/\\/g, '/').split('/');
        const resolvedParts = [];

        for (const part of parts) {
            if (!part || part === '.') {
                continue;
            }

            if (part === '..') {
                if (resolvedParts.length > 0 && resolvedParts[resolvedParts.length - 1] !== '..') {
                    resolvedParts.pop();
                } else {
                    resolvedParts.push(part);
                }
            } else {
                resolvedParts.push(part);
            }
        }

        return resolvedParts.join('/');
    }

    /**
     * Find file in fileMap based on URDF directory
     * @param {string} path - File path (path passed by urdf-loader)
     * @param {Map} fileMap - File map
     * @param {string} urdfDir - Directory where URDF file is located
     * @returns {Promise<File|null>}
     */
    static async findFileInMapByPath(path, fileMap, urdfDir) {
        return resolveFileFromMap(path, fileMap, { baseDir: urdfDir });
    }

    /**
     * Find file in fileMap (old method, kept for backward compatibility)
     * @param {string} path - File path (may be path returned by resolvePath)
     * @param {Map} fileMap - File map
     * @param {string} fileName - URDF filename
     * @returns {Promise<File|null>}
     */
    static async findFileInMap(path, fileMap, fileName) {
        // Remove package:// prefix (if present)
        let searchPath = path.replace(/^package:\/\//, '');

        // Remove leading ./
        searchPath = searchPath.replace(/^\.\//, '');

        // Remove blob: prefix (if present)
        searchPath = searchPath.replace(/^blob:[^\/]+\//, '');

        // Build list of possible paths
        const possiblePaths = [];

        // Extract package name (if present)
        const pathParts = searchPath.split('/');
        if (pathParts.length > 1) {
            const pkg = pathParts[0];
            const relPath = pathParts.slice(1).join('/');
            const fileNameOnly = relPath.split('/').pop();

            // Package-related paths
            possiblePaths.push(`${pkg}/${relPath}`);
            possiblePaths.push(`/${pkg}/${relPath}`);
            possiblePaths.push(`${pkg}/${fileNameOnly}`);
            possiblePaths.push(`/${pkg}/${fileNameOnly}`);
            possiblePaths.push(`${pkg}/meshes/${fileNameOnly}`);
            possiblePaths.push(`/${pkg}/meshes/${fileNameOnly}`);

            // Find paths in fileMap containing package name
            const pkgLower = pkg.toLowerCase();
            for (const [key] of fileMap.entries()) {
                const keyLower = key.toLowerCase();
                if (keyLower.includes(pkgLower)) {
                    const pkgIndex = keyLower.indexOf(pkgLower);
                    const relativePath = key.substring(pkgIndex + pkg.length);
                    if (relativePath.endsWith(relPath) ||
                        relativePath.endsWith(`/${relPath}`) ||
                        relativePath.endsWith(fileNameOnly) ||
                        relativePath.endsWith(`/${fileNameOnly}`) ||
                        relativePath.includes(fileNameOnly)) {
                        possiblePaths.push(key);
                    }
                }
            }
        }

        // Direct path
        possiblePaths.push(searchPath);
        possiblePaths.push(`/${searchPath}`);
        possiblePaths.push(`./${searchPath}`); // Add ./ prefix version

        // Relative path
        const dir = fileName.substring(0, fileName.lastIndexOf('/') + 1);
        possiblePaths.push(dir + searchPath);

        // Filename only
        const fileNameOnly = searchPath.split('/').pop();
        possiblePaths.push(fileNameOnly);

        // Try each one
        for (const tryPath of possiblePaths) {
            const file = fileMap.get(tryPath);
            if (file) {
                return file;
            }
        }

        // Try cleaned key matching
        const cleanedSearch = this.cleanFilePath(searchPath).replace(/^\.\//, '');
        for (const [key, file] of fileMap.entries()) {
            const cleanedKey = this.cleanFilePath(key).replace(/^\.\//, '');
            if (cleanedKey === cleanedSearch) {
                return file;
            }
        }

        // Fuzzy matching
        const cleaned = this.cleanFilePath(searchPath);
        const fileNames = Array.from(fileMap.keys()).map(n => this.cleanFilePath(n));

        for (const fileKey of fileNames) {
            const len = Math.min(fileKey.length, cleaned.length);
            if (cleaned.substr(cleaned.length - len) === fileKey.substr(fileKey.length - len)) {
                const file = fileMap.get(fileKey);
                if (file) {
                    return file;
                }
            }
        }

        return null;
    }

    /**
     * Load mesh file directly using Three.js loaders
     * @param {File} file - File object
     * @param {string} path - Original path (used to determine file type)
     * @returns {Promise<THREE.Group|THREE.Mesh|null>}
     */
    static async loadMeshFileDirect(file, path) {
        const fileExt = file.name ? file.name.toLowerCase().split('.').pop() : path.toLowerCase().split('.').pop();
        const blobUrl = URL.createObjectURL(file);

        try {
            let meshObject = null;

            switch (fileExt) {
                case 'stl':
                    const stlGeometry = await loadSTLGeometry(file);
                    const stlMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc });
                    meshObject = new THREE.Mesh(stlGeometry, stlMaterial);
                    break;

                case 'dae':
                    const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
                    const colladaLoader = new ColladaLoader();
                    const colladaModel = await new Promise((resolve, reject) => {
                        colladaLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    // ColladaLoader returns scene
                    meshObject = colladaModel.scene || colladaModel;

                    // Remove lights
                    if (meshObject && meshObject.traverse) {
                        const lightsToRemove = [];
                        meshObject.traverse(child => {
                            if (child.isLight) {
                                lightsToRemove.push(child);
                            }
                        });
                        lightsToRemove.forEach(light => {
                            if (light.parent) {
                                light.parent.remove(light);
                            }
                        });
                    }

                    // Note: Do not apply rotation here!
                    // SceneManager's world object has already applied coordinate system conversion (-90 degrees X-axis)
                    // Applying rotation again will cause double rotation error
                    break;

                case 'obj':
                    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
                    const objLoader = new OBJLoader();
                    meshObject = await new Promise((resolve, reject) => {
                        objLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    break;

                case 'gltf':
                case 'glb':
                    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
                    const gltfLoader = new GLTFLoader();
                    const gltfModel = await new Promise((resolve, reject) => {
                        gltfLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    meshObject = gltfModel.scene || gltfModel;
                    break;

                default:
                    console.warn(`Unsupported file format: ${fileExt}`);
                    URL.revokeObjectURL(blobUrl);
                    return null;
            }

            URL.revokeObjectURL(blobUrl);
            return meshObject;
        } catch (error) {
            URL.revokeObjectURL(blobUrl);
            console.error(`Failed to load mesh file: ${path}`, error);
            return null;
        }
    }

    /**
     * Asynchronously load mesh file (for URDFLoader's loadMeshCb)
     * @param {File} file - File object
     * @param {string} ext - File extension
     * @param {THREE.LoadingManager} manager - Three.js loading manager
     * @returns {Promise<THREE.Group|THREE.Mesh|null>}
     */
    static async loadMeshFileAsync(file, ext, manager) {
        const blobUrl = URL.createObjectURL(file);

        try {
            let meshObject = null;

            switch (ext) {
                case 'stl': {
                    const stlGeometry = await loadSTLGeometry(file);
                    // Use MeshPhongMaterial to match URDFLoader behavior
                    const stlMaterial = new THREE.MeshPhongMaterial();
                    meshObject = new THREE.Mesh(stlGeometry, stlMaterial);
                    break;
                }

                case 'dae': {
                    const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
                    const colladaLoader = new ColladaLoader(manager);
                    const colladaModel = await new Promise((resolve, reject) => {
                        colladaLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    // ColladaLoader returns an object, scene property is the scene
                    meshObject = colladaModel.scene;

                    // Remove lights (consistent with URDFLoader behavior)
                    if (meshObject && meshObject.traverse) {
                        const lightsToRemove = [];
                        meshObject.traverse(child => {
                            if (child.isLight) {
                                lightsToRemove.push(child);
                            }
                        });
                        lightsToRemove.forEach(light => {
                            if (light.parent) {
                                light.parent.remove(light);
                            }
                        });
                    }

                    // Note: Do not apply rotation here!
                    // SceneManager's world object has already applied coordinate system conversion
                    break;
                }

                case 'obj': {
                    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
                    const objLoader = new OBJLoader(manager);
                    meshObject = await new Promise((resolve, reject) => {
                        objLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    break;
                }

                case 'gltf':
                case 'glb': {
                    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
                    const gltfLoader = new GLTFLoader(manager);
                    const gltfModel = await new Promise((resolve, reject) => {
                        gltfLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    meshObject = gltfModel.scene;
                    break;
                }

                default:
                    console.warn(`Unsupported file format: ${ext}`);
                    URL.revokeObjectURL(blobUrl);
                    return null;
            }

            URL.revokeObjectURL(blobUrl);
            return meshObject;
        } catch (error) {
            URL.revokeObjectURL(blobUrl);
            console.error(`Failed to load mesh file: ${file.name}`, error);
            throw error;
        }
    }

    /**
     * Load MJCF
     */
    static async loadMJCF(content, fileMap = null, basePath = null) {
        try {
            const model = await MJCFAdapter.parse(content, fileMap, basePath);
            return model;
        } catch (error) {
            console.error('MJCF parsing error:', error);
            console.error('Error stack:', error.stack);
            throw new Error('MJCF parsing failed: ' + error.message + (error.stack ? '\n' + error.stack : ''));
        }
    }

    /**
     * Load USD
     * @param {string|ArrayBuffer} content - USD content
     * @param {Map} fileMap - File map
     * @param {File} file - Original file object
     * @param {Object} options - Additional options (e.g., usdViewerManager)
     */
    static async loadUSD(content, fileMap = null, file = null, options = {}) {
        try {
            const model = await USDAdapter.parse(content, fileMap, file, options);
            return model;
        } catch (error) {
            throw new Error('USD parsing failed: ' + error.message);
        }
    }

    /**
     * Set joint angle (universal method)
     */
    static setJointAngle(model, jointName, angle, ignoreLimits = false) {
        const joint = model.getJoint(jointName);
        if (!joint) {
            console.warn(`Joint ${jointName} does not exist`);
            return;
        }

        // Get ignoreLimits flag from model's userData (if parameter not specified)
        if (!ignoreLimits && model.userData && model.userData.ignoreLimits) {
            ignoreLimits = true;
        }

        // Call corresponding adapter based on model type
        // URDF format: joint.threeObject is URDFJoint object, has setJointValue or setAngle method
        if (joint.threeObject && (typeof joint.threeObject.setJointValue === 'function' || typeof joint.threeObject.setAngle === 'function')) {
            URDFAdapter.setJointAngle(joint, angle, ignoreLimits);
        } else {
            // MJCF or USD format
            MJCFAdapter.setJointAngle(joint, angle);
        }

        // Ensure model matrix is updated
        if (model.threeObject) {
            model.threeObject.updateMatrixWorld(true);
        }
    }
}
