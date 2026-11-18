import React, { useRef, useEffect } from 'react';
import { ShapeType } from '../types';

interface ViewportProps {
  canvasContainerRef: React.RefObject<HTMLDivElement>;
  onDropShape: (type: ShapeType, position: [number, number, number]) => void;
  getGroundPoint: (x: number, y: number) => { x: number; y: number; z: number };
}

export const Viewport: React.FC<ViewportProps> = ({
  canvasContainerRef,
  onDropShape,
  getGroundPoint,
}) => {
  const [isDragOver, setIsDragOver] = React.useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const shapeType = e.dataTransfer.getData('text/plain') as ShapeType;
    if (shapeType) {
      const point = getGroundPoint(e.clientX, e.clientY);
      onDropShape(shapeType, [point.x, Math.max(0.7, point.y), point.z]);
    }
  };

  return (
    <div
      className="relative flex-1 h-[calc(100vh-3.5rem)] overflow-hidden select-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Three.js Canvas Container */}
      <div
        ref={canvasContainerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing touch-none"
        style={{ touchAction: 'none' }}
      />

      {/* Drag Over Overlay Glow */}
      {isDragOver && (
        <div className="absolute inset-0 pointer-events-none border-4 border-dashed border-violet-500/80 bg-violet-950/20 backdrop-blur-[2px] flex items-center justify-center animate-pulse">
          <div className="bg-[#1c2136]/90 px-6 py-3 rounded-2xl border border-violet-400 text-sm font-bold text-violet-200 shadow-2xl">
            Drop anywhere to place in 3D Space
          </div>
        </div>
      )}

      {/* Subtle Bottom Navigation Tip */}
      <div className="absolute bottom-4 left-6 pointer-events-none flex items-center space-x-3 text-[11px] text-slate-400/80 bg-[#121524]/60 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/5">
        <span>Orbit: <strong className="text-slate-200">Left Click</strong></span>
        <span>•</span>
        <span>Pan: <strong className="text-slate-200">Right Click</strong></span>
        <span>•</span>
        <span>Zoom: <strong className="text-slate-200">Scroll</strong></span>
        <span>•</span>
        <span>Gizmo: <strong className="text-slate-200">W / E / R</strong></span>
      </div>
    </div>
  );
};
