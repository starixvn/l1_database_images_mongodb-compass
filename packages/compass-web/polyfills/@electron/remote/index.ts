// Simple electron/remote polyfill for compass-web
const app = {
  getName: () => 'Compass Web',
  getVersion: () => '1.46.8',
  getPath: () => '/',
};

const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: (window: any, options: any) =>
    Promise.resolve({
      canceled: false,
      filePath: options.defaultPath || 'download',
    }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
};

const getCurrentWindow = () => ({
  setTitle: () => {},
  focus: () => {},
  show: () => {},
  hide: () => {},
  minimize: () => {},
  maximize: () => {},
  restore: () => {},
  close: () => {},
});

export default { app, dialog, getCurrentWindow };
export { app, dialog, getCurrentWindow };
