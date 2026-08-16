// Offline checks for which browser a run talks to.
//
// The failure this layer exists to prevent leaves no trace in any row: the CLI
// connects to a browser nobody chose and reports whatever that one answers. So
// what is checked here is the precedence between the four layers, and that a
// choice which cannot be one is refused at the moment it is made rather than on
// the first command (F-074).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runner } from './harness.mjs';
import {
  browserConfigFile,
  clearBrowserConfig,
  describeBrowserTarget,
  readBrowserConfig,
  resolveBrowserOptions,
  validateBrowserChoice,
  writeBrowserConfig,
} from '../src/runtime/browser-config.mjs';

const { check, assert, run } = runner();

const BROWSER_ENV = ['AVITO_BROWSER_WS', 'AVITO_BROWSER_PROFILE', 'AVITO_BROWSER_URL'];

/**
 * Every check runs against a throwaway state directory and a cleared
 * environment, so a browser the developer actually remembered on this machine
 * cannot decide whether the suite passes.
 */
function isolated(fn) {
  const saved = Object.fromEntries(BROWSER_ENV.map((name) => [name, process.env[name]]));
  const savedDir = process.env.AVITO_BROKER_DIR;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avito-browser-config-'));
  process.env.AVITO_BROKER_DIR = scratch;
  for (const name of BROWSER_ENV) delete process.env[name];
  try {
    fn(scratch);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (savedDir === undefined) delete process.env.AVITO_BROKER_DIR;
    else process.env.AVITO_BROKER_DIR = savedDir;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

check('with nothing configured the default debugging port is used', () => {
  isolated(() => {
    const target = resolveBrowserOptions();
    assert(target.browserUrl === 'http://127.0.0.1:9222', 'the default port must be the last resort');
    assert(target.source === 'the default', 'the report must say the choice was nobody\'s');
  });
});

check('a remembered choice survives into the next run', () => {
  isolated((scratch) => {
    writeBrowserConfig({ browserProfile: scratch });
    assert(readBrowserConfig().browserProfile === fs.realpathSync(scratch)
      || readBrowserConfig().browserProfile === scratch, 'the profile must be read back');
    const target = resolveBrowserOptions();
    assert(target.browserProfile !== undefined, 'the remembered profile must be what a command uses');
    assert(target.source === browserConfigFile(), 'the report must name the file the choice came from');
  });
});

check('the environment outranks the file, and a flag outranks both', () => {
  isolated((scratch) => {
    writeBrowserConfig({ browserProfile: scratch });
    process.env.AVITO_BROWSER_URL = 'http://127.0.0.1:1234/';
    assert(resolveBrowserOptions().browserUrl === 'http://127.0.0.1:1234/', 'the environment must win over the file');
    const explicit = resolveBrowserOptions({ browserWs: 'ws://127.0.0.1:5555/devtools/browser/x' });
    assert(explicit.browserWs === 'ws://127.0.0.1:5555/devtools/browser/x', 'the flag must win over the environment');
    assert(explicit.source === 'the command line', 'the report must name the layer that decided');
  });
});

// The bug this pins: resolving field by field rather than layer by layer lets a
// profile the file remembered beat a URL passed on the command line, because
// the profile is consulted first inside one layer.
check('a layer decides the transport outright', () => {
  isolated((scratch) => {
    writeBrowserConfig({ browserProfile: scratch });
    const target = resolveBrowserOptions({ browserUrl: 'http://127.0.0.1:4321/' });
    assert(target.browserProfile === undefined, 'a lower layer must not contribute a second transport');
    assert(target.browserUrl === 'http://127.0.0.1:4321/', 'the higher layer must decide alone');
  });
});

check('a choice that cannot be one is refused when it is made', () => {
  isolated((scratch) => {
    const refused = (choice) => {
      try {
        validateBrowserChoice(choice);
      } catch {
        return true;
      }
      return false;
    };
    assert(refused({ browserProfile: path.join(scratch, 'absent') }), 'a directory that does not exist must be refused');
    assert(refused({ browserWs: 'http://127.0.0.1:9222' }), 'a URL that is not a socket must be refused');
    assert(refused({ browserUrl: 'not a url' }), 'text that is not a URL must be refused');
    assert(refused({}), 'naming no transport at all must be refused');
    assert(validateBrowserChoice({ browserProfile: scratch }).browserProfile === path.resolve(scratch),
      'a profile must be remembered as an absolute path');
  });
});

check('forgetting a choice returns the run to the default', () => {
  isolated((scratch) => {
    writeBrowserConfig({ browserProfile: scratch });
    assert(clearBrowserConfig() === true, 'removing a remembered choice must report that it was there');
    assert(clearBrowserConfig() === false, 'removing nothing must say so rather than claim a removal');
    assert(readBrowserConfig() === null, 'nothing must be remembered afterwards');
    assert(resolveBrowserOptions().source === 'the default', 'the default must be back');
  });
});

check('a target describes itself as the thing a person can go look at', () => {
  assert(describeBrowserTarget({ browserProfile: '/p' }) === 'profile /p', 'a profile is named by its directory');
  assert(describeBrowserTarget({ browserUrl: 'http://x/' }) === 'debugging port http://x/', 'a port is named as one');
  assert(describeBrowserTarget({ browserWs: 'ws://x' }) === 'socket ws://x', 'a socket is named as one');
});

export default await run('browser-config — which browser a command talks to');
