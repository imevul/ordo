import common from './common.ts';
import enums from './enums.ts';
import issue from './issue.ts';
import issues from './issues.ts';
import settings from './settings.ts';
import shell from './shell.ts';
import time from './time.ts';

/**
 * English, the source language. One file per area of the app; keys are grouped by screen.
 * Never name a group's key `other`: an object with `other` is read as plural forms.
 */
export default { common, time, enums, settings, shell, issues, issue };
