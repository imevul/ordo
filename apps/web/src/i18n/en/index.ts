import admin from './admin.ts';
import agents from './agents.ts';
import auth from './auth.ts';
import common from './common.ts';
import customers from './customers.ts';
import cycles from './cycles.ts';
import enums from './enums.ts';
import errors from './errors.ts';
import imports from './imports.ts';
import inbox from './inbox.ts';
import initiatives from './initiatives.ts';
import insights from './insights.ts';
import integrations from './integrations.ts';
import issue from './issue.ts';
import issues from './issues.ts';
import mcp from './mcp.ts';
import projects from './projects.ts';
import roadmap from './roadmap.ts';
import settings from './settings.ts';
import shell from './shell.ts';
import sso from './sso.ts';
import teams from './teams.ts';
import templates from './templates.ts';
import time from './time.ts';
import triageRules from './triageRules.ts';
import views from './views.ts';
import webhooks from './webhooks.ts';
import workspaceSettings from './workspaceSettings.ts';
/**
 * English, the source language. One file per area of the app; keys are grouped by screen.
 * Never name a group's key `other`: an object with `other` is read as plural forms.
 */
export default {
  common,
  time,
  enums,
  settings,
  shell,
  issues,
  issue,
  auth,
  admin,
  workspaceSettings,
  teams,
  templates,
  triageRules,
  sso,
  webhooks,
  integrations,
  mcp,
  agents,
  imports,
  customers,
  views,
  projects,
  initiatives,
  roadmap,
  cycles,
  inbox,
  insights,
  errors,
};
