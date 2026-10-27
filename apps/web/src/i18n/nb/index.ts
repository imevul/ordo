/** Norwegian Bokmål. Anything missing falls back to English (../en). */
import type { Translation } from '../index.ts';
import common from './common.ts';
import enums from './enums.ts';
import issue from './issue.ts';
import issues from './issues.ts';
import settings from './settings.ts';
import shell from './shell.ts';
import time from './time.ts';

export default { common, time, enums, settings, shell, issues, issue } satisfies Translation;
