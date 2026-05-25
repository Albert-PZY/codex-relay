import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PathEnv {
  CODEX_RELAY_HOME?: string;
  CODEX_HOME?: string;
  HOME?: string;
  USERPROFILE?: string;
}

export interface DataPaths {
  root: string;
  accounts: string;
  state: string;
  health: string;
  rotationLog: string;
  lock: string;
  codexHome: string;
  instances: string;
}

export function resolveDataPaths(env: PathEnv = process.env): DataPaths {
  const userHome = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  const root =
    env.CODEX_RELAY_HOME?.trim() ||
    join(userHome, '.codex-relay');
  const codexHome = env.CODEX_HOME?.trim() || join(userHome, '.codex');

  return {
    root,
    accounts: join(root, 'accounts.json'),
    state: join(root, 'state.json'),
    health: join(root, 'health.json'),
    rotationLog: join(root, 'rotation.log'),
    lock: join(root, 'store.lock'),
    codexHome,
    instances: join(root, 'instances')
  };
}
