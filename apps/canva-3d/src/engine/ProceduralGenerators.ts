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

export const createProceduralStar = (
  points: number = 10,
  outerR: number = 1.2,
  innerR: number = 0.6,
  depth: number = 0.4,
): THREE.BufferGeometry => {
  const geometry = new THREE.BufferGeometry();
  const vertices = [];
  const indices = [];

  for (let i = 0; i < points; i++) {
    const angle = (i / points) * (Math.PI * 2);
    const r = outerR + innerR * Math.cos(angle * depth);
    const x = r * Math.cos(angle);
    const y = r * Math.sin(angle);
    vertices.push(x, y, 0);
  }

  for (let i = 0; i < points - 2; i++) {
    indices.push(i, (i + 1) % points, 0);
    indices.push(i, points - 1, (i + 1) % points);
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.Uint16BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  return geometry;
};

export const createProceduralHelix = (
  radius: number = 0.8,
  tube: number = 0.15,
  turns: number = 8,
  height: number = 2.0,
): THREE.BufferGeometry => {
  const tubularSegments = Math.max(64, Math.round(turns * 16));
  const radialSegments = 12;
  const curve = new HelixCurve(radius, turns, height);
  const geometry = new THREE.TubeGeometry(curve, tubularSegments, tube, radialSegments, false);
  geometry.computeVertexNormals();

  return geometry;
};

export const createCrystalPolyhedron = (radius: number = 1.0): THREE.BufferGeometry => {
  const geometry = new THREE.IcosahedronGeometry(radius, 3);
  geometry.computeVertexNormals();
  return geometry;
};
