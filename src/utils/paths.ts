import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PathEnv {
  CODEX_RELAY_HOME?: string;
  HOME?: string;
  USERPROFILE?: string;
}

export interface DataPaths {
  root: string;
  accounts: string;
  state: string;
}

export function resolveDataPaths(env: PathEnv = process.env): DataPaths {
  const root =
    env.CODEX_RELAY_HOME?.trim() ||
    join(env.USERPROFILE?.trim() || env.HOME?.trim() || homedir(), '.codex-relay');

  return {
    root,
    accounts: join(root, 'accounts.json'),
    state: join(root, 'state.json')
  };
}
