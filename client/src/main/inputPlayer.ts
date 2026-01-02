type MouseButton = 'left' | 'right' | 'middle';

export class InputPlayer {
  private robot: any;

  constructor(robotInstance?: any) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    this.robot = robotInstance || require('robotjs');
  }

  public moveMouse(x: number, y: number) {
    this.robot.moveMouse(Math.round(x), Math.round(y));
  }

  public mouseDown(button: MouseButton) {
    this.robot.mouseToggle('down', button);
  }

  public mouseUp(button: MouseButton) {
    this.robot.mouseToggle('up', button);
  }

  public async clickWithDuration(button: MouseButton, durationMs: number) {
    this.mouseDown(button);
    if (durationMs > 0) {
      await new Promise(resolve => setTimeout(resolve, durationMs));
    }
    this.mouseUp(button);
  }

  public keyDown(key: string) {
    this.robot.keyToggle(key, 'down');
  }

  public keyUp(key: string) {
    this.robot.keyToggle(key, 'up');
  }

  public keyTap(key: string) {
    this.robot.keyTap(key);
  }
}
