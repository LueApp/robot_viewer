// Model roots own their geometries and materials. Some meshes share them within a robot.
export function disposeModelResources(root, extraMaterials = []) {
    const geometries = new Set();
    const materials = new Set(extraMaterials);
    const textures = new Set();
    root?.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        for (const value of [object.material, object.userData.originalMaterial]) {
            for (const material of [].concat(value || [])) materials.add(material);
        }
    });
    for (const material of materials) {
        for (const value of Object.values(material)) {
            if (value?.isTexture) textures.add(value);
        }
        material.dispose();
    }
    for (const texture of textures) texture.dispose();
    for (const geometry of geometries) geometry.dispose();
}
