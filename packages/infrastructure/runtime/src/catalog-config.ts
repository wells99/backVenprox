import { ConfigurationError } from './config.js';
export function catalogLabWrites(env:NodeJS.ProcessEnv):boolean {
  if(env.CATALOG_LAB_WRITES===undefined||env.CATALOG_LAB_WRITES==='false')return false;
  if(env.CATALOG_LAB_WRITES!=='true'||env.NODE_ENV==='production'||env.MYSQL_HOST!=='127.0.0.1'||env.MYSQL_PORT!=='3308'||!['venprox_b05_lab','venprox_b05_test'].includes(env.MYSQL_DATABASE??''))throw new ConfigurationError('CATALOG_LAB_WRITES');
  return true;
}
