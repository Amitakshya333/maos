import * as THREE from 'three';

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  private radius: number;
  private turns: number;
  private height: number;

  constructor(radius: number, turns: number, height: number) {
    super();
    this.radius = radius;
    this.turns = turns;
    this.height = height;
  }

  getPoint(t: number, optionalTarget = new THREE.Vector3()): THREE.Vector3 {
    const angle = 2 * Math.PI * this.turns * t;
    const x = this.radius * Math.cos(angle);
    const z = this.radius * Math.sin(angle);
    const y = this.height * (t - 0.5);
    return optionalTarget.set(x, y, z);
  }
}

/**
 * Generates a closed, manifold 3D faceted star crystal geometry.
 *
 * @param points - Number of star tips (minimum 3)
 * @param outerR - Outer tip radius
 * @param innerR - Inner valley radius
 * @param depth - Total 3D thickness (spanning from -depth/2 to +depth/2)
 */
export const createProceduralStar = (
  points: number = 10,
  outerR: number = 1.2,
  innerR: number = 0.6,
  depth: number = 0.4,
): THREE.BufferGeometry => {
  const numPoints = Math.max(3, Math.round(Math.abs(points)));
  const safeOuterR = Math.max(0.01, Math.abs(outerR));
  const safeInnerR = Math.max(0.005, Math.min(safeOuterR * 0.95, Math.abs(innerR)));
  const halfDepth = Math.max(0.01, Math.abs(depth)) / 2;

  const vertices: number[] = [];
  const indices: number[] = [];

  // Vertex 0: Front Apex (+Z)
  vertices.push(0, 0, halfDepth);
  // Vertex 1: Back Apex (-Z)
  vertices.push(0, 0, -halfDepth);

  // Perimeter vertices at z = 0 (2 * numPoints vertices: alternating outer and inner radius)
  const totalPts = numPoints * 2;
  for (let k = 0; k < totalPts; k++) {
    const angle = (k / totalPts) * (Math.PI * 2);
    const r = k % 2 === 0 ? safeOuterR : safeInnerR;
    const x = r * Math.cos(angle);
    const y = r * Math.sin(angle);
    vertices.push(x, y, 0);
  }

  // Construct non-degenerate, manifold facets connecting apexes to perimeter
  for (let k = 0; k < totalPts; k++) {
    const curr = 2 + k;
    const next = 2 + ((k + 1) % totalPts);

    // Front facet: apex front (0) -> curr -> next
    indices.push(0, curr, next);

    // Back facet: apex back (1) -> next -> curr (reversed winding for outward normal)
    indices.push(1, next, curr);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.Uint16BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  return geometry;
};

/**
 * Generates a smooth 3D procedural helix spring geometry using TubeGeometry.
 *
 * @param radius - Coil radius
 * @param tube - Tube cross-section thickness
 * @param turns - Number of helical revolutions
 * @param height - Total vertical height of the spring
 */
export const createProceduralHelix = (
  radius: number = 0.8,
  tube: number = 0.15,
  turns: number = 8,
  height: number = 2.0,
): THREE.BufferGeometry => {
  const safeRadius = Math.max(0.01, Math.abs(radius));
  const safeTube = Math.max(0.005, Math.min(safeRadius * 0.9, Math.abs(tube)));
  const safeTurns = Math.max(0.25, Math.abs(turns));
  const safeHeight = Math.max(0.01, Math.abs(height));

  const tubularSegments = Math.max(64, Math.round(safeTurns * 16));
  const radialSegments = 12;

  const curve = new HelixCurve(safeRadius, safeTurns, safeHeight);
  const geometry = new THREE.TubeGeometry(curve, tubularSegments, safeTube, radialSegments, false);
  geometry.computeVertexNormals();

  return geometry;
};

/**
 * Generates an icosahedral faceted crystal polyhedron with computed PBR normals.
 *
 * @param radius - Crystal outer radius
 */
export const createCrystalPolyhedron = (radius: number = 1.0): THREE.BufferGeometry => {
  const safeRadius = Math.max(0.01, Math.abs(radius));
  const geometry = new THREE.IcosahedronGeometry(safeRadius, 3);
  geometry.computeVertexNormals();
  return geometry;
};
