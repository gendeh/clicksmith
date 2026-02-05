import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, shell } from 'electron';
import { ModAdapterManifest, ModAdapterStatus, ModRegistry } from '../types';

const DEFAULT_REGISTRY: ModRegistry = {
  version: 1,
  adapters: [
    {
      id: 'geode-geometry-dash',
      name: 'Geode (Geometry Dash)',
      framework: 'Geode',
      game: 'Geometry Dash',
      description: 'Optional mod framework for high-fidelity input timing.',
      platforms: ['win32', 'darwin'],
      install: {
        instructionsPath: 'docs/mods/geode.md',
        downloadUrl: 'https://geode-sdk.org',
      },
      detect: {
        darwin: [
          '~/Library/Application Support/Geode',
          '~/Library/Application Support/GeometryDash/Geode',
          '~/Library/Application Support/Geometry Dash/Geode',
          '~/Library/Application Support/Steam/steamapps/common/Geometry Dash/Geode',
          '~/Library/Application Support/Steam/steamapps/common/Geometry Dash/Geometry Dash.app/Contents/geode',
        ],
        win32: [
          '%APPDATA%\\Geode',
          '%LOCALAPPDATA%\\Geode',
          '%PROGRAMFILES(X86)%\\Steam\\steamapps\\common\\Geometry Dash\\Geode',
        ],
      },
      launch: {
        type: 'uri',
        value: 'steam://rungameid/322170',
      },
      protocol: {
        type: 'local-http',
        statusUrl: 'http://127.0.0.1:27737/status',
        baseUrl: 'http://127.0.0.1:27737',
      },
    },
  ],
};

const REGISTRY_CANDIDATES = () => {
  const envPath = process.env.CLICKSMITH_MODS_PATH;
  return [
    envPath,
    path.join(process.resourcesPath, 'mods', 'registry.json'),
    path.resolve(process.cwd(), '..', 'mods', 'registry.json'),
    path.resolve(process.cwd(), 'mods', 'registry.json'),
  ].filter(Boolean) as string[];
};

function expandPath(input: string): string {
  let output = input.trim();
  if (output.startsWith('~')) {
    output = path.join(os.homedir(), output.slice(1));
  }
  output = output.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, name) => process.env[name] ?? `$${name}`);
  output = output.replace(/\${([^}]+)}/g, (_, name) => process.env[name] ?? `\${${name}}`);
  output = output.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
  return output;
}

function resolveRegistry(): ModRegistry {
  for (const candidate of REGISTRY_CANDIDATES()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw) as ModRegistry;
      if (parsed && Array.isArray(parsed.adapters)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return DEFAULT_REGISTRY;
}

function resolvePathFromRepo(relPath: string): string | null {
  const roots = [
    process.env.CLICKSMITH_ROOT,
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    app.getAppPath(),
    path.resolve(app.getAppPath(), '..'),
  ].filter(Boolean) as string[];

  for (const root of roots) {
    const candidate = path.resolve(root, relPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function detectInstall(adapter: ModAdapterManifest): { installed: boolean; detectedPath?: string } {
  const platform = process.platform;
  const candidates = adapter.detect?.[platform] ?? [];
  for (const entry of candidates) {
    const resolved = expandPath(entry);
    if (fs.existsSync(resolved)) {
      return { installed: true, detectedPath: resolved };
    }
  }
  return { installed: false };
}

async function probeConnection(adapter: ModAdapterManifest): Promise<{ connection: ModAdapterStatus['connection']; lastError?: string }> {
  const statusUrl = adapter.protocol?.statusUrl;
  if (!statusUrl) {
    return { connection: 'unknown', lastError: 'No status endpoint configured.' };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900);
    const response = await fetch(statusUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return { connection: 'unreachable', lastError: `Status error (${response.status})` };
    }
    return { connection: 'connected' };
  } catch (error: any) {
    return { connection: 'unreachable', lastError: error?.message ?? 'Connection failed' };
  }
}

export class ModManager {
  private registry: ModRegistry;

  constructor() {
    this.registry = resolveRegistry();
  }

  public listAdapters(): ModAdapterStatus[] {
    this.registry = resolveRegistry();
    const adapters = this.registry.adapters.filter(
      adapter => !adapter.platforms || adapter.platforms.includes(process.platform)
    );
    return adapters.map(adapter => {
      const install = detectInstall(adapter);
      return {
        adapter,
        installed: install.installed,
        detectedPath: install.detectedPath,
        connection: 'unknown',
      };
    });
  }

  public async probeAdapter(id: string): Promise<ModAdapterStatus | null> {
    this.registry = resolveRegistry();
    const adapter = this.registry.adapters.find(item => item.id === id);
    if (!adapter) return null;
    const install = detectInstall(adapter);
    const connection = await probeConnection(adapter);
    return {
      adapter,
      installed: install.installed,
      detectedPath: install.detectedPath,
      connection: connection.connection,
      lastError: connection.lastError,
    };
  }

  public async openInstallDoc(id: string): Promise<{ success: boolean; error?: string }> {
    this.registry = resolveRegistry();
    const adapter = this.registry.adapters.find(item => item.id === id);
    const docPath = adapter?.install?.instructionsPath;
    if (!adapter || !docPath) {
      return { success: false, error: 'Install instructions not configured.' };
    }
    const resolved = resolvePathFromRepo(docPath);
    if (!resolved) {
      return { success: false, error: 'Install document not found.' };
    }
    await shell.openPath(resolved);
    return { success: true };
  }

  public async openDownloadUrl(url: string): Promise<{ success: boolean; error?: string }> {
    if (!url) return { success: false, error: 'Missing download URL.' };
    await shell.openExternal(url);
    return { success: true };
  }

  public async launchAdapter(id: string): Promise<{ success: boolean; error?: string }> {
    this.registry = resolveRegistry();
    const adapter = this.registry.adapters.find(item => item.id === id);
    if (!adapter?.launch) {
      return { success: false, error: 'Launch configuration missing.' };
    }
    const launch = adapter.launch;
    if (launch.type === 'uri') {
      await shell.openExternal(launch.value);
      return { success: true };
    }
    if (launch.type === 'appPath') {
      const resolved = resolvePathFromRepo(expandPath(launch.value)) ?? expandPath(launch.value);
      const result = await shell.openPath(resolved);
      if (result) {
        return { success: false, error: result };
      }
      return { success: true };
    }
    return { success: false, error: 'Unsupported launch type.' };
  }
}
