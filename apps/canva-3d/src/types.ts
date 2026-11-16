export type ShapeType =
  | 'cube'
  | 'sphere'
  | 'cylinder'
  | 'capsule'
  | 'torus'
  | 'cone'
  | 'pyramid'
  | 'diamond'
  | 'torusKnot'
  | 'ring'
  | 'badge'
  | 'proceduralStar'
  | 'proceduralHelix'
  | 'crystal';

export type TransformMode = 'translate' | 'rotate' | 'scale';

export type StudioTheme = 'cyberpunk' | 'studio' | 'sunset' | 'void' | 'pastel';

export interface MaterialProperties {
  color: string;
  roughness: number;
  metalness: number;
  transmission: number;
  opacity: number;
  transparent: boolean;
  wireframe: boolean;
  emissive: string;
  emissiveIntensity: number;
  clearcoat?: number;
}

export interface SceneObjectData {
  id: string;
  name: string;
  type: ShapeType;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  material: MaterialProperties;
  visible: boolean;
  locked: boolean;
}

export interface MaterialPreset {
  name: string;
  category: 'glossy' | 'metallic' | 'glass' | 'neon' | 'matte';
  properties: MaterialProperties;
  gradientBadge: string;
}
