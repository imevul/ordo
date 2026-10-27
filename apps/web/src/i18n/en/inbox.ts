/** The inbox: the notification list, snoozing, and what each kind of notification says. */
export default {
  kicker: 'inbox',
  title: 'Inbox',
  snoozedTitle: 'Snoozed',
  /** One line per notification: who did what. {actor} is a name. */
  describe: {
    assigned: '{actor} assigned you',
    unassigned: '{actor} unassigned you',
    comment: '{actor} commented',
    mention: '{actor} mentioned you',
    statusChanged: '{actor} changed status to {status}',
    urgent: '{actor} marked as urgent',
    slaBreached: '{actor} missed its SLA',
    reaction: '{actor} reacted {emoji} to your comment',
  },
  /** Stands in for a status that no longer exists. */
  newStatus: 'a new status',
  deletedIssue: 'Deleted issue',
  unread: 'Unread',
  /** When a snoozed notification comes back, e.g. "until Mon 09:00". */
  snoozedUntil: 'until {time}',
  snooze: {
    button: 'Snooze',
    buttonTitle: 'Snooze (H)',
    unsnoozeTitle: 'Unsnooze (H)',
    inAnHour: 'In an hour',
    laterToday: 'Later today',
    tomorrowMorning: 'Tomorrow morning',
    nextWeek: 'Next week',
  },
  showSnoozed: 'Show snoozed',
  backToInbox: 'Back to the inbox',
  markAllRead: 'Mark all as read',
  deleteRead: 'Delete read notifications',
  empty: {
    snoozedTitle: 'nothing snoozed',
    snoozedBody: 'Snoozed notifications wait here and come back unread when it’s time.',
    title: 'all caught up',
    body: 'Assignments, mentions and comments on issues you follow land here.',
  },
  /** Phone-width link above the opened issue. */
  back: '← back to inbox',
  select: {
    title: 'inbox',
    body: 'Select a notification to see the issue. J/K to move, U to toggle read, H to snooze, ⌫ to delete.',
  },
};
