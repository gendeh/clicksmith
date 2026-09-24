import fs from 'fs';
import path from 'path';
import { GameCatalog, parseGameCatalog } from '../domain/gameCatalog';

const EMPTY_CATALOG: GameCatalog = { version: 1, games: [] };

function catalogCandidates(): string[] {
  const envPath = process.env.CLICKSMITH_GAMES_PATH;
  return [
    envPath,
    path.join(process.resourcesPath || '', 'games', 'catalog.json'),
    path.resolve(process.cwd(), 'games', 'catalog.json'),
    path.resolve(process.cwd(), '..', 'games', 'catalog.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function loadGameCatalog(): GameCatalog {
  for (const candidate of catalogCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, 'utf-8');
    return parseGameCatalog(JSON.parse(raw));
  }
  return EMPTY_CATALOG;
}
