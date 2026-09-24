module.exports = {
  desktopCapturer: {
    getSources: async () => [],
  },
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1080 },
    }),
    getAllDisplays: () => [],
    getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1 }),
  },
  app: {
    getPath: (name) => `/tmp/clicksmith-test/${name}`,
    getVersion: () => '1.0.0-test',
  },
};
