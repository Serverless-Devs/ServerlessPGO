import { platform, tmpdir, homedir } from 'os';
import { dirname, join, relative } from 'path';
import {
  ensureDir,
  lstat,
  readlink,
  createReadStream,
  createWriteStream,
  writeFile,
  existsSync,
  readFile,
  readFileSync,
  remove,
  copySync, copy, removeSync
} from 'fs-extra';

import * as globby from 'globby';
import * as JSZip from 'jszip';
import * as FCClientInner from '@alicloud/fc2';
import * as YAML from 'js-yaml';
import * as uuid from 'uuid-1345';
import * as tar from 'tar';
import * as child_process from 'child_process'
import {error, info, NAS, OSS} from "./common";
import * as path from "path";
import * as OSSClient from 'ali-oss';
import got from 'got';
import {promisify} from "util";
import * as stream from "stream";
import * as fs from "fs";

const Crypto = require('crypto-js');
const ServerlessDevsEncryptKey = 'SecretKey123';

const TMP_PATH = '/tmp';
const SRCTL = 'srctl';
const SRPATH = `${TMP_PATH}/${SRCTL}`;
const ARCHIVE_NAME = `${SRCTL}.tar.gz`;
const ARCHIVE_PATH = `${TMP_PATH}/${ARCHIVE_NAME}`;
const TEMP_FUNCTION_HANDLER = 'AccelerationHelper::handleRequest';
const AccelerationHelperTargetPath = join('src', 'main', 'java', 'AccelerationHelper.java');
const AccelerationHelperSourcePath = join('..', 'resources', 'AccelerationHelper.java');
const nameBase = 'trace-dump';
const tmpName = `${nameBase}-tmp-${Date.now()}`;
const tmpDir = join(tmpdir(), tmpName);
const tmpZipFilePath = join(tmpdir(), `${tmpName}.zip`);
const OssUtil = "ossutil64";

export class JavaStartupAcceleration {
  region;
  fcEndpoint;
  runtime;
  initializer;
  access;
  pwd = process.cwd();
  defaultCredential;
  artifactPath;
  targetPath;
  role;
  logConfig;
  sharedDirName;
  srpath;
  downloader;
  uploader;
  ossEndpoint;
  ossUtilUrl;
  ossBucket;
  ossKey;
  vpcConfig;
  nasConfig;
  timeout;
  initTimeout;
  maxMemory;

  constructor(pwd: string, config) {
    const { region, fcEndpoint, access, runtime, initializer, credential, role, logConfig, sharedDirName, downloader,
      uploader, ossUtilUrl, ossBucket, ossKey, ossEndpoint, vpcConfig, nasConfig, srpath, maxMemory, timeout,
      initTimeout } = config;
    this.region = region;
    this.runtime = runtime;
    this.initializer = initializer;
    this.defaultCredential = credential;
    this.access = access;
    this.pwd = pwd;
    this.artifactPath = join(process.cwd(), 'target', 'artifact');
    this.targetPath = join(process.cwd(), 'target');
    this.role = role;
    this.logConfig = logConfig;
    this.fcEndpoint = fcEndpoint;
    this.sharedDirName = sharedDirName;
    this.srpath = join(TMP_PATH, sharedDirName);
    this.downloader = downloader;
    if (ossEndpoint) {
      this.ossEndpoint = ossEndpoint;
    } else {
      this.ossEndpoint = 'oss-${FC_REGION}-internal.aliyuncs.com'.replace('${FC_REGION}', this.region);
    }
    this.ossUtilUrl = ossUtilUrl;
    this.uploader = uploader;
    this.ossBucket = ossBucket;
    this.ossKey = ossKey;
    this.vpcConfig = vpcConfig;
    this.nasConfig = nasConfig;

    if (this.uploader == NAS) {
      this.srpath = srpath;
    } else {
      this.srpath = SRPATH;
    }
    this.maxMemory = maxMemory;
    this.timeout = timeout;
    this.initTimeout = initTimeout;
  }

  public async gen() {
    info("acceleration function shared dir: " + this.srpath);
    info("local temp dir: " + tmpDir);
    if (this.downloader == OSS) {
      info("oss endpoint: " + this.ossEndpoint)
    }
    await this.genDump();
    info("completed");
  }

  async genDump() {
    await ensureDir(tmpDir);
    const fcClient = await this.getFCClient();
    const tmpServiceName = `${nameBase}-service-${uuid.v1()}`;
    const tmpFunctionName = `${nameBase}-func-${uuid.v1()}`;

    try {
      /* prepare */
      await this.buildAndCopyFilesForHelperFunc(tmpDir);

      /* create zip file */
      await this.genZip(tmpDir, tmpZipFilePath);

      /* create service */
      await this.createTempService(fcClient, tmpServiceName);

      /* create function */
      await this.createTempFunction(fcClient, tmpServiceName, tmpFunctionName, tmpZipFilePath);

      /* create trigger */
      const tmpTriggerName = `${nameBase}-trigger-${uuid.v1()}`;
      await JavaStartupAcceleration.createTempTrigger(fcClient, tmpServiceName, tmpFunctionName, tmpTriggerName);

      /* generate acceleration files on server */
      await this.genAccelerationFiles(fcClient, tmpServiceName, tmpFunctionName);

      /* download acceleration files to local */
      if (this.uploader != NAS) {
        await this.downloadAccelerationFiles(fcClient, tmpServiceName, tmpFunctionName);
      }
      info('acceleration files generated successfully');

      await this.copyFunctionFiles(this.artifactPath, "user");

      if (this.uploader == OSS) {
        await this.createZipAndUploadToOSS();
      }
    } finally {
      /* delete local temp files */
      await remove(tmpDir);
      await remove(tmpZipFilePath);
      await this.removeJavaHelper();

      /* delete temp service and function */
      await this.clearTempObjects(fcClient, tmpServiceName);
      info("acceleration temp files and function deleted");
    }
  }

  private async genAccelerationFiles(fcClient, tmpServiceName: string, tmpFunctionName: string) {
    let archiveFile = ARCHIVE_PATH;

    if (this.uploader == NAS) {
      archiveFile = '';
      let command = 's nas command rm -rf ' + this.srpath;
      info("clear srctl path before invoking assistant function: [" + command + "]");
      child_process.execSync(command);
    }

    info("invoking assistant function to dump acceleration files");
    let body = 'srpath=' + this.srpath + ';type=dump;file=' + archiveFile + ";method=jcmd";
    let result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/action`, body, null);
    let data = result.data;
    info("server messages: " + data)
    if (data.indexOf("success") == 0) {
      info("dumped successfully")
    } else {
      throw new Error("dump encountered error");
    }
  }

  private async downloadAccelerationFiles(fcClient, tmpServiceName: string, tmpFunctionName: string) {
    let sharedDir = join(this.artifactPath, this.sharedDirName);
    await ensureDir(sharedDir);
    let localFile = join(sharedDir, ARCHIVE_NAME);
    if (this.downloader == OSS) {
      const {ak, secret } = await this.getConfig();
      await this.downloadByOSS(fcClient, tmpServiceName, tmpFunctionName, ak, secret, this.ossEndpoint, localFile);
    } else if (this.downloader == NAS) {
      await this.downloadByNAS(fcClient, tmpServiceName, tmpFunctionName, localFile);
    } else {
      await JavaStartupAcceleration.download(fcClient, tmpServiceName, tmpFunctionName, localFile);
    }

    await this.extractTar(sharedDir, localFile);
    removeSync(localFile);
  }

  private async createTempFunction(fcClient, tmpServiceName: string, tmpFunctionName: string, tmpZipFilePath: string) {
    await fcClient.createFunction(tmpServiceName, {
      code: {
        zipFile: readFileSync(tmpZipFilePath, 'base64'),
      },
      description: '',
      functionName: tmpFunctionName,
      handler: TEMP_FUNCTION_HANDLER,
      initializer: this.initializer,
      memorySize: this.maxMemory,
      runtime: this.runtime,
      timeout: this.timeout, // unit second
      initializationTimeout: this.initTimeout, // unit second
      environmentVariables: {
        DISABLE_JAVA11_QUICKSTART: 'true',
        BOOTSTRAP_WRAPPER: '/code/quickstart.sh',
        SRPATH: this.srpath
      }
    });
    info("assistant function created")
  }

  private static async createTempTrigger(fcClient, tmpServiceName: string, tmpFunctionName: string, tmpTriggerName: string) {
    await fcClient.createTrigger(tmpServiceName, tmpFunctionName, {
      invocationRole: '',
      qualifier: 'LATEST',
      sourceArn: 'test',
      triggerConfig: {authType: "anonymous", methods: ["POST"]},
      triggerName: tmpTriggerName,
      triggerType: 'http'
    });
    info("assistant trigger created")
  }

  private async createTempService(fcClient, tmpServiceName) {
    await fcClient.createService(tmpServiceName, {
      description: '用于 Alibaba Dragonwell Acceleration Cache 生成',
      serviceName: tmpServiceName,
      logConfig: this.logConfig,
      role: this.role,
      nasConfig: this.nasConfig,
      vpcConfig: this.vpcConfig,
    });
    info("assistant service created")
  }

  private async getFCClient() {
    const { accountId, ak, secret } = await this.getConfig();
    const fcClient = new FCClientInner(accountId, {
      region: this.region,
      endpoint: this.fcEndpoint,
      accessKeyID: ak,
      accessKeySecret: secret,
      timeout: this.timeout * 1000 // unit millisecond
    });
    return fcClient;
  }

  private async getOSSClient(bucketName: string) {
    const { ak, secret } = await this.getConfig();
    return new OSSClient({
      region: 'oss-' + this.region,
      accessKeyId: ak,
      accessKeySecret: secret,
      bucket: bucketName
    });
  }

  private async genZip(dir: string, zipFilePath: string) {
    await this.makeZip(dir, zipFilePath);
    info("zip file created");
  }

  private async createZipAndUploadToOSS() {
    const tmpZipFilePath = join(tmpdir(), this.ossKey);

    await this.genZip(this.artifactPath, tmpZipFilePath);

    try {
      let client = await this.getOSSClient(this.ossBucket);

      await client.put(this.ossKey, tmpZipFilePath);
      info('app zip file uploaded to oss');
    } catch (e) {
      error('oss operation error:' + e.message);
      throw e;
    }

    await remove(tmpZipFilePath);
  }

  private async buildAndCopyFilesForHelperFunc(tmpDir: string) {
    // copy source files
    await copy(join(__dirname, AccelerationHelperSourcePath), join(this.pwd, AccelerationHelperTargetPath));

    info('building... please wait');

    // compile
    let output = child_process.execSync('mvn clean compile -Dmaven.test.skip=true');
    info(output.toString());

    // download dependencies
    output = child_process.execSync('mvn -DoutputDirectory=' + join(this.targetPath, 'lib') + ' dependency:copy-dependencies');
    info(output.toString());

    // copy target files
    await this.copyFunctionFiles(tmpDir, "assistant");

    if (this.downloader == OSS) {
      let ossUtilPath = join(tmpDir, OssUtil);
      await this.downloadOssUtil(this.ossUtilUrl, ossUtilPath);
    }

    info('build finish');
  }

  private async copyFunctionFiles(toDir: string, funcType: string) {
    info("copying files for " + funcType + " function")

    await copy(join(__dirname, '..', 'resources', 'quickstart.sh'), join(toDir, 'quickstart.sh'));
    await copy(join(__dirname, '..', 'resources', 'classloader-config.xml'), join(toDir, 'sr', 'classloader-config.xml'));

    const fileList = await globby([join('target', '**')], {
      onlyFiles: false,
      followSymbolicLinks: false,
      cwd: this.pwd,
      ignore: [
        join("target", "artifact"),
        join("target", "sr"),
        join("target", "maven*", "**"),
        join("target", "dependency", "**"),
        join("target", "*sources*"),
        join("target", "*sources*", "**")
      ],
    });

    await Promise.all(fileList.map(file => {
      const filePath = join(this.pwd, file);
      if (file == join("target", "classes") || file == join("target", "lib")) {
        return
      }

      let targetPath = file.substring(file.indexOf(join("target", path.sep)) + join("target", path.sep).length);

      let c = join("classes", path.sep);
      if (filePath.indexOf(c) >= 0) {
        targetPath = targetPath.substring(targetPath.indexOf(c) + c.length);
      }

      targetPath = join(toDir, targetPath);

      return copySync(filePath, targetPath);
    }));
  }

  private async clearTempObjects(fcClient, tmpServiceName) {
    const { aliases } = (await fcClient.listAliases(tmpServiceName, { limit: 100 })).data;
    await Promise.all(aliases.map(alias => fcClient.deleteAlias(tmpServiceName, alias.aliasName)));

    const { versions } = (await fcClient.listVersions(tmpServiceName, { limit: 100 })).data;
    await Promise.all(versions.map(version => fcClient.deleteVersion(tmpServiceName, version.versionId)));

    const { functions } = (await fcClient.listFunctions(tmpServiceName, { limit: 100 })).data;

    for (const func of functions) {
      const { triggers } = (await fcClient.listTriggers(tmpServiceName, func.functionName, { limit: 100 })).data;
      await Promise.all(triggers.map(trigger => fcClient.deleteTrigger(tmpServiceName, func.functionName, trigger.triggerName)));
    }

    await Promise.all(functions.map(func => fcClient.deleteFunction(tmpServiceName, func.functionName)));

    await fcClient.deleteService(tmpServiceName);
  }

  private static async download(fcClient, tmpServiceName: string, tmpFunctionName: string, localFile: string) {
    let result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/action`, 'type=size;file=' + ARCHIVE_PATH, null);
    let data = result.data;
    const size = parseInt(data)
    info("archive file size: " + size);

    const partSize = 3 * 1024 * 1024;
    let buffer = Buffer.from('');
    let currentLen = 0;
    while(currentLen < size) {
      let curPartSize = size - currentLen;
      if (curPartSize > partSize) {
        curPartSize = partSize;
      }
      info('download archive start=' + currentLen + ';size=' + curPartSize + ';file=' + ARCHIVE_PATH);
      const result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/action`,
          'start=' + currentLen + ';size=' + curPartSize + ';file=' + ARCHIVE_PATH, null);
      data = result.data;
      const buf = Buffer.from(data, 'base64');
      buffer = Buffer.concat([buffer, buf]);
      currentLen += curPartSize;
    }

    await writeFile(localFile, buffer);
    return true;
  }

  private async downloadByOSS(fcClient, tmpServiceName: string, tmpFunctionName: string,
                              accessKeyId: string, accessKeySecret: string, endpoint: string, localFile: string) {
    const bucketName = `tmp-acceleration-${uuid.v1()}`;
    const payload =
        'type=ossUpload;' +
        'file=' + ARCHIVE_PATH + ';' +
        'accessKeyId=' + accessKeyId + ';' +
        'accessKeySecret=' + accessKeySecret + ';' +
        'endpoint=' + endpoint + ';' +
        'bucket=' + bucketName
    let result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/action`, payload, null);
    let data = result.data;
    info("oss upload result: " + data);

    if (data.indexOf('success') != 0) {
      throw new Error("upload acceleration file to oss error");
    }

    let client = await this.getOSSClient(bucketName);

    try {
      await client.get(ARCHIVE_NAME, localFile);
      info('oss file copied to local: ' + localFile);

      await client.delete(ARCHIVE_NAME);
      info('oss remote file [' + ARCHIVE_NAME + '] deleted');

      let list = await client.list();
      if (list.length > 0) {
        throw new Error('oss bucket [' + bucketName + '] is not empty');
      }

      await client.deleteBucket(bucketName);
      info('oss bucket [' + bucketName + '] deleted');
    } catch (e) {
      error('oss operation error:' + e.message);
      throw e;
    }
  }

  private async downloadByNAS(fcClient, tmpServiceName: string, tmpFunctionName: string, localFile: string) {
    let nasFilePath = join(this.nasConfig.mountPoints[0].mountDir, ARCHIVE_NAME);
    const payload = 'type=nasUpload;file=' + ARCHIVE_PATH + ';nasFilePath=' + nasFilePath;
    let result = await fcClient.post(`/proxy/${tmpServiceName}/${tmpFunctionName}/action`, payload, null);
    let data = result.data;
    info("nas upload result: " + data);

    if (data.indexOf('success') != 0) {
      throw new Error("upload acceleration file to nas error: " + data);
    }

    if (existsSync(localFile)) {
      info('before download from nas, remove existing file [' + localFile + ']')
      await remove(localFile);
    }

    let nasCmd = 's nas download ' + nasFilePath + ' ' + localFile;
    try {
      let output = child_process.execSync(nasCmd);
      info(output.toString());
    } catch (e) {
      error('nas operation error:' + e.message);
      throw e;
    }

    if (!existsSync(localFile)) {
      throw new Error('download nas file [' + nasFilePath + '] to local [' + localFile + '] encountered error');
    }

    info('download nas file [' + nasFilePath + '] to local [' + localFile + '] success');
  }

  private async removeJavaHelper() {
    // source files
    await remove(join(this.pwd, AccelerationHelperTargetPath));

    // class files
    const Path2 = 'AccelerationHelper.class';
    await remove(join(this.artifactPath, Path2));
  }

  private async extractTar(sharedDir: string, tarFile: string) {
    await tar.x({
      cwd: sharedDir,
      file: tarFile
    }).then(() => {
      info("the tar file has been extracted into: " + sharedDir);
    })
  }

  private async makeZip(sourceDirection: string, targetFileName: string) {
    let ignore = [];
    const fileList = await globby(['**'], {
      onlyFiles: false,
      followSymbolicLinks: false,
      cwd: sourceDirection,
      ignore,
    });
    const zip = new JSZip();
    const isWindows = platform() === 'win32';
    for (const fileName of fileList) {
      const absPath = join(sourceDirection, fileName);
      const stats = await lstat(absPath);
      if (stats.isDirectory()) {
        zip.folder(fileName);
      } else if (stats.isSymbolicLink()) {
        let link = await readlink(absPath);
        if (isWindows) {
          link = relative(dirname(absPath), link).replace(/\\/g, '/');
        }
        zip.file(fileName, link, {
          binary: false,
          createFolders: true,
          unixPermissions: stats.mode,
        });
      } else if (stats.isFile()) {
        zip.file(fileName, createReadStream(absPath), {
          binary: true,
          createFolders: true,
          unixPermissions: stats.mode,
        });
      }
    }
    await new Promise((res, rej) => {
      zip
        .generateNodeStream({ platform: 'UNIX' })
        .pipe(createWriteStream(targetFileName))
        .once('finish', res)
        .once('error', rej);
    });
  }

  async getConfig() {
    if (this.defaultCredential) {
      return this.defaultCredential;
    }
    const profDirPath = join(homedir(), '.s');
    const profPath = join(profDirPath, 'access.yaml');
    const isExists = existsSync(profPath);
    let accountId = '';
    let ak = '';
    let secret = '';
    if (isExists) {
      const yamlContent = await readFile(profPath, 'utf-8');
      const yaml: any = YAML.load(yamlContent);
      const config = yaml[this.access ||  Object.keys(yaml)[0]];
      accountId = this.serverlessDevsDecrypt(config.AccountID)
      ak =  this.serverlessDevsDecrypt(config.AccessKeyID);
      secret =  this.serverlessDevsDecrypt(config.AccessKeySecret);
    }

    return {
      accountId, ak, secret
    }
  }

  serverlessDevsDecrypt(value) {
    return Crypto.AES.decrypt(value, ServerlessDevsEncryptKey).toString(Crypto.enc.Utf8);
  }

  async downloadOssUtil(url: string, dest: string) {
    info("start to download [" + url + "]");
    if (existsSync(dest)) {
      info("old file [" + dest + "] deleted");
      await remove(dest);
    }

    await this.downloadUrl(url, dest);

    if (!existsSync(dest)) {
      throw new Error("file [" + dest + "] does not exist");
    }
  };

  async downloadUrl(url: string, dest: string) {
    const pipeline = promisify(stream.pipeline);
    await pipeline(
      got.stream(url),
      fs.createWriteStream(dest)
    ).then(() => {
      info("download [" + url + "] to [" + dest + "] completed");
    }).catch((err) => {
      removeSync(dest);
      error("download [" + url + "] encountered error: " + JSON.stringify(err));
    })
  }
}
