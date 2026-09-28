/**
 * F9-04: Network Socket Observer Platform Exports & Factory
 */

import { SocketObserverAdapter } from './socket-observer-adapter';
import { WindowsSocketObserver } from './windows-socket-observer';
import { LinuxSocketObserver } from './linux-socket-observer';
import { MockSocketObserver } from './mock-socket-observer';

export * from './socket-observer-adapter';
export * from './windows-socket-observer';
export * from './linux-socket-observer';
export * from './mock-socket-observer';

export type SupportedNetworkPlatform = 'windows' | 'linux' | 'mock';

export function createPlatformSocketObserver(
  overridePlatform?: SupportedNetworkPlatform,
): SocketObserverAdapter {
  if (overridePlatform === 'mock') {
    return new MockSocketObserver();
  }

  if (overridePlatform === 'windows') {
    return new WindowsSocketObserver();
  }

  if (overridePlatform === 'linux') {
    return new LinuxSocketObserver();
  }

  // Automatic platform detection
  if (process.platform === 'win32') {
    return new WindowsSocketObserver();
  }

  if (process.platform === 'linux') {
    return new LinuxSocketObserver();
  }

  // Fallback to mock on other environments
  return new MockSocketObserver();
}
