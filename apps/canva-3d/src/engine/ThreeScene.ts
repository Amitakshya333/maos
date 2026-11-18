import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createProceduralStar, createProceduralHelix, createCrystalPolyhedron } from './ProceduralGenerators';
import { MaterialProperties, SceneObjectData, ShapeType, StudioTheme, TransformMode } from '../types';

export class ThreeSceneManager {
  private container: HTMLDivElement;
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public orbitControls: OrbitControls;
  public transformControls: TransformControls;

  private objects: Map<string, THREE.Mesh> = new Map();
  private objectData: Map<string, SceneObjectData> = new Map();
  private selectedObjectId: string | null = null;

  // Scene lighting & environment
  private ambientLight: THREE.AmbientLight;
  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private rimLight: THREE.PointLight;
  private gridHelper: THREE.GridHelper;
  private groundPlane: THREE.Mesh;
  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private mouse: THREE.Vector2 = new THREE.Vector2();

  // Animation frame
  private animationFrameId: number | null = null;
  public isAnimatingScene: boolean = false;

  // Callbacks
  public onSelectObject?: (id: string | null, data?: SceneObjectData) => void;
  public onTransformChange?: (id: string, data: Partial<SceneObjectData>) => void;
  public onObjectsChanged?: (objects: SceneObjectData[]) => void;

  constructor(container: HTMLDivElement) {
    this.container = container;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f111a);
    this.scene.fog = new THREE.FogExp2(0x0f111a, 0.025);

    // 2. Camera
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    this.camera.position.set(6, 5, 8);

    // 3. Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    // 4. Controls
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.05;
    this.orbitControls.maxPolarAngle = Math.PI / 2 - 0.02; // Don't go below ground
    this.orbitControls.minDistance = 2;
    this.orbitControls.maxDistance = 50;

    // 5. Transform Controls
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.size = 0.85;
    this.transformControls.addEventListener('dragging-changed', (event) => {
      this.orbitControls.enabled = !event.value;
    });

    this.transformControls.addEventListener('change', () => {
      if (this.selectedObjectId && this.transformControls.object) {
        const obj = this.transformControls.object;
        const data = this.objectData.get(this.selectedObjectId);
        if (data) {
          data.position = [obj.position.x, obj.position.y, obj.position.z];
          data.rotation = [
            THREE.MathUtils.radToDeg(obj.rotation.x),
            THREE.MathUtils.radToDeg(obj.rotation.y),
            THREE.MathUtils.radToDeg(obj.rotation.z),
          ];
          data.scale = [obj.scale.x, obj.scale.y, obj.scale.z];
          this.onTransformChange?.(this.selectedObjectId, {
            position: data.position,
            rotation: data.rotation,
            scale: data.scale,
          });
        }
      }
    });

    this.scene.add(this.transformControls.getHelper());

    // 6. Lighting
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.keyLight.position.set(8, 12, 6);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.width = 2048;
    this.keyLight.shadow.mapSize.height = 2048;
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 30;
    this.keyLight.shadow.camera.left = -10;
    this.keyLight.shadow.camera.right = 10;
    this.keyLight.shadow.camera.top = 10;
    this.keyLight.shadow.camera.bottom = -10;
    this.keyLight.shadow.bias = -0.0005;
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0x8b5cf6, 1.2);
    this.fillLight.position.set(-8, 6, -6);
    this.scene.add(this.fillLight);

    this.rimLight = new THREE.PointLight(0xec4899, 2.0, 30);
    this.rimLight.position.set(0, 8, -6);
    this.scene.add(this.rimLight);

    // 7. Grid & Ground Shadow Receiver
    this.gridHelper = new THREE.GridHelper(24, 24, 0x8b5cf6, 0x272b3b);
    this.gridHelper.position.y = -0.001;
    this.scene.add(this.gridHelper);

    const groundGeo = new THREE.PlaneGeometry(100, 100);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    this.groundPlane = new THREE.Mesh(groundGeo, groundMat);
    this.groundPlane.rotation.x = -Math.PI / 2;
    this.groundPlane.receiveShadow = true;
    this.groundPlane.name = '__groundPlane';
    this.scene.add(this.groundPlane);

    // 8. Event Listeners
    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);

    // 9. Start Render Loop
    this.animate();
  }

  private animate = () => {
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.orbitControls.update();

    if (this.isAnimatingScene) {
      const time = performance.now() * 0.001;
      this.objects.forEach((mesh, id) => {
        mesh.rotation.y += 0.01;
        mesh.position.y += Math.sin(time * 2 + parseInt(id.slice(-4), 16) || 0) * 0.002;
      });
    }

    this.renderer.render(this.scene, this.camera);
  };

  public onResize = () => {
    if (!this.container) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private onPointerDown = (event: PointerEvent | MouseEvent) => {
    // Only handle left click on canvas or touch taps
    if (event.button !== 0 && (event as PointerEvent).pointerType !== 'touch') return;

    // Ignore clicks if clicking transform controls handles
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = Array.from(this.objects.values());
    const intersects = this.raycaster.intersectObjects(meshes, false);

    if (intersects.length > 0) {
      const hit = intersects[0].object as THREE.Mesh;
      const id = (hit.userData as { id?: string }).id;
      if (id) {
        this.selectObject(id);
      }
    } else {
      // Clicked ground or empty space: deselect
      if (!this.transformControls.dragging) {
        this.selectObject(null);
      }
    }
  };

  /** Project 2D screen coordinates (e.g. from drag & drop) onto the 3D ground plane */
  public getGroundIntersection(screenX: number, screenY: number): THREE.Vector3 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((screenX - rect.left) / rect.width) * 2 - 1;
    const y = -((screenY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const intersects = this.raycaster.intersectObject(this.groundPlane);

    if (intersects.length > 0) {
      return intersects[0].point;
    }
    return new THREE.Vector3(0, 0.5, 0);
  }

  // ── Geometry Factory ──────────────────────────────────────────

  private createGeometry(type: ShapeType): THREE.BufferGeometry {
    switch (type) {
      case 'cube':
        return new THREE.BoxGeometry(1.4, 1.4, 1.4);
      case 'sphere':
        return new THREE.SphereGeometry(0.85, 32, 32);
      case 'cylinder':
        return new THREE.CylinderGeometry(0.7, 0.7, 1.6, 32);
      case 'capsule':
        return new THREE.CapsuleGeometry(0.6, 1.0, 16, 32);
      case 'torus':
        return new THREE.TorusGeometry(0.8, 0.28, 24, 48);
      case 'cone':
        return new THREE.ConeGeometry(0.85, 1.6, 32);
      case 'pyramid':
        return new THREE.ConeGeometry(1.0, 1.4, 4);
      case 'diamond':
        return new THREE.IcosahedronGeometry(0.9, 0);
      case 'torusKnot':
        return new THREE.TorusKnotGeometry(0.65, 0.22, 100, 16);
      case 'ring':
        return new THREE.RingGeometry(0.5, 1.0, 32);
      case 'badge': {
        const shape = new THREE.Shape();
        const r = 0.8;
        const pts = 8;
        for (let i = 0; i < pts * 2; i++) {
          const l = i % 2 === 1 ? r * 0.75 : r;
          const a = (i / pts) * Math.PI;
          if (i === 0) shape.moveTo(Math.cos(a) * l, Math.sin(a) * l);
          else shape.lineTo(Math.cos(a) * l, Math.sin(a) * l);
        }
        shape.closePath();
        return new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.08 });
      }
      case 'proceduralStar':
        return createProceduralStar(10, 1.2, 0.6, 0.4);
      case 'proceduralHelix':
        return createProceduralHelix(0.8, 0.15, 8, 2.0);
      case 'crystal':
        return createCrystalPolyhedron(0.95);
      default:
        return new THREE.BoxGeometry(1.2, 1.2, 1.2);
    }
  }

  private createMaterial(props: MaterialProperties): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(props.color),
      roughness: props.roughness,
      metalness: props.metalness,
      transmission: props.transmission,
      opacity: props.opacity,
      transparent: props.transparent || props.opacity < 1.0 || props.transmission > 0,
      wireframe: props.wireframe,
      emissive: new THREE.Color(props.emissive),
      emissiveIntensity: props.emissiveIntensity,
      clearcoat: props.clearcoat || (props.transmission > 0 ? 0.8 : 0.0),
      clearcoatRoughness: 0.1,
      ior: 1.52,
    });
  }

  // ── Public API ────────────────────────────────────────────────

  public addObject(
    type: ShapeType,
    position?: [number, number, number],
    materialProps?: Partial<MaterialProperties>,
    customName?: string,
  ): SceneObjectData {
    const id = `obj_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const name = customName || `${type.charAt(0).toUpperCase() + type.slice(1)} ${this.objects.size + 1}`;

    const defaultMaterial: MaterialProperties = {
      color: '#8b5cf6',
      roughness: 0.2,
      metalness: 0.3,
      transmission: 0.0,
      opacity: 1.0,
      transparent: false,
      wireframe: false,
      emissive: '#000000',
      emissiveIntensity: 0.0,
      ...materialProps,
    };

    const geometry = this.createGeometry(type);
    const material = this.createMaterial(defaultMaterial);
    const mesh = new THREE.Mesh(geometry, material);

    // Initial position
    const posX = position ? position[0] : (Math.random() - 0.5) * 2;
    const posY = position ? Math.max(0.7, position[1]) : 0.8;
    const posZ = position ? position[2] : (Math.random() - 0.5) * 2;

    mesh.position.set(posX, posY, posZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { id, type, name };

    this.scene.add(mesh);
    this.objects.set(id, mesh);

    const data: SceneObjectData = {
      id,
      name,
      type,
      position: [posX, posY, posZ],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: defaultMaterial,
      visible: true,
      locked: false,
    };

    this.objectData.set(id, data);
    this.selectObject(id);
    this.notifyObjectsChanged();

    return data;
  }

  public selectObject(id: string | null) {
    this.selectedObjectId = id;
    if (id && this.objects.has(id)) {
      const mesh = this.objects.get(id)!;
      this.transformControls.attach(mesh);
      this.onSelectObject?.(id, this.objectData.get(id));
    } else {
      this.transformControls.detach();
      this.onSelectObject?.(null);
    }
  }

  public setTransformMode(mode: TransformMode) {
    this.transformControls.setMode(mode);
  }

  public updateObjectMaterial(id: string, props: Partial<MaterialProperties>) {
    const mesh = this.objects.get(id);
    const data = this.objectData.get(id);
    if (!mesh || !data) return;

    data.material = { ...data.material, ...props };
    const mat = mesh.material as THREE.MeshPhysicalMaterial;

    if (props.color !== undefined) mat.color.set(props.color);
    if (props.roughness !== undefined) mat.roughness = props.roughness;
    if (props.metalness !== undefined) mat.metalness = props.metalness;
    if (props.transmission !== undefined) {
      mat.transmission = props.transmission;
      mat.transparent = mat.transmission > 0 || mat.opacity < 1;
    }
    if (props.opacity !== undefined) {
      mat.opacity = props.opacity;
      mat.transparent = mat.opacity < 1 || mat.transmission > 0;
    }
    if (props.wireframe !== undefined) mat.wireframe = props.wireframe;
    if (props.emissive !== undefined) mat.emissive.set(props.emissive);
    if (props.emissiveIntensity !== undefined) mat.emissiveIntensity = props.emissiveIntensity;

    mat.needsUpdate = true;
    this.notifyObjectsChanged();
  }

  public updateObjectTransform(
    id: string,
    transform: {
      position?: [number, number, number];
      rotation?: [number, number, number];
      scale?: [number, number, number];
    },
  ) {
    const mesh = this.objects.get(id);
    const data = this.objectData.get(id);
    if (!mesh || !data) return;

    if (transform.position) {
      mesh.position.set(transform.position[0], transform.position[1], transform.position[2]);
      data.position = transform.position;
    }
    if (transform.rotation) {
      mesh.rotation.set(
        THREE.MathUtils.degToRad(transform.rotation[0]),
        THREE.MathUtils.degToRad(transform.rotation[1]),
        THREE.MathUtils.degToRad(transform.rotation[2]),
      );
      data.rotation = transform.rotation;
    }
    if (transform.scale) {
      mesh.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
      data.scale = transform.scale;
    }

    this.notifyObjectsChanged();
  }

  public duplicateObject(id: string): SceneObjectData | null {
    const data = this.objectData.get(id);
    if (!data) return null;

    const newPos: [number, number, number] = [data.position[0] + 0.8, data.position[1], data.position[2] + 0.8];

    return this.addObject(data.type, newPos, data.material, `${data.name} (Copy)`);
  }

  public removeObject(id: string) {
    const mesh = this.objects.get(id);
    if (!mesh) return;

    if (this.selectedObjectId === id) {
      this.selectObject(null);
    }

    this.scene.remove(mesh);
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => m.dispose());
    } else {
      mesh.material.dispose();
    }

    this.objects.delete(id);
    this.objectData.delete(id);
    this.notifyObjectsChanged();
  }

  public toggleVisibility(id: string) {
    const mesh = this.objects.get(id);
    const data = this.objectData.get(id);
    if (!mesh || !data) return;

    data.visible = !data.visible;
    mesh.visible = data.visible;
    if (!data.visible && this.selectedObjectId === id) {
      this.selectObject(null);
    }
    this.notifyObjectsChanged();
  }

  public toggleLock(id: string) {
    const data = this.objectData.get(id);
    if (!data) return;

    data.locked = !data.locked;
    if (data.locked && this.selectedObjectId === id) {
      this.transformControls.detach();
    }
    this.notifyObjectsChanged();
  }

  public setStudioTheme(theme: StudioTheme) {
    switch (theme) {
      case 'cyberpunk':
        this.scene.background = new THREE.Color(0x0a0518);
        this.scene.fog = new THREE.FogExp2(0x0a0518, 0.03);
        this.ambientLight.color.set(0x4c1d95);
        this.ambientLight.intensity = 1.0;
        this.keyLight.color.set(0x06b6d4);
        this.keyLight.intensity = 2.4;
        this.fillLight.color.set(0xec4899);
        this.fillLight.intensity = 2.0;
        this.gridHelper.material = new THREE.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.35 });
        break;
      case 'studio':
        this.scene.background = new THREE.Color(0x1e2029);
        this.scene.fog = new THREE.FogExp2(0x1e2029, 0.02);
        this.ambientLight.color.set(0xffffff);
        this.ambientLight.intensity = 1.2;
        this.keyLight.color.set(0xffffff);
        this.keyLight.intensity = 2.0;
        this.fillLight.color.set(0xa5b4fc);
        this.fillLight.intensity = 1.0;
        this.gridHelper.material = new THREE.LineBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.3 });
        break;
      case 'sunset':
        this.scene.background = new THREE.Color(0x1e101a);
        this.scene.fog = new THREE.FogExp2(0x1e101a, 0.025);
        this.ambientLight.color.set(0xfb923c);
        this.ambientLight.intensity = 0.9;
        this.keyLight.color.set(0xf43f5e);
        this.keyLight.intensity = 2.5;
        this.fillLight.color.set(0x818cf8);
        this.fillLight.intensity = 1.2;
        this.gridHelper.material = new THREE.LineBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: 0.3 });
        break;
      case 'void':
        this.scene.background = new THREE.Color(0x020408);
        this.scene.fog = new THREE.FogExp2(0x020408, 0.04);
        this.ambientLight.color.set(0x1e293b);
        this.ambientLight.intensity = 0.4;
        this.keyLight.color.set(0x38bdf8);
        this.keyLight.intensity = 3.0;
        this.fillLight.color.set(0x6366f1);
        this.fillLight.intensity = 1.5;
        this.gridHelper.material = new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.2 });
        break;
      case 'pastel':
        this.scene.background = new THREE.Color(0x282338);
        this.scene.fog = new THREE.FogExp2(0x282338, 0.02);
        this.ambientLight.color.set(0xfbcfe8);
        this.ambientLight.intensity = 1.1;
        this.keyLight.color.set(0xfef08a);
        this.keyLight.intensity = 1.8;
        this.fillLight.color.set(0xc4b5fd);
        this.fillLight.intensity = 1.4;
        this.gridHelper.material = new THREE.LineBasicMaterial({ color: 0x9333ea, transparent: true, opacity: 0.3 });
        break;
    }
  }

  public setCameraView(view: 'top' | 'front' | 'iso') {
    switch (view) {
      case 'top':
        this.camera.position.set(0, 14, 0.001);
        this.camera.lookAt(0, 0, 0);
        break;
      case 'front':
        this.camera.position.set(0, 3, 12);
        this.camera.lookAt(0, 1, 0);
        break;
      case 'iso':
        this.camera.position.set(8, 7, 9);
        this.camera.lookAt(0, 0.5, 0);
        break;
    }
  }

  public toggleGrid(visible: boolean) {
    this.gridHelper.visible = visible;
  }

  public captureScreenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  public exportGLTF(filename = 'canva-3d-scene.glb') {
    const exporter = new GLTFExporter();
    // Create an export group containing only user objects
    const exportScene = new THREE.Scene();
    this.objects.forEach((mesh) => {
      exportScene.add(mesh.clone());
    });

    exporter.parse(
      exportScene,
      (gltf) => {
        const isBinary = gltf instanceof ArrayBuffer;
        const blob = isBinary
          ? new Blob([gltf], { type: 'application/octet-stream' })
          : new Blob([JSON.stringify(gltf, null, 2)], { type: 'application/json' });

        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
      },
      (error) => {
        console.error('GLTF Export Error:', error);
      },
      { binary: true },
    );
  }

  private notifyObjectsChanged() {
    this.onObjectsChanged?.(Array.from(this.objectData.values()));
  }

  public dispose() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    window.removeEventListener('resize', this.onResize);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.dispose();
    this.transformControls.dispose();
    this.orbitControls.dispose();
    this.container.innerHTML = '';
  }
}
