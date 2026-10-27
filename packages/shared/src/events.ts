/**
 * Realtime events broadcast over the WebSocket at /api/ws. They are intentionally thin —
 * clients use them as cache-invalidation hints and refetch what they display.
 */
export type EntityKind =
  | 'issue'
  | 'comment'
  | 'project'
  | 'projectUpdate'
  | 'cycle'
  | 'label'
  | 'template'
  | 'initiative'
  | 'customer'
  | 'document'
  | 'team'
  | 'state'
  | 'workspace'
  | 'member'
  | 'view'
  | 'favorite'
  | 'notification'
  | 'import'
  | 'export';

export interface RealtimeEvent {
  kind: EntityKind;
  action: 'created' | 'updated' | 'deleted';
  id: string;
  workspaceId: string;
  teamId?: string;
  /** The team an issue moved from, so people who could see it there hear that it left. */
  prevTeamId?: string;
  issueId?: string;
  /** When set, the event is only delivered to this user (e.g. notifications). */
  userId?: string;
  /** User who caused the change, so clients can skip echoing their own optimistic edits. */
  actorId?: string;
  /** Where the change sits in the workspace's change log (sync clients fetch up to here). */
  seq?: number;
  epoch?: number;
}
