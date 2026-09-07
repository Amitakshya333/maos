/**
 * MAOS Plugin Registry
 *
 * Enables third-party providers and runtimes to be registered dynamically
 * without modifying MAOS core code. Plugins can be loaded from:
 *
 *   1. Built-in providers (openai, anthropic, gemini)
 *   2. Config-registered plugins (maos.config.json → plugins section)
 *   3. Programmatic registration via registerProvider() / registerRuntime()
 *
 * Plugin API:
 *   - Provider plugins implement IProvider (see provider.ts)
 *   - Runtime plugins implement IRuntime (see runtime.ts)
 *
 * Example maos.config.json:
 * ```json
 * {
 *   "plugins": {
 *     "providers": {
 *       "my-local-llm": {
 *         "module": "./plugins/my-local-llm.js",
 *         "config": { "port": 8080 }
 *       }
 *     },
 *     "runtimes": {
 *       "docker-runtime": {
 *         "module": "./plugins/docker-runtime.js",
 *         "config": { "image": "node:20" }
 *       }
 *     }
 *   }
 * }
 * ```
 */

import { IProvider, ProviderConfig } from './provider';
import { IRuntime } from './runtime';

// ---- Types ----

export interface PluginManifest {
  /** Plugin name (unique identifier) */
  name: string;
  /** Plugin version (semver) */
  version: string;
  /** Plugin type */
  type: 'provider' | 'runtime';
  /** Human-readable description */
  description?: string;
  /** Author */
  author?: string;
}

export type ProviderFactory = (config: Record<string, unknown>) => IProvider;
export type RuntimeFactory = (config: Record<string, unknown>) => IRuntime;

interface ProviderRegistration {
  manifest: PluginManifest;
  factory: ProviderFactory;
}

interface RuntimeRegistration {
  manifest: PluginManifest;
  factory: RuntimeFactory;
}

// ---- Plugin Registry ----

class PluginRegistry {
  private providers = new Map<string, ProviderRegistration>();
  private runtimes = new Map<string, RuntimeRegistration>();

  /**
   * Register a provider plugin.
   *
   * @param name - Unique provider name (e.g., "my-local-llm")
   * @param factory - Function that creates an IProvider given config
   * @param manifest - Optional plugin metadata
   */
  registerProvider(name: string, factory: ProviderFactory, manifest?: Partial<PluginManifest>): void {
    this.providers.set(name, {
      manifest: {
        name,
        version: manifest?.version || '0.0.0',
        type: 'provider',
        description: manifest?.description,
        author: manifest?.author,
      },
      factory,
    });
  }

  /**
   * Register a runtime plugin.
   *
   * @param name - Unique runtime name (e.g., "docker", "ssh")
   * @param factory - Function that creates an IRuntime given config
   * @param manifest - Optional plugin metadata
   */
  registerRuntime(name: string, factory: RuntimeFactory, manifest?: Partial<PluginManifest>): void {
    this.runtimes.set(name, {
      manifest: {
        name,
        version: manifest?.version || '0.0.0',
        type: 'runtime',
        description: manifest?.description,
        author: manifest?.author,
      },
      factory,
    });
  }

  /**
   * Check if a provider plugin is registered.
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Check if a runtime plugin is registered.
   */
  hasRuntime(name: string): boolean {
    return this.runtimes.has(name);
  }

  /**
   * Create a provider instance from a registered plugin.
   */
  createProvider(name: string, config: Record<string, unknown> = {}): IProvider {
    const reg = this.providers.get(name);
    if (!reg) {
      throw new Error(
        `Provider plugin "${name}" is not registered. ` + `Available: [${this.getProviderNames().join(', ')}]`,
      );
    }
    return reg.factory(config);
  }

  /**
   * Create a runtime instance from a registered plugin.
   */
  createRuntime(name: string, config: Record<string, unknown> = {}): IRuntime {
    const reg = this.runtimes.get(name);
    if (!reg) {
      throw new Error(
        `Runtime plugin "${name}" is not registered. ` + `Available: [${this.getRuntimeNames().join(', ')}]`,
      );
    }
    return reg.factory(config);
  }

  /**
   * Get all registered provider names.
   */
  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get all registered runtime names.
   */
  getRuntimeNames(): string[] {
    return Array.from(this.runtimes.keys());
  }

  /**
   * Get manifests for all registered plugins.
   */
  getManifests(): PluginManifest[] {
    const all: PluginManifest[] = [];
    for (const reg of this.providers.values()) all.push(reg.manifest);
    for (const reg of this.runtimes.values()) all.push(reg.manifest);
    return all;
  }

  /**
   * Load plugins from config object.
   * Attempts to require() module paths specified in config.
   *
   * Expected format:
   * ```json
   * {
   *   "providers": {
   *     "name": { "module": "./path/to/module.js", "config": {} }
   *   },
   *   "runtimes": {
   *     "name": { "module": "./path/to/module.js", "config": {} }
   *   }
   * }
   * ```
   */
  loadFromConfig(pluginsConfig: Record<string, any>, projectRoot: string): { loaded: string[]; errors: string[] } {
    const loaded: string[] = [];
    const errors: string[] = [];

    // Load provider plugins
    if (pluginsConfig.providers && typeof pluginsConfig.providers === 'object') {
      for (const [name, def] of Object.entries<any>(pluginsConfig.providers)) {
        try {
          if (!def.module) {
            errors.push(`Provider "${name}": missing "module" field`);
            continue;
          }
          const modulePath = require.resolve(def.module, { paths: [projectRoot] });
          const mod = require(modulePath);
          const factory: ProviderFactory = mod.createProvider || mod.default;
          if (typeof factory !== 'function') {
            errors.push(`Provider "${name}": module must export createProvider() or default()`);
            continue;
          }
          this.registerProvider(name, factory, mod.manifest);
          loaded.push(`provider:${name}`);
        } catch (err: any) {
          errors.push(`Provider "${name}": ${err.message}`);
        }
      }
    }

    // Load runtime plugins
    if (pluginsConfig.runtimes && typeof pluginsConfig.runtimes === 'object') {
      for (const [name, def] of Object.entries<any>(pluginsConfig.runtimes)) {
        try {
          if (!def.module) {
            errors.push(`Runtime "${name}": missing "module" field`);
            continue;
          }
          const modulePath = require.resolve(def.module, { paths: [projectRoot] });
          const mod = require(modulePath);
          const factory: RuntimeFactory = mod.createRuntime || mod.default;
          if (typeof factory !== 'function') {
            errors.push(`Runtime "${name}": module must export createRuntime() or default()`);
            continue;
          }
          this.registerRuntime(name, factory, mod.manifest);
          loaded.push(`runtime:${name}`);
        } catch (err: any) {
          errors.push(`Runtime "${name}": ${err.message}`);
        }
      }
    }

    return { loaded, errors };
  }
}

// ---- Singleton ----

let _registry: PluginRegistry | null = null;

/**
 * Get the plugin registry singleton.
 */
export function getPluginRegistry(): PluginRegistry {
  if (!_registry) {
    _registry = new PluginRegistry();
  }
  return _registry;
}
