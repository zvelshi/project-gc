/*
* File Name: main.js
* Author: Zac Velshi
* Date Created: 2023-06-08
* Last Modified: 2023-07-08
* Purpose: This file interacts with remote databases and AWS file storage solutions to carry out the logic commands to sync and interface a local directory with a remote directory
*/

// electron app main process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

// aws sdk: s3 and dynabodb
const { s3 } = require('./s3_client.js');
const { dbdoc } = require('./db_client.js');

// uuid: unique id generator, crypto: hashing
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// path,  fs, chokidar: file system
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

// s3 client api commands
const {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

// dynamodb client api commands
const { 
  PutCommand, 
  GetCommand, 
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');

// electron-reload instance auto reloads
require('electron-reload')(__dirname, {
  electron: require(`${__dirname}/node_modules/electron`),
});

// electron-store instance for local storage
const Store = require('electron-store');
const store = new Store();

// electron main window instance
let mainWindow;

// ------------------- Start of mainWindow code -------------------

const createWindow = () => {

  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    //autoHideMenuBar: true,
    icon: __dirname + '/no_gc.ico',
  });

  mainWindow.loadFile('index.html');

  ipcMain.handle('open-folder-dialog', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });

    if (!result.canceled) {
      return result.filePaths[0];
    } else {
      return null;
    }
  });

  ipcMain.on('create-repo', async (event, repoData) => {

    const { folderPath, friendlyName, organization } = repoData;  

    const uniqueName = uuidv4();

    store.set(uniqueName, {
      friendlyName,
      organization,
      folderPath
    });

    try {
      await dbdoc.send(new PutCommand({ 
        TableName: 'repositories',
        Item: {
          id: uniqueName,
          friendlyName,
          organization,
        }
      }));
    } catch (err) {
      console.log(err);
    }

    const s3Params = {
      Bucket: uniqueName,
      ACL: 'private'
    };

    try {
      await s3.send(new CreateBucketCommand(s3Params));
    } catch (err) {
      console.log(err);
    }

    fs.mkdirSync(folderPath);    

    store.set('activeRepo', uniqueName);
  });

  ipcMain.handle('get-active-repo-cloud', async (event) => {
    return await getActiveRepoCloud();
  });
  
  ipcMain.handle('get-active-repo-local', async (event) => {
    return await getActiveRepoLocal();
  });

  ipcMain.handle('set-active-repo', async (event, uniqueName) => {
    store.set('activeRepo', uniqueName);
  });

  ipcMain.handle('get-local-repos', async (event) => {
    return await getLocalRepos();
  });

  ipcMain.handle('get-cloud-repos', async (event) => {
    return await getCloudRepos();
  });

  ipcMain.handle('clone-repo', async (event, repoUniqueName, folderPathWithoutFName) => {

    const res = await dbdoc.send(new GetCommand({
      TableName: 'repositories',
      Key: {
        id: repoUniqueName,
      }
    }));

    const repoData = {
      uniqueName: repoUniqueName,
      friendlyName: res.Item.friendlyName,
      organization: res.Item.organization,
      folderPath: folderPathWithoutFName
    }

    store.set(repoUniqueName, {
      friendlyName: repoData.friendlyName,
      organization: repoData.organization,
      folderPath: repoData.folderPath + '/' + repoData.friendlyName
    });

    const hierarchy = await getBucketHierarchy(repoData.uniqueName);
    await cloneCloudRepo(hierarchy, repoData.folderPath, repoData.uniqueName);

    store.set('activeRepo', repoUniqueName);

    await alertDialog('Clone Complete', 'The repository has been cloned successfully.', ['OK']);
  });

  ipcMain.handle('pull-repo', async (event) => {

    const activeRepo = await getActiveRepoLocal();

    const hierarchy = await getBucketHierarchy(activeRepo.uniqueName);

    const folderPath = activeRepo.folderPath.slice(0, activeRepo.folderPath.lastIndexOf('\\'));

    await pullCloudRepo(hierarchy, folderPath, activeRepo.uniqueName);

    await alertDialog('Pull Complete', 'The repository has been pulled successfully.', ['OK']);
  });

  ipcMain.handle('clone-local-repo', async (event, repoData) => {

    const uniqueName = uuidv4();

    store.set(uniqueName, {
      friendlyName: repoData.friendlyName,
      organization: repoData.organization,
      folderPath: repoData.folderPath
    });

    store.set('activeRepo', uniqueName);

    try {
      await dbdoc.send(new PutCommand({ 
        TableName: 'repositories',
        Item: {
          id: uniqueName,
          friendlyName: repoData.friendlyName,
          organization: repoData.organization,
        }
      }));
    } catch (err) {
      console.log(err);
    } 

    const s3Params = {
      Bucket: uniqueName,
      ACL: 'private'
    };

    try {
      await s3.send(new CreateBucketCommand(s3Params));
    } catch (err) {
      console.log(err);
    }

    await cloneLocalRepo(uniqueName, repoData.folderPath);

    await alertDialog('Clone Complete', 'The repository has been cloned successfully.', ['OK']);
  });

  ipcMain.handle('listen-for-changes', async (event, watcher, folderPath) => {
    if (watcher){
      watcher.close();
    }

    watcher = chokidar.watch(folderPath, {
      ignoreInitial: true,
      persistent: true,
      usePolling: false,
    });
    
    watcher.on('all' , async (event, path) => {
      handleFileChange(event, filePath);
    });

    sendInitialLocalChanges();    
  });
};

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  })
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

//-------------------end of mainWindow code----------------------

//-------------------start of helper functions-------------------

async function cloneLocalRepo(uniqueName, folderPath) {

  const files = await fs.promises.readdir(folderPath, { withFileTypes: true });

  for (const file of files) {

    const filePath = path.join(folderPath, file.name);

    if (file.isDirectory()) {

      const folderKey = file.name + '/';
      await s3.send(new PutObjectCommand({
        Bucket: uniqueName,
        Key: folderKey,
      }));

      await cloneLocalRepo(uniqueName, filePath);

    } else {

      const fileContentStream = fs.createReadStream(filePath);
      await s3.send(new PutObjectCommand({
        Bucket: uniqueName,
        Key: file.name,
        Body: fileContentStream,
      }));
    }
  }
}

async function pullCloudRepo(hierarchy, folderPath, bucketName) {

  const destinationPath = path.join(folderPath, hierarchy.name);

  if (hierarchy.type === 'file') {
    const localFilePath = destinationPath;

    const isModified = await isFileModified(bucketName, hierarchy.path, localFilePath);

    if (isModified) {
      const parentDir = path.dirname(localFilePath);
      await fs.promises.mkdir(parentDir, { recursive: true });
      await getFileContentFromS3(hierarchy.path, localFilePath, bucketName);
    }

  } else if (hierarchy.type === 'folder') {
    if (!fs.existsSync(destinationPath)) {

      await fs.promises.mkdir(destinationPath, { recursive: true });
    }

    for (const child of hierarchy.children) {
      await pullCloudRepo(child, destinationPath, bucketName);
    }
  }
}

async function isFileModified(bucketName, filePath, localFilePath) {

  if (!fs.existsSync(localFilePath)) {
    return true;
  }

  const remoteHash = await calculateCloudFileHash(bucketName, filePath);

  const localHash = await calculateLocalFileHash(localFilePath);

  return remoteHash !== localHash;
}

async function calculateCloudFileHash(bucketName, filePath) {

  const params = {
    Bucket: bucketName,
    Key: filePath,
  };

  try {
    const data = await s3.send(new GetObjectCommand(params));
    const stream = data.Body;

    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => reject(err));
    });
  } catch (err) {
    console.error('Error calculating file hash:', err);
    return null;
  }
}

async function calculateLocalFileHash(filePath) {

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

async function cloneCloudRepo(hierarchy, folderPath, bucketName) {
  const destinationPath = path.join(folderPath, hierarchy.name);

  if (hierarchy.type === 'file') {

    if (!fs.existsSync(destinationPath)) {
      const localFilePath = await getFileContentFromS3(hierarchy.path, destinationPath, bucketName);

      const parentDir = path.dirname(localFilePath);
      await fs.promises.mkdir(parentDir, { recursive: true });
    }
  } else if (hierarchy.type === 'folder') {

    if (!fs.existsSync(destinationPath)) {
      await fs.promises.mkdir(destinationPath, { recursive: true });
    }

    for (const child of hierarchy.children) {
      await cloneCloudRepo(child, destinationPath, bucketName);
    }
  }
}

async function getFileContentFromS3(filePath, localFilePath, bucketName) {
  const params = {
    Bucket: bucketName,
    Key: filePath,
  };

  try {
    const data = await s3.send(new GetObjectCommand(params));
    const stream = data.Body;

    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(localFilePath);
      stream.pipe(fileStream);

      stream.on('end', resolve);
      stream.on('error', reject);
    });

    return localFilePath;
  } catch (err) {
    console.error('Error getting file content from S3:', err);
    return null;
  }  
}

async function getBucketHierarchy(bucketName) {

  const res = await s3.send(new ListObjectsV2Command ({ 
    Bucket: bucketName 
  }));
  const contents = res.Contents;

  const friendlyName = store.get(bucketName).friendlyName;

  const hierarchy = {
    name: friendlyName,
    path: '',
    type: 'folder',
    isModified: false,
    children: [],
  };

  for (const content of contents) {
    const key = content.Key;

    const parts = key.split('/');

    let currentFolder = hierarchy;
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];

      let childFolder = currentFolder.children.find((child) => child.name === folderName);
      if (!childFolder) {

        childFolder = {
          name: folderName,
          path: parts.slice(0, i + 1).join('/'),
          type: 'folder',
          isModified: false,
          children: [],
        };

        currentFolder.children.push(childFolder);
      }

      currentFolder = childFolder;
    }

    const fileName = parts[parts.length - 1];
    const file = {
      name: fileName,
      path: key,
      type: 'file',
      isModified: false,
    };

    currentFolder.children.push(file);
  }

  return hierarchy;
}

async function getActiveRepoCloud(){

  const activeRepo = store.get('activeRepo');

  if (activeRepo) {
    const res = await dbdoc.send(new GetCommand({
      TableName: 'repositories',
      Key: {
        id: activeRepo,
      }
    }));

    return res.Item;
  } else {
    return null;
  }
}

async function getLocalRepos(){
  const localRepos = [];

  const config = store.store;

  for (const key in config) {
    let obj = { uniqueName: '', friendlyName: '', organization: '', folderPath: '' };
    if (key !== 'activeRepo') {
      obj.uniqueName = key;
      obj.friendlyName = config[key].friendlyName;
      obj.organization = config[key].organization;
      obj.folderPath = config[key].folderPath;
      localRepos.push(obj);        
    }
  }

  return localRepos;
}

async function getCloudRepos(){
  const res = await dbdoc.send(new ScanCommand({
    TableName: 'repositories',
  }));
  return res.Items;
}

async function getActiveRepoLocal(){

  const activeRepo = store.get('activeRepo');

  const localRepos = await getLocalRepos();

  for (let i = 0; i < localRepos.length; i++){
    if (localRepos[i].uniqueName === activeRepo){

      return localRepos[i];
    }
  }
  return null;
}

async function alertDialog(title, message, buttons){
  const options = {
    type: 'info',
    title: title,
    message: message,
    buttons: buttons
  };
  dialog.showMessageBoxSync(null, options);
}

//-------------------end of helper functions-------------------