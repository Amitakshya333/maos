import React from 'react';
import { Copy, Trash2, Move, RotateCw, Maximize2, Crosshair } from 'lucide-react';
import { MaterialProperties, SceneObjectData, TransformMode } from '../types';

interface FloatingToolbarProps {
  selectedObject: SceneObjectData | null;
  transformMode: TransformMode;
  onSetTransformMode: (mode: TransformMode) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdateMaterial: (id: string, props: Partial<MaterialProperties>) => void;
  onCenterObject: (id: string) => void;
}

export const FloatingToolbar: React.FC<FloatingToolbarProps> = ({
  selectedObject,
  transformMode,
  onSetTransformMode,
  onDuplicate,
  onDelete,
  onUpdateMaterial,
  onCenterObject,
}) => {
  if (!selectedObject) return null;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-[#181d30]/90 backdrop-blur-xl border border-violet-500/30 shadow-2xl shadow-black/60 select-none animate-in fade-in slide-in-from-top-2 duration-200">
      {/* Object Type Badge */}
      <span className="text-xs font-bold text-slate-200 px-2 border-r border-white/10 flex items-center space-x-1.5">
        <span className="w-2 h-2 rounded-full bg-violet-400" />
        <span className="capitalize">{selectedObject.name}</span>
      </span>

      {/* Color Swatch Trigger */}
      <div className="relative flex items-center px-1">
        <input
          type="color"
          value={selectedObject.material.color}
          onChange={(e) => onUpdateMaterial(selectedObject.id, { color: e.target.value })}
          className="w-5 h-5 rounded-full cursor-pointer border-0 bg-transparent"
          title="Change Color"
        />
      </div>

      <div className="h-4 w-px bg-white/10 mx-1" />

      {/* Mode Switches */}
      <button
        onClick={() => onSetTransformMode('translate')}
        className={`p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-full transition-colors touch-manipulation ${
          transformMode === 'translate' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
        }`}
        title="Translate (W)"
      >
        <Move className="w-4 h-4" />
      </button>

      <button
        onClick={() => onSetTransformMode('rotate')}
        className={`p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-full transition-colors touch-manipulation ${
          transformMode === 'rotate' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
        }`}
        title="Rotate (E)"
      >
        <RotateCw className="w-4 h-4" />
      </button>

      <button
        onClick={() => onSetTransformMode('scale')}
        className={`p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-full transition-colors touch-manipulation ${
          transformMode === 'scale' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
        }`}
        title="Scale (R)"
      >
        <Maximize2 className="w-4 h-4" />
      </button>

      <div className="h-4 w-px bg-white/10 mx-1" />

      {/* Center button */}
      <button
        onClick={() => onCenterObject(selectedObject.id)}
        className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-full text-slate-400 hover:text-white transition-colors touch-manipulation"
        title="Align to Center"
      >
        <Crosshair className="w-4 h-4" />
      </button>

      {/* Duplicate */}
      <button
        onClick={() => onDuplicate(selectedObject.id)}
        className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-full text-slate-400 hover:text-white transition-colors touch-manipulation"
        title="Duplicate (Ctrl+D)"
      >
        <Copy className="w-4 h-4" />
      </button>

      {/* Delete */}
      <button
        onClick={() => onDelete(selectedObject.id)}
        className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-full text-red-400 hover:text-red-300 hover:bg-red-500/20 transition-colors touch-manipulation"
        title="Delete (Del)"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
};
