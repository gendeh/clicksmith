import fs from 'fs';
import path from 'path';
import { adapterIdForTarget, matchGame, parseGameCatalog } from '../src/domain/gameCatalog';

const catalogPath = path.resolve(__dirname, '../../games/catalog.json');

function loadCatalog() {
  return parseGameCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf-8')));
}

describe('game catalog', () => {
  const catalog = loadCatalog();

  test('ships Geometry Dash, Genshin Impact, and Minecraft from catalog.json', () => {
    expect(catalog.games.map(game => game.id)).toEqual([
      'geometry-dash',
      'genshin-impact',
      'minecraft',
    ]);
  });

  test('each shipped game names an adapter', () => {
    expect(catalog.games.find(game => game.id === 'geometry-dash')?.adapterId).toBe('geode-geometry-dash');
    expect(catalog.games.find(game => game.id === 'genshin-impact')?.adapterId).toBe('genshin-impact-os');
    expect(catalog.games.find(game => game.id === 'minecraft')?.adapterId).toBe('minecraft-os');
  });

  test('matches the longest window hint', () => {
    expect(matchGame(catalog, 'Genshin Impact')?.id).toBe('genshin-impact');
    expect(matchGame(catalog, 'Minecraft 1.21')?.id).toBe('minecraft');
    expect(matchGame(catalog, 'Geometry Dash')?.id).toBe('geometry-dash');
    expect(matchGame(catalog, 'screen')).toBeUndefined();
  });

  test('routes a mod only for a catalog game that names one', () => {
    expect(adapterIdForTarget(catalog, 'Geometry Dash', false)).toBe('geode-geometry-dash');
    expect(adapterIdForTarget(catalog, 'Genshin Impact', false)).toBe('genshin-impact-os');
    expect(adapterIdForTarget(catalog, 'Minecraft', false)).toBe('minecraft-os');
    expect(adapterIdForTarget(catalog, 'Notepad', true)).toBeNull();
    expect(adapterIdForTarget(catalog, 'screen', true)).toBe('geode-geometry-dash');
    expect(adapterIdForTarget(catalog, 'screen', false)).toBeNull();
  });

  test('rejects a catalog with a duplicate id', () => {
    expect(() =>
      parseGameCatalog({
        version: 1,
        games: [
          {
            id: 'same',
            name: 'A',
            summary: '',
            windowHints: ['a'],
            inputs: ['mouse'],
          },
          {
            id: 'same',
            name: 'B',
            summary: '',
            windowHints: ['b'],
            inputs: ['keyboard'],
          },
        ],
      })
    ).toThrow('game_catalog_duplicate_id');
  });
});
