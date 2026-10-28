import type { LauncherSessionBootstrap } from './api/rest-client';

declare global {
  interface Window {
    maosNative?: {
      initialize(): Promise<LauncherSessionBootstrap>;
    };
  }
}

export {};
