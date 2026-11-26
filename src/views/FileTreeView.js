/**
 * FileTreeView - File tree view
 * Responsible for displaying and managing file tree structure
 */

import { supportsUSD, isUSDFile } from '../config/features.js';

export class FileTreeView {
    constructor() {
        this.availableModels = [];
        this.onFileClick = null;
    }

    /**
     * Update file tree
     */
    updateFileTree(files, fileMap, preserveState = false) {
        this.availableModels = files;
        const listContainer = document.getElementById('model-list');
        if (!listContainer) return;

        // Save expanded state
        const expandedPaths = preserveState ? this.saveTreeState() : [];

        listContainer.innerHTML = '';

        if (files.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'empty-state';
            hint.dataset.i18n = 'dropHint';
            hint.textContent = window.i18n.t('dropHint');
            listContainer.append(hint);
            return;
        }

        this.buildFileTree(listContainer, files, fileMap);

        // Restore expanded state
        if (preserveState && expandedPaths.length > 0) {
            setTimeout(() => this.restoreTreeState(expandedPaths), 0);
        }
    }

    setupProjects(handler) {
        this.fileHandler = handler;
        this.library = document.getElementById('project-library');
        const tabs = [...document.querySelectorAll('#floating-files-panel [role="tab"]')];
        const activate = tab => {
            for (const other of tabs) {
                const selected = other === tab;
                other.setAttribute('aria-selected', String(selected));
                other.tabIndex = selected ? 0 : -1;
                document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
            }
        };
        for (const tab of tabs) {
            tab.onclick = () => activate(tab);
            tab.onkeydown = event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs.find(other => other !== tab);
                activate(next);
                next.focus();
            };
        }
        this.library.hidden = false;
        this.library.querySelector('[data-add-folder]').onclick = () => this.triggerFileLoad(true);
        this.library.querySelector('[data-add-files]').onclick = () => this.triggerFileLoad();
        this.modelSelect = this.library.querySelector('[data-project-model]');
        this.modelSelect.onchange = () => handler.selectProject(handler.selectedProject, this.modelSelect.value);
        this.renderProjects();
    }

    renderProjects() {
        const handler = this.fileHandler;
        const list = this.library.querySelector('[data-project-list]');
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const focusKey = focused?.hasAttribute('data-remove-project') ? 'removeProject' : 'projectId';
        const focusedId = focused?.dataset[focusKey];
        const oldIndex = focused ? [...list.children].indexOf(focused.parentElement) : -1;
        this.library.querySelector('[data-project-empty]').hidden = handler.projects.size > 0;
        list.replaceChildren();
        for (const project of handler.projects.values()) {
            const row = document.createElement('div');
            row.className = 'project-row';
            const select = document.createElement('button');
            select.type = 'button';
            select.dataset.projectId = project.id;
            select.title = project.name;
            const icon = document.createElement('i');
            icon.className = 'library-folder-icon';
            icon.setAttribute('aria-hidden', 'true');
            const name = document.createElement('span');
            name.className = 'project-name';
            name.textContent = project.name;
            select.append(icon, name);
            select.setAttribute('aria-pressed', String(project === handler.selectedProject));
            select.onclick = () => handler.selectProject(project);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.dataset.removeProject = project.id;
            remove.textContent = '×';
            remove.title = window.i18n.t('removeProject') + ' · ' + project.name;
            remove.setAttribute('aria-label', remove.title);
            remove.onclick = () => handler.removeProject(project);
            row.append(select, remove);
            list.append(row);
        }
        if (focused) {
            const buttons = [...list.querySelectorAll(focusKey === 'removeProject' ? '[data-remove-project]' : '[data-project-id]')];
            const next = buttons.find(button => button.dataset[focusKey] === focusedId)
                || buttons[Math.min(oldIndex, buttons.length - 1)] || this.library.querySelector('[data-add-folder]');
            next.focus({ preventScroll: true });
        }
        const selected = handler.selectedProject;
        this.modelSelect.closest('label').hidden = !selected;
        this.modelSelect.replaceChildren();
        if (selected) {
            // Keep the selector focused on robot descriptions when a project also has meshes.
            const models = selected.models.filter(model => model.category === 'model' || model.path === selected.lastPath);
            for (const model of models.length ? models : selected.models) {
                this.modelSelect.add(new Option(model.path, model.path));
            }
            this.modelSelect.value = handler.requestedPath || selected.lastPath || this.modelSelect.options[0]?.value;
            const path = this.modelSelect.value;
            const parts = path.split('/').filter(Boolean);
            this.library.querySelector('[data-model-name]').textContent = parts.pop() || '';
            if (!selected.loose) parts.shift(); // Folder pickers include the project root in every path.
            this.library.querySelector('[data-model-dir]').textContent = parts.join('/');
            this.modelSelect.title = path;
        }
        this.library.querySelector('[data-project-status]').textContent = handler.projectStatus;
    }

    /**
     * Trigger file/folder loading dialog
     */
    triggerFileLoad(isFolder = false) {
        // Create a temporary file input to allow file selection
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.webkitdirectory = isFolder;
        input.style.display = 'none';

        if (!isFolder) {
            input.setAttribute('accept', '.urdf,.xacro,.xml,.dae,.stl,.obj,.collada,.mcap' + (supportsUSD ? ',.usd,.usda,.usdc,.usdz' : ''));
        }

        input.addEventListener('change', () => {
            const files = Array.from(input.files);
            input.remove();
            if (files.length) this.fileHandler.importFiles(files);
        });
        input.addEventListener('cancel', () => input.remove());

        // Add to DOM temporarily and trigger click
        document.body.appendChild(input);
        input.click();
    }

    /**
     * Save file tree state
     */
    saveTreeState() {
        const expandedPaths = [];
        document.querySelectorAll('.tree-item.folder:not(.collapsed)').forEach(folder => {
            const nameSpan = folder.querySelector('.name');
            if (nameSpan) {
                expandedPaths.push(nameSpan.textContent);
            }
        });
        return expandedPaths;
    }

    /**
     * Restore file tree state
     */
    restoreTreeState(expandedPaths) {
        if (!expandedPaths || expandedPaths.length === 0) return;

        document.querySelectorAll('.tree-item.folder').forEach(folder => {
            const nameSpan = folder.querySelector('.name');
            if (nameSpan && expandedPaths.includes(nameSpan.textContent)) {
                folder.classList.remove('collapsed');
            }
        });
    }

    /**
     * Mark current active file
     */
    markActiveFile(file) {
        document.querySelectorAll('.tree-item.selected').forEach(item => {
            item.classList.remove('selected');
        });

        const allTreeItems = document.querySelectorAll('#model-list .tree-item');
        allTreeItems.forEach(item => {
            const nameSpan = item.querySelector('.name');
            if (nameSpan && nameSpan.textContent === file.name) {
                item.classList.add('selected');
                item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
    }

    /**
     * Expand folder containing file and scroll to file position
     */
    expandAndScrollToFile(file, fileMap) {
        if (!file) return;

        // Find file's full path in fileMap
        let filePath = null;
        fileMap.forEach((f, path) => {
            if (f === file) {
                filePath = path;
            }
        });

        if (!filePath) {
            return;
        }

        // Get all folders in path
        const pathParts = filePath.split('/').filter(p => p);
        const folderPaths = [];

        // Build folder paths for each level
        for (let i = 0; i < pathParts.length - 1; i++) {
            folderPaths.push(pathParts[i]);
        }


        // Expand all parent folders
        const allFolders = document.querySelectorAll('#model-list .tree-item.folder');
        allFolders.forEach(folder => {
            const nameSpan = folder.querySelector('.name');
            if (nameSpan && folderPaths.includes(nameSpan.textContent)) {
                folder.classList.remove('collapsed');
            }
        });

        // Delay scrolling to ensure DOM is updated
        setTimeout(() => {
            const allTreeItems = document.querySelectorAll('#model-list .tree-item');
            let targetItem = null;

            allTreeItems.forEach(item => {
                if (item.dataset.filePath === filePath) targetItem = item;
            });

            if (targetItem) {
                targetItem.classList.add('selected');
                targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }, 100);
    }

    /**
     * Check if XML file is a model file (URDF/MJCF)
     */
    isModelXML(fileName) {
        const lowerName = fileName.toLowerCase();
        // Exclude common non-model XML files
        const excludePatterns = ['package', 'launch', 'config', 'scene', 'ros'];
        return !excludePatterns.some(pattern => lowerName.includes(pattern));
    }

    /**
     * Build file tree
     */
    buildFileTree(container, files, fileMap) {
        const fileStructure = {};

        fileMap.forEach((file, path) => {
            if (!supportsUSD && isUSDFile(file.name)) return;
            const ext = file.name.split('.').pop().toLowerCase();
            const supportedExtensions = ['urdf', 'xacro', 'xml', 'dae', 'stl', 'obj', 'collada', 'usd', 'usda', 'usdc'];

            if (!supportedExtensions.includes(ext)) return;

            // If XML file, check if it's a model file
            if (ext === 'xml' && !this.isModelXML(file.name)) {
                return;
            }

            const parts = path.split('/').filter(p => p);
            let current = fileStructure;

            parts.forEach((part, index) => {
                if (index === parts.length - 1) {
                    if (!current.__files) current.__files = [];
                    current.__files.push({
                        name: part,
                        file: file,
                        path: path,
                        ext: ext
                    });
                } else {
                    if (!current[part]) current[part] = {};
                    current = current[part];
                }
            });
        });

        this.renderFileTreeStructure(fileStructure, container);
    }

    /**
     * Render file tree structure
     */
    renderFileTreeStructure(structure, container) {
        const folders = [];
        const files = [];

        Object.keys(structure).forEach(key => {
            if (key === '__files') {
                files.push(...structure[key]);
            } else {
                folders.push(key);
            }
        });

        folders.sort().forEach(folderName => {
            const folder = this.createTreeFolder(folderName);
            const folderChildren = folder.querySelector('.tree-children');
            this.renderFileTreeStructure(structure[folderName], folderChildren);
            container.appendChild(folder);
        });

        if (files.length > 0) {
            this.renderFiles(files, container);
        }
    }

    /**
     * Create folder node
     */
    createTreeFolder(name) {
        const folder = document.createElement('div');
        folder.className = 'tree-item folder collapsed';

        const header = document.createElement('div');
        header.className = 'tree-item-header';

        const leftContent = document.createElement('div');
        leftContent.className = 'tree-item-left';

        const arrow = document.createElement('span');
        arrow.className = 'tree-arrow';

        const icon = document.createElement('span');
        icon.className = 'icon';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.textContent = name;

        leftContent.appendChild(arrow);
        leftContent.appendChild(icon);
        leftContent.appendChild(nameSpan);
        header.appendChild(leftContent);

        const children = document.createElement('div');
        children.className = 'tree-children';

        folder.appendChild(header);
        folder.appendChild(children);

        header.addEventListener('click', (e) => {
            e.stopPropagation();
            folder.classList.toggle('collapsed');
        });

        return folder;
    }

    /**
     * Render file list
     */
    renderFiles(files, container) {
        files.sort((a, b) => {
            const modelExts = ['urdf', 'xacro', 'xml', 'usd', 'usda', 'usdc'];
            const aIsModel = modelExts.includes(a.ext);
            const bIsModel = modelExts.includes(b.ext);

            if (aIsModel && !bIsModel) return -1;
            if (!aIsModel && bIsModel) return 1;
            return a.name.localeCompare(b.name);
        });

        files.forEach(fileInfo => {
            const item = this.createTreeItem(fileInfo.name, fileInfo.ext);
            item.dataset.filePath = fileInfo.path;
            item.classList.toggle('selected', fileInfo.file === this.fileHandler?.currentModelFile);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.tree-item.selected').forEach(elem => {
                    elem.classList.remove('selected');
                });
                item.classList.add('selected');
                this.onFileClick?.(fileInfo);
            });
            container.appendChild(item);
        });
    }

    /**
     * Create file node
     */
    createTreeItem(name, ext) {
        const item = document.createElement('div');
        item.className = 'tree-item';

        const header = document.createElement('div');
        header.className = 'tree-item-header';

        const leftContent = document.createElement('div');
        leftContent.className = 'tree-item-left';

        const icon = document.createElement('span');
        icon.className = 'icon';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.textContent = name;

        leftContent.appendChild(icon);
        leftContent.appendChild(nameSpan);
        header.appendChild(leftContent);

        // Add type label (e.g., URDF, XACRO, STL, etc.)
        if (name && name.includes('.')) {
            const extUpper = name.split('.').pop().toUpperCase();
            const displayExtensions = ['URDF', 'XACRO', 'XML', 'DAE', 'STL', 'OBJ', 'USD', 'USDA', 'USDC', 'USDZ'];
            if (displayExtensions.includes(extUpper)) {
                const badge = document.createElement('span');
                badge.className = 'type-badge';
                badge.textContent = extUpper;
            header.appendChild(badge);
            }
        }

        item.appendChild(header);

        return item;
    }
}
