/*! chokidar-glob - MIT License (c) 2025 Ulrich-Matthias Schäfer */
import {
  ChokidarOptions,
  watch as chokidarWatch,
  EmitArgs,
  FSWatcherEventMap,
  Matcher,
  MatchFunction,
} from 'chokidar';
import { EVENTS } from 'chokidar/handler.js';
import picomatch from 'picomatch';

export interface ChokidarGlobOptions extends ChokidarOptions {
  disableGlobbing?: boolean;
}

const removeUndefinedValues = (o: ChokidarGlobOptions) => {
  return Object.fromEntries(Object.entries(o).filter(([_, v]) => v !== undefined));
};

function handleWatchGlobs(
  _watchPaths: string | string[],
  { cwd }: ChokidarOptions = {}
): [string[], MatchFunction | null] {
  // Make sure watchPath is an array
  // Chokidar actually also allows string[][] and not only string[]
  const watchPaths = (Array.isArray(_watchPaths) ? _watchPaths : [_watchPaths]).flat();

  const globPaths: string[] = [];
  const globParents: string[] = [];
  const negatedGlobs: string[] = [];
  const normalPaths: string[] = [];

  // Get all glob and non glob paths
  for (let i = 0; i < watchPaths.length; i++) {
    const p = watchPaths[i];
    const scan = picomatch.scan(p);
    if (scan.isGlob) {
      if (scan.negated) {
        negatedGlobs.push(p.slice(scan.start));
        continue;
      }

      globParents.push(scan.prefix + scan.base);

      globPaths.push(watchPaths[i]);
    } else {
      normalPaths.push(watchPaths[i]);
    }
  }

  if (globPaths.length === 0 && negatedGlobs.length === 0) {
    return [watchPaths, null];
  }

  const matcher = picomatch(globPaths, { cwd, dot: true });
  const negativeMatchers = picomatch(negatedGlobs, { cwd, dot: true });

  // Ignore function to filter emitted events
  const ignoreFunction = (p: string) => {
    if (negativeMatchers(p)) return true;
    if (normalPaths.includes(p)) return false;
    if (!matcher(p)) return true;
    return false;
  };

  // Ignore all paths that don't match any of the globs
  return [[...new Set([...globParents, ...normalPaths])], ignoreFunction];
}

function handleIgnoreGlobs({ ignored, cwd }: ChokidarOptions): Matcher[] {
  // Make sure we always have an array
  const matchers = Array.isArray(ignored) ? ignored : ignored != null ? [ignored] : [];

  const nonGlobMatchers = [];
  const ignoredGlobs = [];

  for (let i = 0; i < matchers.length; i++) {
    const s = matchers[i];

    if (typeof s !== 'string' || !picomatch.scan(s).isGlob) {
      nonGlobMatchers.push(s);
      continue;
    }

    ignoredGlobs.push(s);
  }

  if (ignoredGlobs.length === 0) {
    return matchers;
  }

  // Create a matcher function that matches all our collected globs
  const matcher = picomatch(ignoredGlobs, { cwd, dot: true });
  nonGlobMatchers.push(matcher);

  return nonGlobMatchers;
}

export function watch(watchPath: string | string[], watchOptions: ChokidarGlobOptions = {}) {
  // If globbing is disabled, dont do anything
  if (watchOptions.disableGlobbing === true) {
    return chokidarWatch(watchPath, watchOptions);
  }

  const [watchPaths, ignoreFunction] = handleWatchGlobs(watchPath, watchOptions);

  watchOptions.ignored = handleIgnoreGlobs(watchOptions);

  const watcher = chokidarWatch(
    watchPaths,
    // https://github.com/paulmillr/chokidar/issues/1394
    removeUndefinedValues(watchOptions)
  );

  if (!ignoreFunction) {
    return watcher;
  }

  const originalEmit = watcher.emit;

  watcher.emit = function fn(eventName, ...args) {
    switch (eventName) {
      case EVENTS.ERROR:
      case EVENTS.RAW:
      case EVENTS.READY:
        return originalEmit.call(watcher, eventName, ...(args as never));
    }

    let path =
      eventName === EVENTS.ALL ? (args as FSWatcherEventMap['all'])[1] : (args as EmitArgs)[0];

    if (ignoreFunction(path)) {
      originalEmit.call(watcher, 'original:' + eventName, ...(args as never));
      return false;
    }

    return originalEmit.call(watcher, eventName, ...(args as never));
  };

  return watcher;
}

export default { watch };
