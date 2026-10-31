/** Swedish. Anything missing falls back to English (../en). */
import type { Translation } from '../index.ts';
import admin from './admin.ts';
import agents from './agents.ts';
import auth from './auth.ts';
import automationRules from './automationRules.ts';
import common from './common.ts';
import customers from './customers.ts';
import cycles from './cycles.ts';
import dashboards from './dashboards.ts';
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
  automationRules,
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
  dashboards,
  inbox,
  insights,
  errors,
} satisfies Translation;
