const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const nodeFs = require('node:fs');

const started = require('electron-squirrel-startup');

if (started) {
  app.quit();
}

let mainWindow = null;

// 允许显示的文件格式
const allowedExtensions = ['.pdf', '.docx', '.xlsx', '.txt', '.csv', '.mp4'];

// config 设置
const configFolderName = 'user-config';
const configFileName = 'config.json';

// 保存当前正在监听的目录
const folderWatchers = new Map();

// 用来避免一次文件变化触发太多次刷新
let refreshTimer = null;

function getConfigFolderPath() {
  // 开发阶段：sample/user-config
  if (!app.isPackaged) {
    return path.join(process.cwd(), configFolderName);
  }

  // 打包后：exe 所在目录/user-config
  return path.join(path.dirname(app.getPath('exe')), configFolderName);
}

function getConfigFilePath() {
  return path.join(getConfigFolderPath(), configFileName);
}

function createDefaultConfig() {
  return {
    watchedFolders: [],
  };
}

async function ensureConfigFile() {
  const configFolderPath = getConfigFolderPath();
  const configFilePath = getConfigFilePath();

  await fs.mkdir(configFolderPath, {
    recursive: true,
  });

  try {
    await fs.access(configFilePath);
  } catch (error) {
    const defaultConfig = createDefaultConfig();
    const jsonText = JSON.stringify(defaultConfig, null, 2);

    await fs.writeFile(configFilePath, jsonText, 'utf-8');
  }
}

async function loadConfig() {
  const configFilePath = getConfigFilePath();

  await ensureConfigFile();

  try {
    const content = await fs.readFile(configFilePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    const defaultConfig = createDefaultConfig();
    await saveConfig(defaultConfig);
    return defaultConfig;
  }
}

async function saveConfig(config) {
  const configFolderPath = getConfigFolderPath();
  const configFilePath = getConfigFilePath();

  await fs.mkdir(configFolderPath, {
    recursive: true,
  });

  const jsonText = JSON.stringify(config, null, 2);

  await fs.writeFile(configFilePath, jsonText, 'utf-8');
}

async function addWatchedFolder(folderPath) {
  const config = await loadConfig();

  const normalizedFolderPath = path.resolve(folderPath);

  if (!config.watchedFolders.includes(normalizedFolderPath)) {
    config.watchedFolders.push(normalizedFolderPath);
  }

  await saveConfig(config);

  return config.watchedFolders;
}

async function getTargetFilesRecursive(folderPath) {
  const result = [];
  const rootFolder = path.resolve(folderPath);

  async function walk(currentFolder) {
    const entries = await fs.readdir(currentFolder, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentFolder, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!allowedExtensions.includes(extension)) {
        continue;
      }

      result.push({
        name: entry.name,
        fullPath,
        folderPath: currentFolder,
        rootFolder,
        relativePath: path.relative(rootFolder, fullPath),
        extension,
      });
    }
  }

  await walk(rootFolder);

  return result;
}

function sendFolderChangedToRenderer(changeInfo) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  // 防抖：500ms 内多次变化，只刷新一次
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    mainWindow.webContents.send('folder:changed', changeInfo);
  }, 500);
}

async function startWatchingFolder(folderPath) {
  const normalizedFolderPath = path.resolve(folderPath);

  if (folderWatchers.has(normalizedFolderPath)) {
    return true;
  }

  try {
    const stat = await fs.stat(normalizedFolderPath);

    if (!stat.isDirectory()) {
      return false;
    }

    const watcher = nodeFs.watch(
      normalizedFolderPath,
      {
        recursive: true,
      },
      (eventType, fileName) => {
        sendFolderChangedToRenderer({
          folderPath: normalizedFolderPath,
          eventType,
          fileName: fileName ? fileName.toString() : '',
        });
      }
    );

    watcher.on('error', (error) => {
      console.error('Watcher error:', error);
    });

    folderWatchers.set(normalizedFolderPath, watcher);

    console.log('Watching folder:', normalizedFolderPath);

    return true;
  } catch (error) {
    console.error('Failed to watch folder:', normalizedFolderPath, error);
    return false;
  }
}

async function startWatchingAllFolders() {
  const config = await loadConfig();

  const results = [];

  for (const folderPath of config.watchedFolders) {
    const success = await startWatchingFolder(folderPath);

    results.push({
      folderPath,
      success,
    });
  }

  return results;
}

function stopAllWatchers() {
  for (const watcher of folderWatchers.values()) {
    watcher.close();
  }

  folderWatchers.clear();
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
};

// 选择文件夹，并保存到 config.json
ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });

  if (result.canceled) {
    return null;
  }

  const selectedFolder = path.resolve(result.filePaths[0]);

  await addWatchedFolder(selectedFolder);

  // 选完新目录后，立刻开始监听它
  await startWatchingFolder(selectedFolder);

  return selectedFolder;
});

// 读取 config.json 里的监视文件夹列表
ipcMain.handle('config:get-watched-folders', async () => {
  const config = await loadConfig();
  return config.watchedFolders;
});

// 递归读取目标文件夹中的指定格式文件
ipcMain.handle('folder:get-files', async (event, folderPath) => {
  if (!folderPath) {
    return [];
  }

  try {
    const files = await getTargetFilesRecursive(folderPath);
    return files;
  } catch (error) {
    console.error('Failed to read folder:', error);
    return [];
  }
});

// 启动监听所有 config 里的目录
ipcMain.handle('watcher:start', async () => {
  const results = await startWatchingAllFolders();
  return results;
});

app.whenReady().then(async () => {
  await ensureConfigFile();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  stopAllWatchers();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});