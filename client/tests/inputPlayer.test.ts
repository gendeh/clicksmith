import { InputPlayer } from '../src/main/inputPlayer';

jest.mock('robotjs', () => {
  throw new Error('The module was compiled against a different Node.js version');
});

test('a mouse click uses point coordinates when robotjs cannot load', () => {
  const calls: string[][] = [];
  const player = new InputPlayer(undefined, (args) => {
    calls.push(args);
    return '';
  });

  player.moveMouse(196.4, 168.2);
  player.mouseDown('left');
  player.mouseUp('left');

  expect(calls).toEqual([
    ['move', '196', '168'],
    ['down', 'left'],
    ['up', 'left'],
  ]);
});

test('a provided robot still receives the click', () => {
  const calls: string[][] = [];
  const robot = {
    moveMouse: (x: number, y: number) => calls.push(['robot-move', String(x), String(y)]),
    mouseToggle: (state: string, button: string) => calls.push(['robot', state, button]),
  };
  const player = new InputPlayer(robot, () => {
    throw new Error('mac mouse should not run');
  });

  player.moveMouse(10, 20);
  player.mouseDown('right');

  expect(calls).toEqual([
    ['robot-move', '10', '20'],
    ['robot', 'down', 'right'],
  ]);
});
