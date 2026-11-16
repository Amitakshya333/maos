import React, { useState } from 'react';
import {
  Box,
  Circle,
  Cylinder,
  Disc,
  Triangle,
  Gem,
  Palette,
  Sparkles,
  LayoutGrid,
  Zap,
  Shield,
  Layers,
  RotateCw,
} from 'lucide-react';
import { MaterialPreset, ShapeType } from '../types';

interface SidebarProps {
  onAddShape: (type: ShapeType, position?: [number, number, number]) => void;
  onApplyPreset: (preset: MaterialPreset) => void;
  onLoadTemplate: (templateName: string) => void;
}

const SHAPES: Array<{ type: ShapeType; name: string; description: string; icon: React.ReactNode }> = [
  { type: 'cube', name: 'Cube', description: 'Standard 3D Box', icon: <Box className="w-5 h-5 text-violet-400" /> },
  { type: 'sphere', name: 'Sphere', description: 'Smooth 3D Ball', icon: <Circle className="w-5 h-5 text-fuchsia-400" /> },
  { type: 'cylinder', name: 'Cylinder', description: 'Pillar Column', icon: <Cylinder className="w-5 h-5 text-pink-400" /> },
  { type: 'capsule', name: 'Capsule', description: 'Pill Geometry', icon: <Disc className="w-5 h-5 text-amber-400" /> },
  { type: 'torus', name: 'Torus', description: 'Donut Ring', icon: <RotateCw className="w-5 h-5 text-emerald-400" /> },
  { type: 'cone', name: 'Cone', description: 'Tapered Spire', icon: <Triangle className="w-5 h-5 text-cyan-400" /> },
  { type: 'pyramid', name: 'Pyramid', description: '4-sided Monument', icon: <Triangle className="w-5 h-5 text-yellow-400" /> },
  { type: 'diamond', name: 'Diamond', description: 'Facet Polyhedron', icon: <Gem className="w-5 h-5 text-teal-300" /> },
  { type: 'torusKnot', name: 'Torus Knot', description: 'Complex Braided Core', icon: <Sparkles className="w-5 h-5 text-rose-400" /> },
  { type: 'ring', name: 'Ring', description: 'Flat Circular Halo', icon: <Disc className="w-5 h-5 text-indigo-400" /> },
  { type: 'badge', name: 'Badge', description: 'Extruded Star Plaque', icon: <Shield className="w-5 h-5 text-purple-400" /> },
  { type: 'proceduralStar', name: 'Gemma Star', description: 'Procedural 10-Point Mesh', icon: <Sparkles className="w-5 h-5 text-yellow-300 animate-spin" /> },
  { type: 'proceduralHelix', name: 'Gemma Helix', description: 'Coiled 3D Spring Math', icon: <RotateCw className="w-5 h-5 text-cyan-300 animate-pulse" /> },
  { type: 'crystal', name: 'Gemma Crystal', description: 'Polyhedral Geode Mesh', icon: <Gem className="w-5 h-5 text-indigo-400 animate-pulse" /> },
];

const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    name: 'Cyberpunk Neon',
    category: 'neon',
    gradientBadge: 'from-pink-500 to-cyan-500',
    properties: {
      color: '#ec4899',
      roughness: 0.1,
      metalness: 0.8,
      transmission: 0.0,
      opacity: 1.0,
      transparent: false,
      wireframe: false,
      emissive: '#f43f5e',
      emissiveIntensity: 0.6,
    },
  },
  {
    name: 'Liquid Gold',
    category: 'metallic',
    gradientBadge: 'from-amber-300 to-yellow-600',
    properties: {
      color: '#ffd700',
      roughness: 0.15,
      metalness: 0.95,
      transmission: 0.0,
      opacity: 1.0,
      transparent: false,
      wireframe: false,
      emissive: '#78350f',
      emissiveIntensity: 0.1,
    },
  },
  {
    name: 'Frosted Glass',
    category: 'glass',
    gradientBadge: 'from-cyan-200 to-blue-400',
    properties: {
      color: '#ffffff',
      roughness: 0.1,
      metalness: 0.05,
      transmission: 0.92,
      opacity: 1.0,
      transparent: true,
      wireframe: false,
      emissive: '#000000',
      emissiveIntensity: 0.0,
      clearcoat: 1.0,
    },
  },
  {
    name: 'Chrome Mirror',
    category: 'metallic',
    gradientBadge: 'from-slate-200 to-slate-500',
    properties: {
      color: '#e2e8f0',
      roughness: 0.02,
      metalness: 0.98,
      transmission: 0.0,
      opacity: 1.0,
      transparent: false,
      wireframe: false,
      emissive: '#000000',
      emissiveIntensity: 0.0,
    },
  },
  {
    name: 'Alien Emerald',
    category: 'neon',
    gradientBadge: 'from-emerald-400 to-teal-700',
    properties: {
      color: '#10b981',
      roughness: 0.25,
      metalness: 0.6,
      transmission: 0.3,
      opacity: 0.9,
      transparent: true,
      wireframe: false,
      emissive: '#059669',
      emissiveIntensity: 0.4,
    },
  },
  {
    name: 'Obsidian Velvet',
    category: 'matte',
    gradientBadge: 'from-slate-800 to-slate-950',
    properties: {
      color: '#18181b',
      roughness: 0.85,
      metalness: 0.1,
      transmission: 0.0,
      opacity: 1.0,
      transparent: false,
      wireframe: false,
      emissive: '#000000',
      emissiveIntensity: 0.0,
    },
  },
  {
    name: 'Hologram Wire',
    category: 'neon',
    gradientBadge: 'from-cyan-400 via-violet-400 to-fuchsia-500',
    properties: {
      color: '#38bdf8',
      roughness: 0.0,
      metalness: 0.2,
      transmission: 0.0,
      opacity: 0.8,
      transparent: true,
      wireframe: true,
      emissive: '#0284c7',
      emissiveIntensity: 0.8,
    },
  },
  {
    name: 'Bubblegum Clay',
    category: 'matte',
    gradientBadge: 'from-pink-400 to-rose-400',
    properties: {
      color: '#f472b6',
      roughness: 0.9,
      metalness: 0.0,
      transmission: 0.0,
      opacity: 1.0,
      transparent: false,
      wireframe: false,
      emissive: '#000000',
      emissiveIntensity: 0.0,
    },
  },
];

export const Sidebar: React.FC<SidebarProps> = ({ onAddShape, onApplyPreset, onLoadTemplate }) => {
  const [activeTab, setActiveTab] = useState<'elements' | 'materials' | 'templates'>('elements');

  return (
    <aside className="w-80 h-[calc(100vh-3.5rem)] bg-[#121524]/95 border-r border-white/10 flex flex-col z-20 select-none backdrop-blur-md">
      {/* Top Tab Switcher */}
      <div className="grid grid-cols-3 p-2 gap-1 border-b border-white/5 bg-[#171b2e]/60">
        <button
          onClick={() => setActiveTab('elements')}
          className={`py-2 text-xs font-semibold rounded-lg flex flex-col items-center justify-center space-y-1 transition-all ${
            activeTab === 'elements'
              ? 'bg-violet-600 text-white shadow-md shadow-violet-600/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
          }`}
        >
          <Box className="w-4 h-4" />
          <span>Elements</span>
        </button>
        <button
          onClick={() => setActiveTab('materials')}
          className={`py-2 text-xs font-semibold rounded-lg flex flex-col items-center justify-center space-y-1 transition-all ${
            activeTab === 'materials'
              ? 'bg-violet-600 text-white shadow-md shadow-violet-600/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
          }`}
        >
          <Palette className="w-4 h-4" />
          <span>Materials</span>
        </button>
        <button
          onClick={() => setActiveTab('templates')}
          className={`py-2 text-xs font-semibold rounded-lg flex flex-col items-center justify-center space-y-1 transition-all ${
            activeTab === 'templates'
              ? 'bg-violet-600 text-white shadow-md shadow-violet-600/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
          }`}
        >
          <LayoutGrid className="w-4 h-4" />
          <span>Scenes</span>
        </button>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ELEMENTS TAB */}
        {activeTab === 'elements' && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">3D Primitives</span>
              <span className="text-[11px] text-violet-400 font-medium">Drag or Click</span>
            </div>
            <p className="text-[11px] text-slate-400 mb-3">
              Drag any shape into the 3D canvas or click to place it in the center.
            </p>

            <div className="grid grid-cols-2 gap-2.5">
              {SHAPES.map((shape) => (
                <div
                  key={shape.type}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', shape.type);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => onAddShape(shape.type)}
                  className="group relative flex flex-col items-center justify-center p-3 rounded-xl bg-[#1a1f33] border border-white/5 hover:border-violet-500/50 hover:bg-[#212740] cursor-grab active:cursor-grabbing transition-all shadow-sm hover:shadow-lg hover:shadow-violet-600/10 hover:-translate-y-0.5"
                >
                  <div className="w-12 h-12 rounded-lg bg-[#272d47] flex items-center justify-center mb-2 group-hover:scale-110 transition-transform shadow-inner">
                    {shape.icon}
                  </div>
                  <span className="text-xs font-semibold text-slate-200 group-hover:text-white">
                    {shape.name}
                  </span>
                  <span className="text-[10px] text-slate-400 text-center truncate max-w-full">
                    {shape.description}
                  </span>
                  <span className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-violet-400 bg-violet-950/80 px-1 rounded font-mono">
                    +Add
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* MATERIALS TAB */}
        {activeTab === 'materials' && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">PBR Shader Presets</span>
              <span className="text-[11px] text-violet-400 font-medium">1-Click Apply</span>
            </div>
            <p className="text-[11px] text-slate-400 mb-3">
              Select an object on the canvas and click a preset to apply photorealistic materials.
            </p>

            <div className="grid grid-cols-2 gap-2.5">
              {MATERIAL_PRESETS.map((preset) => (
                <div
                  key={preset.name}
                  onClick={() => onApplyPreset(preset)}
                  className="group p-3 rounded-xl bg-[#1a1f33] border border-white/5 hover:border-violet-500/50 hover:bg-[#212740] cursor-pointer transition-all shadow-sm hover:shadow-lg hover:-translate-y-0.5"
                >
                  <div
                    className={`w-full h-12 rounded-lg bg-gradient-to-tr ${preset.gradientBadge} mb-2 shadow-md flex items-center justify-center group-hover:scale-105 transition-transform`}
                  >
                    <Sparkles className="w-5 h-5 text-white/90 drop-shadow" />
                  </div>
                  <span className="text-xs font-semibold text-slate-200 block truncate group-hover:text-white">
                    {preset.name}
                  </span>
                  <span className="text-[10px] text-slate-400 capitalize">{preset.category}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TEMPLATES TAB */}
        {activeTab === 'templates' && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Starter Compositions</span>
            </div>
            <p className="text-[11px] text-slate-400 mb-3">
              Load ready-to-render 3D spatial studio layouts.
            </p>

            <div className="space-y-2.5">
              <div
                onClick={() => onLoadTemplate('cyberpunk')}
                className="group p-3 rounded-xl bg-gradient-to-r from-violet-900/40 to-pink-900/40 border border-violet-500/30 hover:border-pink-500/60 cursor-pointer transition-all hover:-translate-y-0.5"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-lg bg-pink-500/20 border border-pink-500/30 flex items-center justify-center text-pink-400">
                    <Zap className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-100 group-hover:text-pink-300">
                      Cyberpunk Neo-Trophy
                    </h4>
                    <p className="text-[10px] text-slate-400">Torus knot on glass pedestal with neon rim lights</p>
                  </div>
                </div>
              </div>

              <div
                onClick={() => onLoadTemplate('minimal')}
                className="group p-3 rounded-xl bg-gradient-to-r from-slate-900/50 to-indigo-900/40 border border-white/10 hover:border-indigo-500/50 cursor-pointer transition-all hover:-translate-y-0.5"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                    <Box className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-100 group-hover:text-indigo-300">
                      Studio Product Stage
                    </h4>
                    <p className="text-[10px] text-slate-400">Clean cylinder podium with gold accents</p>
                  </div>
                </div>
              </div>

              <div
                onClick={() => onLoadTemplate('abstract')}
                className="group p-3 rounded-xl bg-gradient-to-r from-emerald-900/40 to-teal-900/40 border border-emerald-500/30 hover:border-emerald-500/60 cursor-pointer transition-all hover:-translate-y-0.5"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                    <Gem className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-100 group-hover:text-emerald-300">
                      Polyhedral Cascade
                    </h4>
                    <p className="text-[10px] text-slate-400">Floating diamonds, spheres, and metallic rings</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="p-3 border-t border-white/5 bg-[#171b2e]/60 flex items-center justify-between text-[11px] text-slate-400">
        <span className="flex items-center space-x-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Gemma Swarm Online</span>
        </span>
        <span className="font-mono text-[10px] text-slate-500">v1.0.0</span>
      </div>
    </aside>
  );
};
