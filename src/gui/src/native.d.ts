import type { LauncherSessionBootstrap } from './api/rest-client';

declare global {
  interface Window {
    maosNative?: {
      initialize(): Promise<LauncherSessionBootstrap>;
      /** TASK RING-DEV-B-01: overlay asks the main window to focus the full Ring view on the same thread. Absent outside Electron. */
      expandRing?(): void;
      /**
       * TASK RING-DEV-B-01 (Day 2c): explicit screenshot trigger. Resolves
       * with PNG base64 held in memory (nothing written, nothing sent) or a
       * dismissed reason. Absent outside Electron (browser falls back to
       * getDisplayMedia).
       */
      captureRingScreen?(): Promise<
        | { pngBase64: string; width: number; height: number; displays: number }
        | { dismissed: true; reason: string }
      >;
    };
  }
}

export {};
