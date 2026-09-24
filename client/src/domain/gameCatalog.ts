export type GameInput = 'mouse' | 'keyboard';

export interface GameDefinition {
  id: string;
  name: string;
  summary: string;
  windowHints: string[];
  inputs: GameInput[];
  adapterId?: string;
}

export interface GameCatalog {
  version: 1;
  screenFallbackAdapterId?: string;
  games: GameDefinition[];
}

const GAME_INPUTS: ReadonlySet<string> = new Set(['mouse', 'keyboard']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseGame(value: unknown): GameDefinition {
  if (!isRecord(value)) {
    throw new Error('game_catalog_invalid');
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new Error('game_catalog_invalid');
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    throw new Error('game_catalog_invalid');
  }
  if (typeof value.summary !== 'string') {
    throw new Error('game_catalog_invalid');
  }
  if (!Array.isArray(value.windowHints) || value.windowHints.length === 0) {
    throw new Error('game_catalog_invalid');
  }
  if (!value.windowHints.every(hint => typeof hint === 'string' && hint.trim() !== '')) {
    throw new Error('game_catalog_invalid');
  }
  if (!Array.isArray(value.inputs) || value.inputs.length === 0) {
    throw new Error('game_catalog_invalid');
  }
  if (!value.inputs.every(input => typeof input === 'string' && GAME_INPUTS.has(input))) {
    throw new Error('game_catalog_invalid');
  }
  if (value.adapterId !== undefined && typeof value.adapterId !== 'string') {
    throw new Error('game_catalog_invalid');
  }
  return {
    id: value.id,
    name: value.name,
    summary: value.summary,
    windowHints: value.windowHints as string[],
    inputs: value.inputs as GameInput[],
    ...(typeof value.adapterId === 'string' ? { adapterId: value.adapterId } : {}),
  };
}

export function parseGameCatalog(value: unknown): GameCatalog {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.games)) {
    throw new Error('game_catalog_invalid');
  }
  if (value.screenFallbackAdapterId !== undefined && typeof value.screenFallbackAdapterId !== 'string') {
    throw new Error('game_catalog_invalid');
  }
  const games = value.games.map(parseGame);
  const ids = new Set<string>();
  for (const game of games) {
    if (ids.has(game.id)) {
      throw new Error('game_catalog_duplicate_id');
    }
    ids.add(game.id);
  }
  return {
    version: 1,
    ...(typeof value.screenFallbackAdapterId === 'string'
      ? { screenFallbackAdapterId: value.screenFallbackAdapterId }
      : {}),
    games,
  };
}

export function matchGame(catalog: GameCatalog, windowTitle: string): GameDefinition | undefined {
  const haystack = windowTitle.trim().toLowerCase();
  if (!haystack || haystack === 'screen') return undefined;
  let best: { game: GameDefinition; hintLength: number } | undefined;
  for (const game of catalog.games) {
    for (const hint of game.windowHints) {
      const needle = hint.trim().toLowerCase();
      if (!needle || !haystack.includes(needle)) continue;
      if (!best || needle.length > best.hintLength) {
        best = { game, hintLength: needle.length };
      }
    }
  }
  return best?.game;
}

export function adapterIdForTarget(
  catalog: GameCatalog,
  target: string | null | undefined,
  useModAdapter: boolean
): string | null {
  const normalized = target?.trim().toLowerCase() ?? '';
  if (normalized && normalized !== 'screen') {
    return matchGame(catalog, target ?? '')?.adapterId ?? null;
  }
  if (useModAdapter && catalog.screenFallbackAdapterId) {
    return catalog.screenFallbackAdapterId;
  }
  return null;
}
