import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';

describe('Canva 3D Math & Geometry Suite', () => {
  test('should verify Euler to Degree rotation transforms', () => {
    const rad = Math.PI / 2;
    const deg = THREE.MathUtils.radToDeg(rad);
    assert(Math.abs(deg - 90) < 0.001, 'Degree rotation should be 90');
  });

  test('should verify ground plane raycast plane equations', () => {
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ray = new THREE.Ray(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
    const target = new THREE.Vector3();
    const hit = ray.intersectPlane(groundPlane, target);

    assert.notStrictEqual(hit, null);
    assert.strictEqual(target.x, 0);
    assert.strictEqual(target.y, 0);
    assert.strictEqual(target.z, 0);
  });

  test('should verify PBR material property ranges', () => {
    const pbrProps = {
      color: '#8b5cf6',
      roughness: 0.2,
      metalness: 0.8,
      transmission: 0.9,
      opacity: 1.0,
      emissiveIntensity: 0.5,
    };

    assert(pbrProps.roughness >= 0 && pbrProps.roughness <= 1);
    assert(pbrProps.metalness >= 0 && pbrProps.metalness <= 1);
    assert(pbrProps.transmission >= 0 && pbrProps.transmission <= 1);
  });

  test('should serialize scene object JSON without loss of coordinates', () => {
    const objectData = {
      id: 'test_obj_1',
      name: 'Cyberpunk Torus',
      type: 'torus',
      position: [1.5, 2.0, -3.5],
      rotation: [45, 90, 0],
      scale: [1, 1, 1],
      material: {
        color: '#ec4899',
        roughness: 0.1,
        metalness: 0.9,
      },
    };

    const json = JSON.stringify(objectData);
    const parsed = JSON.parse(json);

    assert.strictEqual(parsed.id, 'test_obj_1');
    assert.deepStrictEqual(parsed.position, [1.5, 2.0, -3.5]);
    assert.deepStrictEqual(parsed.rotation, [45, 90, 0]);
    assert.strictEqual(parsed.material.color, '#ec4899');
  });

  test('should generate valid procedural helix geometry without index out of bounds', async () => {
    const { createProceduralHelix } = await import('../src/engine/ProceduralGenerators.ts');
    const helix = createProceduralHelix(0.8, 0.15, 8, 2.0);

    assert(helix.attributes.position.count > 0, 'Helix must have vertices');
    assert(helix.index !== null, 'Helix must be indexed geometry');
    assert(helix.attributes.normal !== undefined, 'Helix must have computed normals');

    const vertexCount = helix.attributes.position.count;
    const indices = helix.index.array;
    for (let i = 0; i < indices.length; i++) {
      assert(indices[i] >= 0 && indices[i] < vertexCount, `Index ${indices[i]} out of bounds [0, ${vertexCount})`);
    }
  });

  test('should handle edge cases in procedural helix with non-zero geometry', async () => {
    const { createProceduralHelix } = await import('../src/engine/ProceduralGenerators.ts');
    // Edge cases: negative radius, zero tube, negative turns, negative height
    const edgeHelix = createProceduralHelix(-1.0, 0, -4, -3.0);

    assert(edgeHelix.attributes.position.count > 0, 'Helix must safely clamp and construct vertices');
    assert(edgeHelix.index !== null, 'Helix index must exist');
    assert(!isNaN(edgeHelix.attributes.position.array[0]), 'Vertices must not be NaN');
    assert(!isNaN(edgeHelix.attributes.normal.array[0]), 'Normals must not be NaN');
  });

  test('should generate valid 3D procedural star geometry with computed normals and no degenerate triangles', async () => {
    const { createProceduralStar } = await import('../src/engine/ProceduralGenerators.ts');
    const star = createProceduralStar(10, 1.2, 0.6, 0.4);

    assert(star.attributes.position.count > 0, 'Star must have vertices');
    assert(star.index !== null, 'Star must be indexed geometry');
    assert(star.attributes.normal !== undefined, 'Star must have computed normals');

    const vertexCount = star.attributes.position.count;
    const indices = star.index.array;
    for (let i = 0; i < indices.length; i++) {
      assert(indices[i] >= 0 && indices[i] < vertexCount, `Index ${indices[i]} out of bounds [0, ${vertexCount})`);
    }

    // Verify strictly zero degenerate triangles (no face with duplicate indices)
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      assert(a !== b && b !== c && a !== c, `Degenerate triangle detected at offset ${i}: (${a}, ${b}, ${c})`);
    }

    // Verify real 3D depth
    star.computeBoundingBox();
    const depthZ = star.boundingBox.max.z - star.boundingBox.min.z;
    assert(Math.abs(depthZ - 0.4) < 0.001, `Star must have 3D depth equal to 0.4, got ${depthZ}`);
  });

  test('should handle edge cases in procedural star safely', async () => {
    const { createProceduralStar } = await import('../src/engine/ProceduralGenerators.ts');
    // Edge cases: negative points, zero depth, inner radius >= outer radius
    const star = createProceduralStar(-5, 0.8, 1.5, 0);

    assert(star.attributes.position.count > 0, 'Edge star must have vertices');
    assert(star.index !== null, 'Edge star must have indices');
    const vertexCount = star.attributes.position.count;
    const indices = star.index.array;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      assert(a >= 0 && a < vertexCount);
      assert(b >= 0 && b < vertexCount);
      assert(c >= 0 && c < vertexCount);
      assert(a !== b && b !== c && a !== c, 'Edge star must have no degenerate triangles');
    }
  });

  test('should generate crystal polyhedron geometry with valid normals and handle edge cases', async () => {
    const { createCrystalPolyhedron } = await import('../src/engine/ProceduralGenerators.ts');
    const crystal = createCrystalPolyhedron(1.0);

    assert(crystal.attributes.position.count > 0, 'Crystal must have vertices');
    assert(crystal.attributes.normal !== undefined, 'Crystal must have computed normals');

    const edgeCrystal = createCrystalPolyhedron(-2.0);
    assert(edgeCrystal.attributes.position.count > 0, 'Negative radius crystal must safely construct');
    assert(!isNaN(edgeCrystal.attributes.position.array[0]), 'Crystal vertices must not be NaN');
  });
});
