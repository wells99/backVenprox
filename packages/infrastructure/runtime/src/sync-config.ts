import { ConfigurationError } from './config.js';
export function syncLabWrites(env:NodeJS.ProcessEnv):boolean {
  if(env.SYNC_LAB_WRITES===undefined||env.SYNC_LAB_WRITES==='false')return false;
  if(env.SYNC_LAB_WRITES!=='true'||env.NODE_ENV==='production'||env.MYSQL_HOST!=='127.0.0.1'||env.MYSQL_PORT!=='3308'||!['venprox_b10_test','venprox_b10_lab'].includes(env.MYSQL_DATABASE??''))throw new ConfigurationError('SYNC_LAB_WRITES');return true;
}
