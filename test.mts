// Tests mostly taken from chokidar 3.6.0 (https://github.com/paulmillr/chokidar/blob/3.6.0/test.js)
import * as fsp from 'node:fs/promises';
import { writeFile as write, readFile as read, rm } from 'node:fs/promises';
import sysPath from 'node:path';
import { describe, it, beforeEach, afterEach } from 'micro-should';
import { fileURLToPath, URL } from 'node:url';
import { tmpdir } from 'node:os';
import * as chai from 'chai';
import sinon, { SinonSpy } from 'sinon';
import sinonChai from 'sinon-chai';
import upath from 'upath';

import chokidar, { type ChokidarGlobOptions } from './esm/index.js';
import type { FSWatcher } from 'chokidar';

import { EVENTS as EV, isIBMi, isMacos, isWindows } from 'chokidar/handler.js';

const TEST_TIMEOUT = 5000; // ms

const { expect } = chai;
chai.use(sinonChai);
chai.should();

const imetaurl = import.meta.url;
const __filename = fileURLToPath(new URL('', imetaurl));
const __dirname = fileURLToPath(new URL('.', imetaurl)); // Will contain trailing slash
const initialPath = process.cwd();
const testfolder = 'chokidar-' + Date.now();
const tempDir = tmpdir();
const FIXTURES_PATH = sysPath.join(tempDir, testfolder);

const WATCHERS: FSWatcher[] = [];
const PERM = 0o755; // rwe, r+e, r+e
let testId = 0;
let currentDir: string;
let slowerDelay;

// spyOnReady

const aspy = (
  watcher: FSWatcher,
  eventName: (typeof EV)[keyof typeof EV],
  spy: sinon.SinonSpy<any[], any> | null = null,
  noStat = false
) => {
  if (typeof eventName !== 'string') {
    throw new TypeError('aspy: eventName must be a String');
  }
  if (spy == null) spy = sinon.spy();
  return new Promise<sinon.SinonSpy<any[], any>>((resolve, reject) => {
    const handler = noStat
      ? eventName === EV.ALL
        ? (event, path) => spy(event, path)
        : (path) => spy(path)
      : spy;
    const timeout = setTimeout(() => {
      reject(new Error('timeout'));
    }, TEST_TIMEOUT);
    watcher.on(EV.ERROR, (...args) => {
      clearTimeout(timeout);
      reject(...args);
    });
    watcher.on(EV.READY, () => {
      clearTimeout(timeout);
      resolve(spy);
    });
    watcher.on(eventName, handler);
  });
};

const delay = async (time?: number) => {
  return new Promise((resolve) => {
    const timer = time || slowerDelay || 20;
    setTimeout(resolve, timer);
  });
};

// dir path
const dpath = (subPath: string) => {
  const subd = (testId && testId.toString()) || '';
  return sysPath.join(FIXTURES_PATH, subd, subPath);
};
// glob path
const gpath = (subPath: string) => {
  const subd = (testId && testId.toString()) || '';
  return upath.join(FIXTURES_PATH, subd, subPath);
};
currentDir = dpath('');

const cwatch = (
  path: string | string[] | string[][] = currentDir,
  opts: ChokidarGlobOptions = {}
) => {
  const wt = chokidar.watch(path as unknown as string, opts);
  WATCHERS.push(wt);
  return wt;
};

const waitFor = (spies: ([SinonSpy<any[], any>, number] | SinonSpy<any[], any>)[]) => {
  if (spies.length === 0) throw new Error('need at least 1 spy');
  return new Promise<void>((resolve, reject) => {
    let checkTimer: NodeJS.Timeout;
    const timeout = setTimeout(() => {
      clearTimeout(checkTimer);
      reject(new Error('timeout waitFor, passed ms: ' + TEST_TIMEOUT));
    }, TEST_TIMEOUT);
    const isSpyReady = (spy: SinonSpy<any[], any> | [SinonSpy<any[], any>, number]) => {
      if (Array.isArray(spy)) {
        return spy[0].callCount >= spy[1];
      }
      return spy.callCount >= 1;
    };
    const checkSpiesReady = () => {
      clearTimeout(checkTimer);
      if (spies.every(isSpyReady)) {
        clearTimeout(timeout);
        resolve();
      } else {
        checkTimer = setTimeout(checkSpiesReady, 20);
      }
    };
    checkSpiesReady();
  });
};

const dateNow = () => Date.now().toString();

const runTests = (baseopts: { usePolling: boolean; persistent?: boolean; interval?: number }) => {
  let macosFswatch = isMacos && !baseopts.usePolling;
  let win32Polling = isWindows && baseopts.usePolling;
  let options: ChokidarGlobOptions;
  slowerDelay = macosFswatch ? 100 : undefined;
  baseopts.persistent = true;

  beforeEach(function clean() {
    options = {};
    Object.keys(baseopts).forEach((key) => {
      options[key] = baseopts[key];
    });
  });

  describe('watch glob patterns', () => {
    it('should correctly watch and emit based on glob input', async () => {
      const watchPath = gpath('*a*.txt');
      const addPath = dpath('add.txt');
      const changePath = dpath('change.txt');
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, changePath);

      await write(addPath, dateNow());
      await write(changePath, dateNow());

      // await delay();
      await waitFor([[spy, 3], spy.withArgs(EV.ADD, addPath)]);
      spy.should.have.been.calledWith(EV.ADD, addPath);
      spy.should.have.been.calledWith(EV.CHANGE, changePath);
      spy.should.not.have.been.calledWith(EV.ADD, dpath('unlink.txt'));
    });

    it('should respect negated glob patterns', async () => {
      const watchPath = gpath('*');
      const negatedWatchPath = `!${gpath('*a*.txt')}`;
      const unlinkPath = dpath('unlink.txt');
      const watcher = cwatch([watchPath, negatedWatchPath], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledOnce;
      spy.should.have.been.calledWith(EV.ADD, unlinkPath);

      // await delay();
      await fsp.unlink(unlinkPath);
      await waitFor([[spy, 2], spy.withArgs(EV.UNLINK)]);
      spy.should.have.been.calledTwice;
      spy.should.have.been.calledWith(EV.UNLINK, unlinkPath);
    });
    it('should respect negated glob patterns 2', async () => {
      const watchPath = gpath('*');

      const negatedWatchPath = `${gpath('!*a*.txt')}`;

      const unlinkPath = dpath('unlink.txt');
      const changePath = dpath('change.txt');
      const watcher = cwatch([watchPath, negatedWatchPath], options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledTwice;
      spy.should.have.been.calledWith(EV.ADD, unlinkPath);
      spy.should.have.been.calledWith(EV.ADD, changePath);

      // await delay();
      await fsp.unlink(unlinkPath);
      await waitFor([[spy, 2], spy.withArgs(EV.UNLINK)]);

      spy.should.have.been.calledThrice;
      spy.should.have.been.calledWith(EV.UNLINK, unlinkPath);
    });
    it('should traverse subdirs to match globstar patterns', async () => {
      const extra = 'chokidar-foo/foo/';

      const watchPath = gpath(`chokidar-*/foo/**/a*.txt`);
      const addFile = dpath(extra + 'add.txt');
      const extradir1 = dpath('chokidar-foo');
      const extradir2 = dpath(extra);
      const subdir = dpath(extra + 'subdir');
      const subsubdir = dpath(extra + 'subdir/subsub');
      const aFile = dpath(extra + 'subdir/a.txt');
      const bFile = dpath(extra + 'subdir/b.txt');
      const subFile = dpath(extra + 'subdir/subsub/ab.txt');
      await fsp.mkdir(extradir1, PERM);
      await fsp.mkdir(extradir2, PERM);
      await fsp.mkdir(subdir, PERM);
      await fsp.mkdir(subsubdir, PERM);
      await fsp.writeFile(aFile, 'b');
      await fsp.writeFile(bFile, 'b');
      await fsp.writeFile(subFile, 'b');

      // Linux fails sometimes without
      await delay();
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      await Promise.all([
        write(addFile, dateNow()),
        write(subFile, dateNow()),
        fsp.unlink(aFile),
        fsp.unlink(bFile),
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
      const id = testId.toString();
      const watchPath = upath.join(id, `*a*.txt`);
      // getFixturePath() returns absolute paths, so use sysPath.join() instead
      const addPath = sysPath.join(id, 'add.txt');
      const changePath = sysPath.join(id, 'change.txt');
      const unlinkPath = dpath('unlink.txt');
      const watcher = cwatch(watchPath, { ...options, cwd: FIXTURES_PATH });
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, changePath);

      await Promise.all([write(addPath, dateNow()), write(changePath, dateNow())]);
      await waitFor([[spy, 3], spy.withArgs(EV.ADD, addPath)]);

      spy.should.have.been.calledWith(EV.ADD, addPath);
      spy.should.have.been.calledWith(EV.CHANGE, changePath);
      spy.should.not.have.been.calledWith(EV.ADD, unlinkPath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR);

      let raceWon = true;

      try {
        spy.should.not.have.been.calledWith(EV.CHANGE, addPath);
        raceWon = false;
        // eslint-disable-next-line no-unused-vars
      } catch (e) {
        raceWon = true;
      }

      if (raceWon) {
        spy.should.have.been.callCount(4);
      } else if (!macosFswatch) {
        spy.should.have.been.calledThrice;
      }
    });

    it('should watch non-existent file and detect add', async () => {
      const testPath = dpath('add.txt');
      const watcher = cwatch(testPath, options);
      const spy = await aspy(watcher, EV.ADD);

      // never resolves waitFor on windows without delay
      await delay();
      await write(testPath, dateNow());
      await waitFor([spy]);
      spy.should.have.been.calledWith(testPath);
    });

    it('should correctly only emit add not change when file gets added', async () => {
      const addPath = dpath('add.txt');
      const watcher = cwatch(addPath, options);
      const spy = await aspy(watcher, EV.ALL);

      // never resolves waitFor on windows without delay
      await delay();
      await write(addPath, dateNow());
      await waitFor([spy]);

      spy.should.have.been.calledWith(EV.ADD, addPath);
      // FIXME: this actually might get emitted by windows
      spy.should.not.have.been.calledWith(EV.CHANGE, addPath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR);
    });
    it('should correctly handle conflicting glob patterns', async () => {
      const changePath = dpath('change.txt');
      const unlinkPath = dpath('unlink.txt');
      const addPath = dpath('add.txt');
      const watchPaths = [gpath('change*'), gpath('unlink*')];
      const watcher = cwatch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, changePath);
      spy.should.have.been.calledWith(EV.ADD, unlinkPath);
      spy.should.have.been.calledTwice;

      // macos seems to be flaky without
      await delay();
      await fsp.unlink(unlinkPath);
      await write(addPath, dateNow());
      await write(changePath, dateNow());

      await waitFor([[spy, 4], spy.withArgs(EV.UNLINK, unlinkPath)]);
      spy.should.have.been.calledWith(EV.CHANGE, changePath);
      spy.should.have.been.calledWith(EV.UNLINK, unlinkPath);
      spy.should.not.have.been.calledWith(EV.ADD, addPath);
      spy.callCount.should.equal(4);
    });
    it('should correctly handle intersecting glob patterns', async () => {
      const changePath = dpath('change.txt');
      const watchPaths = [gpath('cha*'), gpath('*nge.*')];
      const watcher = cwatch(watchPaths, options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, changePath);
      spy.should.have.been.calledOnce;

      await write(changePath, dateNow());
      // await delay();
      await waitFor([[spy, 2]]);
      spy.should.have.been.calledWith(EV.CHANGE, changePath);
      spy.should.have.been.calledTwice;
    });
    it('should not confuse glob-like filenames with globs', async () => {
      const filePath = dpath('nota[glob].txt');
      await write(filePath, 'b');
      // await delay();
      const spy = await aspy(cwatch(), EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, filePath);

      // await delay();
      await write(filePath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should treat glob-like directory names as literal directory names when globbing is disabled', async () => {
      options.disableGlobbing = true;
      const filePath = dpath('nota[glob]/a.txt');
      const watchPath = dpath('nota[glob]');
      const testDir = dpath('nota[glob]');
      const matchingDir = dpath('notag');
      const matchingFile = dpath('notag/b.txt');
      const matchingFile2 = dpath('notal');
      await fsp.mkdir(testDir, PERM);
      await fsp.writeFile(filePath, 'b');
      await fsp.mkdir(matchingDir, PERM);
      await fsp.writeFile(matchingFile, 'c');
      await fsp.writeFile(matchingFile2, 'd');
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, filePath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, matchingDir);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile2);
      // await delay();
      await write(filePath, dateNow());

      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should treat glob-like filenames as literal filenames when globbing is disabled', async () => {
      options.disableGlobbing = true;
      const filePath = dpath('nota[glob]');
      // This isn't using getGlobPath because it isn't treated as a glob
      const watchPath = dpath('nota[glob]');
      const matchingDir = dpath('notag');
      const matchingFile = dpath('notag/a.txt');
      const matchingFile2 = dpath('notal');
      await fsp.writeFile(filePath, 'b');
      await fsp.mkdir(matchingDir, PERM);
      await fsp.writeFile(matchingFile, 'c');
      await fsp.writeFile(matchingFile2, 'd');
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, filePath);
      spy.should.not.have.been.calledWith(EV.ADD_DIR, matchingDir);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile);
      spy.should.not.have.been.calledWith(EV.ADD, matchingFile2);
      // await delay();
      await write(filePath, dateNow());

      await waitFor([spy.withArgs(EV.CHANGE, filePath)]);
      spy.should.have.been.calledWith(EV.CHANGE, filePath);
    });
    it('should not prematurely filter dirs against complex globstar patterns', async () => {
      const deepFile = dpath('subdir/subsub/subsubsub/a.txt');
      const watchPath = gpath(`/**/subsubsub/*.txt`);
      await fsp.mkdir(dpath('subdir'), PERM);
      await fsp.mkdir(dpath('subdir/subsub'), PERM);
      await fsp.mkdir(dpath('subdir/subsub/subsubsub'), PERM);
      await fsp.writeFile(deepFile, 'b');
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      // await delay();
      await write(deepFile, dateNow());
      await waitFor([[spy, 2]]);
      spy.should.have.been.calledWith(EV.ADD, deepFile);
      spy.should.have.been.calledWith(EV.CHANGE, deepFile);
    });
    it('should emit matching dir events', async () => {
      // test with and without globstar matches
      const watchPaths = [gpath('*'), gpath('subdir/subsub/**/*')];
      const deepDir = dpath('subdir/subsub/subsubsub');
      const deepFile = sysPath.join(deepDir, 'a.txt');
      await fsp.mkdir(dpath('subdir'), PERM);
      await fsp.mkdir(dpath('subdir/subsub'), PERM);
      const watcher = cwatch(watchPaths, options);

      const spy = await aspy(watcher, EV.ALL);

      // Second mkdir is not tracked because its not matched by the glob pattern
      await waitFor([spy.withArgs(EV.ADD_DIR)]);
      spy.should.have.been.calledWith(EV.ADD_DIR, dpath('subdir'));
      spy.withArgs(EV.ADD_DIR).should.have.been.calledOnce;

      // This delay is needed. Otherwise the polling test will be flaky
      await delay();
      await fsp.mkdir(deepDir, PERM);
      await fsp.writeFile(deepFile, dateNow());

      await waitFor([[spy.withArgs(EV.ADD_DIR), 2], spy.withArgs(EV.ADD, deepFile)]);
      if (win32Polling) return;

      spy.should.have.been.calledWith(EV.ADD_DIR, deepDir);
      await fsp.unlink(deepFile);
      await fsp.rmdir(deepDir);

      await waitFor([spy.withArgs(EV.UNLINK_DIR)]);
      spy.should.have.been.calledWith(EV.UNLINK_DIR, deepDir);
    });
    it('should correctly handle glob with braces', async () => {
      const watchPath = upath.normalizeSafe(gpath('{subdir/*,subdir1/subsub1}/subsubsub/*.txt'));
      const deepFileA = dpath('subdir/subsub/subsubsub/a.txt');
      const deepFileB = dpath('subdir1/subsub1/subsubsub/a.txt');
      await fsp.mkdir(dpath('subdir'), PERM);
      await fsp.mkdir(dpath('subdir/subsub'), PERM);
      await fsp.mkdir(dpath('subdir/subsub/subsubsub'), PERM);
      await fsp.mkdir(dpath('subdir1'), PERM);
      await fsp.mkdir(dpath('subdir1/subsub1'), PERM);
      await fsp.mkdir(dpath('subdir1/subsub1/subsubsub'), PERM);
      await fsp.writeFile(deepFileA, dateNow());
      await fsp.writeFile(deepFileB, dateNow());
      const watcher = cwatch(watchPath, options);
      const spy = await aspy(watcher, EV.ALL);

      spy.should.have.been.calledWith(EV.ADD, deepFileA);
      spy.should.have.been.calledWith(EV.ADD, deepFileB);
      await fsp.appendFile(deepFileA, dateNow());
      await fsp.appendFile(deepFileB, dateNow());

      await waitFor([[spy, 4]]);
      spy.should.have.been.calledWith(EV.CHANGE, deepFileA);
      spy.should.have.been.calledWith(EV.CHANGE, deepFileB);
    });
  });

  describe('watch arrays of paths/globs', () => {
    it('should watch all paths in an array', async () => {
      const testPath = dpath('change.txt');
      const testDir = dpath('subdir');
      await fsp.mkdir(testDir);
      const watcher = cwatch([testDir, testPath], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, dpath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should accommodate nested arrays in input', async () => {
      const testPath = dpath('change.txt');
      const testDir = dpath('subdir');
      await fsp.mkdir(testDir);
      const watcher = cwatch([[testDir], [testPath]], options);
      const spy = await aspy(watcher, EV.ALL);
      spy.should.have.been.calledWith(EV.ADD, testPath);
      spy.should.have.been.calledWith(EV.ADD_DIR, testDir);
      spy.should.not.have.been.calledWith(EV.ADD, dpath('unlink.txt'));
      await write(testPath, dateNow());
      await waitFor([spy.withArgs(EV.CHANGE)]);
      spy.should.have.been.calledWith(EV.CHANGE, testPath);
    });
    it('should throw if provided any non-string paths', () => {
      expect(cwatch.bind(null, [[currentDir], /notastring/])).to.throw(TypeError, /non-string/i);
    });
  });
};

describe('chokidar', async () => {
  beforeEach(() => {
    testId++;
    currentDir = dpath('');
  });

  afterEach(async () => {
    const promises = WATCHERS.map((w) => w.close());
    await Promise.all(promises);
    await rm(currentDir, { recursive: true });
  });

  it('should expose public API methods', () => {
    chokidar.watch.should.be.a('function');
  });

  if (!isIBMi) {
    describe('fs.watch (non-polling)', runTests.bind(this, { usePolling: false }));
  }
  describe('fs.watchFile (polling)', runTests.bind(this, { usePolling: true, interval: 10 }));
});

async function main() {
  try {
    await rm(FIXTURES_PATH, { recursive: true, force: true });
    await fsp.mkdir(FIXTURES_PATH, { recursive: true, mode: PERM });
    // eslint-disable-next-line no-unused-vars
  } catch (error) {}
  process.chdir(FIXTURES_PATH);
  // Create many directories before tests.
  // Creating them in `beforeEach` increases chance of random failures.
  const _content = await read(__filename, 'utf-8');
  const _only = _content.match(/\sit\.only\(/g);
  const itCount = (_only && _only.length) || _content.match(/\sit\(/g)!.length;
  const testCount = itCount * 3;
  while (testId++ < testCount) {
    await fsp.mkdir(dpath(''), PERM);
    await write(dpath('change.txt'), 'b');
    await write(dpath('unlink.txt'), 'b');
  }
  testId = 0;

  await it.run(true);

  process.chdir(initialPath);

  try {
    await rm(FIXTURES_PATH, { recursive: true, force: true });
  } catch (error) {
    console.log(error);
  }
}
main();
