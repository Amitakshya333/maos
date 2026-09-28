/**
 * F9-03: Firewall Adapters Public API & Factory
 */

import { FirewallAdapter } from './firewall-adapter';
import { WindowsFirewallAdapter } from './windows-firewall-adapter';
import { LinuxFirewallAdapter } from './linux-firewall-adapter';
import { MockFirewallAdapter, MockFirewallAdapterOptions } from './mock-firewall-adapter';

export * from './firewall-adapter';
export * from './windows-firewall-adapter';
export * from './linux-firewall-adapter';
export * from './mock-firewall-adapter';

/**
 * Creates the appropriate platform firewall adapter based on OS or explicit configuration.
 */
export function createPlatformFirewallAdapter(
  platformOverride?: 'windows' | 'linux' | 'mock',
  mockOptions?: MockFirewallAdapterOptions,
): FirewallAdapter {
  if (platformOverride === 'mock') {
    return new MockFirewallAdapter(mockOptions);
  }

  const platform = platformOverride || (process.platform === 'win32' ? 'windows' : 'linux');

  if (platform === 'windows') {
    return new WindowsFirewallAdapter();
  }

  if (platform === 'linux') {
    return new LinuxFirewallAdapter();
  }

  return new MockFirewallAdapter(mockOptions);
}
