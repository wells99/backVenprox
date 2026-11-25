import { proveMysqlTransaction } from '../packages/infrastructure/mysql/src/probe.js';
import { loadMysqlProbeConfig } from '../packages/infrastructure/runtime/src/config.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';

try {
  const result = await proveMysqlTransaction(loadMysqlProbeConfig(process.env));
  console.log(JSON.stringify({ event: 'mysql_probe_passed', ...result }));
} catch (error) {
  reportBootFailure('mysql-probe', error);
}
