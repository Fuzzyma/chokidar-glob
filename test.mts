// Tests taken from chokidar 3.6.0 (https://github.com/paulmillr/chokidar/blob/3.6.0/test.js)
import * as chai from 'chai';
import fs from 'node:fs';
import sysPath from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rimraf } from 'rimraf';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import upath from 'upath';

import chokidar, { ChokidarGlobOptions } from './esm/index.js';

import { EVENTS as EV, isIBMi, isMacos, isWindows } from 'chokidar/handler.js';

import { URL } from 'url'; // in Browser, the URL in native accessible on window
import { FSWatcher } from 'chokidar';
import globParent from 'glob-parent';

const __filename = fileURLToPath(new URL('', import.meta.url));
// Will contain trailing slash
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const { expect } = chai;
chai.use(sinonChai);
chai.should();

const write = promisify(fs.writeFile);
const fs_mkdir = promisify(fs.mkdir);
const fs_unlink = promisify(fs.unlink);

const FIXTURES_PATH_REL = 'test-fixtures';
const FIXTURES_PATH = sysPath.join(__dirname, FIXTURES_PATH_REL);
const allWatchers: FSWatcher[] = [];
const PERM_ARR = 0o755; // rwe, r+e, r+e
let subdirId = 0;
let options;
let currentDir;
let slowerDelay;

// spyOnReady
const aspy = (watcher: FSWatcher, eventName: (typeof EV)[keyof typeof EV]) => {
  if (typeof eventName !== 'string') {
    throw new TypeError('aspy: eventName must be a String');
  }
  const spy = sinon.spy();
  return new Promise<sinon.SinonSpy<any[], any>>((resolve, reject) => {
    watcher.on(EV.ERROR, reject);
    watcher.on(EV.READY, () => resolve(spy));
    watcher.on(eventName, spy);
  });
};

const delay = async (time?: number) => {
  return new Promise((resolve) => {
    const timer = time || slowerDelay || 20;
    setTimeout(resolve, timer);
  });
};

const getFixturePath = (subPath: string) => {
  const subd = (subdirId && subdirId.toString()) || '';
  return sysPath.join(FIXTURES_PATH, subd, subPath);
};
const getGlobPath = (subPath: string) => {
  const subd = (subdirId && subdirId.toString()) || '';
  return upath.join(FIXTURES_PATH, subd, subPath);
};
currentDir = getFixturePath('');

const chokidar_watch = (path = currentDir, opts = options) => {
  const wt = chokidar.watch(path, opts);
  allWatchers.push(wt);
  return wt;
};

const waitFor = async (spies) => {
  if (spies.length === 0) throw new TypeError('SPies zero');
  return new Promise<void>((resolve) => {
    const isSpyReady = (spy) => {
      if (Array.isArray(spy)) {
        return spy[0].callCount >= spy[1];
      }
      return spy.callCount >= 1;
    };
    let intrvl, timeo;
    function finish() {
      clearInterval(intrvl);
      clearTimeout(timeo);
      resolve();
    }
    intrvl = setInterval(() => {
      process.nextTick(() => {
        if (spies.every(isSpyReady)) finish();
      });
    }, 20);
    timeo = setTimeout(finish, 5000);
  });
};

const dateNow = () => Date.now().toString();

const runTests = (baseopts: { usePolling: boolean; persistent?: boolean; interval?: number }) => {
  let macosFswatch: boolean;
  let win32Polling: boolean;
  let options: ChokidarGlobOptions;

  baseopts.persistent = true;

  before(() => {
    // flags for bypassing special-case test failures on CI
    macosFswatch = isMacos && !baseopts.usePolling;
    win32Polling = isWindows && baseopts.usePolling;
    slowerDelay = macosFswatch ? 100 : undefined;
  });

  beforeEach(function clean() {
    options = {};
    Object.keys(baseopts).forEach((key) => {
      options[key] = baseopts[key];
    });
  });

  describe('watch glob patterns', () => {
    it('should correctly watch and emit based on glob input', async () => {
      const watchPath = getGlobPath('*a*.txt');
      const addPath = getFixturePath('add.txt');
      const changePath = getFixturePath('change.txt');
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, changePath);

      await write(addPath, dateNow());
      await write(changePath, dateNow());

      await delay();
      await waitFor([[spy, 3], spy.withArgs(EV.ADD, addPath)]);
      spy.should.have.been.calledWith(EV.ADD, addPath);
      spy.should.have.been.calledWith(EV.CHANGE, changePath);
      spy.should.not.have.been.calledWith(EV.ADD, getFixturePath('unlink.txt'));
      // spy.should.not.have.been.calledWith(EV.ADD_DIR);
    });

    it('should respect negated glob patterns', async () => {
      const watchPath = getGlobPath('*');
      const negatedWatchPath = `!${getGlobPath('*a*.txt')}`;
      const unlinkPath = getFixturePath('unlink.txt');
      const watcher = chokidar_watch([watchPath, negatedWatchPath], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(EV.ADD, unlinkPath);

      await delay();
      await fs_unlink(unlinkPath);
      await waitFor([[spy, 2], spy.withArgs(EV.UNLINK)]);
      spy.should.have.been.calledTwice;
      spy.should.have.been.calledWith(EV.UNLINK, unlinkPath);
    });
    it('should respect negated glob patterns 2', async () => {
      const watchPath = getGlobPath('*');

      const negatedWatchPath = `${getGlobPath('!*a*.txt')}`;

      const unlinkPath = getFixturePath('unlink.txt');
      const changePath = getFixturePath('change.txt');
      const watcher = chokidar_watch([watchPath, negatedWatchPath], options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledTwice;
      spy.should.have.been.calledWith(EV.ADD, unlinkPath);
      spy.should.have.been.calledWith(EV.ADD, changePath);
      // spy.should.have.been.calledWith(EV.ADD_DIR, parent);

      await delay();
      await fs_unlink(unlinkPath);
      await waitFor([[spy, 2], spy.withArgs(EV.UNLINK)]);

      spy.should.have.been.calledThrice;
      spy.should.have.been.calledWith(EV.UNLINK, unlinkPath);
    });
    it('should traverse subdirs to match globstar patterns', async () => {
      const watchPath = getGlobPath(`../../test-*/${subdirId}/**/a*.txt`);
      const addFile = getFixturePath('add.txt');
      const subdir = getFixturePath('subdir');
      const subsubdir = getFixturePath('subdir/subsub');
      const aFile = getFixturePath('subdir/a.txt');
      const bFile = getFixturePath('subdir/b.txt');
      const subFile = getFixturePath('subdir/subsub/ab.txt');
      fs.mkdirSync(subdir, PERM_ARR);
      fs.mkdirSync(subsubdir, PERM_ARR);
      fs.writeFileSync(aFile, 'b');
      fs.writeFileSync(bFile, 'b');
      fs.writeFileSync(subFile, 'b');

      await delay();
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);
      await Promise.all([
        write(addFile, dateNow()),
        write(subFile, dateNow()),
        fs_unlink(aFile),
        fs_unlink(bFile),
      ]);

      await waitFor([spy.withArgs(EV.CHANGE)]);

      spy.withArgs(EV.CHANGE).should.have.been.calledOnce;
      spy.should.have.been.calledWith(EV.CHANGE, subFile);

      await waitFor([spy.withArgs(EV.UNLINK)]);
      spy.withArgs(EV.UNLINK).should.have.been.calledOnce;
      spy.should.have.been.calledWith(EV.UNLINK, aFile);

      await waitFor([[spy.withArgs(EV.ADD), 3]]);
      spy.withArgs(EV.ADD).should.have.been.calledThrice;
    });
    it('should resolve relative paths with glob patterns', async () => {
      const id = subdirId.toString();
      const watchPath = `test-*/${id}/*a*.txt`;
      // getFixturePath() returns absolute paths, so use sysPath.join() instead
      const addPath = sysPath.join(FIXTURES_PATH_REL, id, 'add.txt');
      const changePath = sysPath.join(FIXTURES_PATH_REL, id, 'change.txt');
      const unlinkPath = getFixturePath('unlink.txt');
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD);
      await Promise.all([write(addPath, dateNow()), write(changePath, dateNow())]);
      await waitFor([[spy, 3], spy.withArgs(EV.ADD, addPath)]);

      spy.should.have.been.calledWith(EV.ADD, addPath);
      spy.should.have.been.calledWith(EV.CHANGE, changePath);
      spy.should.not.have.been.calledWith(EV.ADD, unlinkPath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR);

      if (!macosFswatch) spy.should.have.been.calledThrice;
    });
    it('should correctly handle conflicting glob patterns', async () => {
      const changePath = getFixturePath('change.txt');
      const unlinkPath = getFixturePath('unlink.txt');
      const addPath = getFixturePath('add.txt');
      const watchPaths = [getGlobPath('change*'), getGlobPath('unlink*')];
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, changePath);
      spy.should.have.been.calledWith(EV.ADD, unlinkPath);
      spy.should.have.been.calledTwice;

      await delay();
      await fs_unlink(unlinkPath);
      await write(addPath, dateNow());
      await write(changePath, dateNow());

      await waitFor([[spy, 4], spy.withArgs(EV.UNLINK, unlinkPath)]);
      spy.should.have.been.calledWith(EV.CHANGE, changePath);
      spy.should.have.been.calledWith(EV.UNLINK, unlinkPath);
      spy.should.not.have.been.calledWith(EV.ADD, addPath);
      spy.callCount.should.equal(4);
    });
    it('should correctly handle intersecting glob patterns', async () => {
      const changePath = getFixturePath('change.txt');
      const watchPaths = [getGlobPath('cha*'), getGlobPath('*nge.*')];
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, changePath);
      spy.should.have.been.calledOnce;

      await write(changePath, dateNow());
      await delay();
      await waitFor([[spy, 2]]);
      spy.should.have.been.calledWith(EV.CHANGE, changePath);
      spy.should.have.been.calledTwice;
    });
    it('should not confuse glob-like filenames with globs', async () => {
      const filePath = getFixturePath('nota[glob].txt');
      await write(filePath, 'b');
      await delay();
      const spy = await aspy(chokidar_watch(), EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, filePath);

      await delay();
      await write(filePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should treat glob-like directory names as literal directory names when globbing is disabled', async () => {
      options.disableGlobbing = true;
      const filePath = getFixturePath('nota[glob]/a.txt');
      const watchPath = getFixturePath('nota[glob]');
      const testDir = getFixturePath('nota[glob]');
      const matchingDir = getFixturePath('notag');
      const matchingFile = getFixturePath('notag/b.txt');
      const matchingFile2 = getFixturePath('notal');
      fs.mkdirSync(testDir, PERM_ARR);
      fs.writeFileSync(filePath, 'b');
      fs.mkdirSync(matchingDir, PERM_ARR);
      fs.writeFileSync(matchingFile, 'c');
      fs.writeFileSync(matchingFile2, 'd');
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, filePath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, matchingDir);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile2);
      await delay();
      await write(filePath, dateNow());

      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should treat glob-like filenames as literal filenames when globbing is disabled', async () => {
      options.disableGlobbing = true;
      const filePath = getFixturePath('nota[glob]');
      // This isn't using getGlobPath because it isn't treated as a glob
      const watchPath = getFixturePath('nota[glob]');
      const matchingDir = getFixturePath('notag');
      const matchingFile = getFixturePath('notag/a.txt');
      const matchingFile2 = getFixturePath('notal');
      fs.writeFileSync(filePath, 'b');
      fs.mkdirSync(matchingDir, PERM_ARR);
      fs.writeFileSync(matchingFile, 'c');
      fs.writeFileSync(matchingFile2, 'd');
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, filePath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, matchingDir);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile2);
      await delay();
      await write(filePath, dateNow());

      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should not prematurely filter dirs against complex globstar patterns', async () => {
      const deepFile = getFixturePath('subdir/subsub/subsubsub/a.txt');
      const watchPath = getGlobPath(`../../test-*/${subdirId}/**/subsubsub/*.txt`);
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub/subsubsub'), PERM_ARR);
      fs.writeFileSync(deepFile, 'b');
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await delay();
      await write(deepFile, dateNow());
      await waitFor([[spy, 2]]);
      spy.should.have.been.calledWith(EV.ADD, deepFile);
      spy.should.have.been.calledWith(EV.CHANGE, deepFile);
    });
    it('should emit matching dir events', async () => {
      // test with and without globstar matches
      const watchPaths = [getGlobPath('*'), getGlobPath('subdir/subsub/**/*')];
      const deepDir = getFixturePath('subdir/subsub/subsubsub');
      const deepFile = sysPath.join(deepDir, 'a.txt');
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      const watcher = chokidar_watch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);

      await waitFor([spy.withArgs(EV.ADD_DIR)]);
      spy.should.have.been.calledWith(EV.ADD_DIR, getFixturePath('subdir'));
      spy.withArgs(EV.ADD_DIR).should.have.been.calledOnce;
      fs.mkdirSync(deepDir, PERM_ARR);
      fs.writeFileSync(deepFile, dateNow());

      await waitFor([[spy.withArgs(EV.ADD_DIR), 2], spy.withArgs(EV.ADD, deepFile)]);
      if (win32Polling) return;

      spy.should.have.been.calledWith(EV.ADD_DIR, deepDir);
      fs.unlinkSync(deepFile);
      fs.rmdirSync(deepDir);

      await waitFor([spy.withArgs(EV.UNLINK_DIR)]);
      spy.should.have.been.calledWith(EV.UNLINK_DIR, deepDir);
    });
    it('should correctly handle glob with braces', async () => {
      const watchPath = upath.normalizeSafe(
        getGlobPath('{subdir/*,subdir1/subsub1}/subsubsub/*.txt')
      );
      const deepFileA = getFixturePath('subdir/subsub/subsubsub/a.txt');
      const deepFileB = getFixturePath('subdir1/subsub1/subsubsub/a.txt');
      fs.mkdirSync(getFixturePath('subdir'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir/subsub/subsubsub'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir1'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir1/subsub1'), PERM_ARR);
      fs.mkdirSync(getFixturePath('subdir1/subsub1/subsubsub'), PERM_ARR);
      fs.writeFileSync(deepFileA, dateNow());
      fs.writeFileSync(deepFileB, dateNow());
      const watcher = chokidar_watch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, deepFileA);
      spy.should.have.been.calledWith(EV.ADD, deepFileB);
      fs.appendFileSync(deepFileA, dateNow());
      fs.appendFileSync(deepFileB, dateNow());

      await waitFor([[spy, 4]]);
      spy.should.have.been.calledWith(EV.CHANGE, deepFileA);
      spy.should.have.been.calledWith(EV.CHANGE, deepFileB);
    });
  });

  describe('watch arrays of paths/globs', () => {
    it('should watch all paths in an array', async () => {
      const testPath = getFixturePath('change.txt');
      const testDir = getFixturePath('subdir');
      fs.mkdirSync(testDir);
      const watcher = chokidar_watch([testDir, testPath], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, getFixturePath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should accommodate nested arrays in input', async () => {
      const testPath = getFixturePath('change.txt');
      const testDir = getFixturePath('subdir');
      await fs_mkdir(testDir);
      const watcher = chokidar_watch([[testDir], [testPath]], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, getFixturePath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should throw if provided any non-string paths', () => {
      expect(chokidar_watch.bind(null, [[currentDir], /notastring/])).to.throw(
        TypeError,
        /non-string/i
      );
    });
  });
};

describe('chokidar', async () => {
  before(async () => {
    await rimraf(FIXTURES_PATH);
    const _content = fs.readFileSync(__filename, 'utf-8');
    const _only = _content.match(/\sit\.only\(/g);
    const itCount = (_only && _only.length) || _content.match(/\sit\(/g)!.length;
    const testCount = itCount * 3;
    fs.mkdirSync(currentDir, PERM_ARR);
    while (subdirId++ < testCount) {
      currentDir = getFixturePath('');
      fs.mkdirSync(currentDir, PERM_ARR);
      fs.writeFileSync(sysPath.join(currentDir, 'change.txt'), 'b');
      fs.writeFileSync(sysPath.join(currentDir, 'unlink.txt'), 'b');
    }
    subdirId = 0;
  });

  after(async () => {
    await rimraf(FIXTURES_PATH);
  });

  beforeEach(() => {
    subdirId++;
    currentDir = getFixturePath('');
  });

  afterEach(async () => {
    let watcher;
    while ((watcher = allWatchers.pop())) {
      await watcher.close();
    }
  });

  it('should expose public API methods', () => {
    chokidar.watch.should.be.a('function');
  });

  if (!isIBMi) {
    describe('fs.watch (non-polling)', runTests.bind(this, { usePolling: false }));
  }
  describe('fs.watchFile (polling)', runTests.bind(this, { usePolling: true, interval: 10 }));
});
