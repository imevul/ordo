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
  issueId?: string;
  /** When set, the event is only delivered to this user (e.g. notifications). */
  userId?: string;
  /** User who caused the change, so clients can skip echoing their own optimistic edits. */
  actorId?: string;
}
