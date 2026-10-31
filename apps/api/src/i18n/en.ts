/**
 * What the server says to people in their own language: emails, push notifications and chat direct
 * messages. English is the source; sv.ts and nb.ts may leave messages out and fall back to it.
 * Same format as the web app's catalogues (`{name}` placeholders, `{ one, other }` plurals).
 */
export default {
  email: {
    footer: 'Sent by your Ordo instance',
    passwordReset: {
      subject: 'Reset your Ordo password',
      kicker: 'password reset',
      title: 'Hi {name},',
      body: 'Someone (hopefully you) asked to reset your password. The link works for one hour, once.',
      ignore: "If it wasn't you, ignore this email — your password stays the same.",
      cta: 'Choose a new password',
      text: "Hi {name},\n\nReset your Ordo password (valid for one hour):\n{url}\n\nIf it wasn't you, ignore this email.",
    },
    verify: {
      subject: 'Verify your email address',
      kicker: 'verify email',
      title: 'Welcome, {name}',
      body: 'Confirm this is your email address. The link works for two days.',
      cta: 'Verify email',
      text: 'Verify your Ordo email address:\n{url}',
    },
    change: {
      subject: 'Confirm your new email address',
      kicker: 'email change',
      title: 'Confirm your new address',
      body: 'Confirm this address to make it the one you sign in with.',
      cta: 'Confirm address',
      text: 'Confirm your new Ordo email address:\n{url}',
    },
    invite: {
      subject: '{inviter} invited you to {workspace} on Ordo',
      kicker: 'invitation',
      title: 'Join {workspace}',
      body: '{inviter} invited you to the <b>{workspace}</b> workspace as {role}.',
      cta: 'Accept invite',
      text: '{inviter} invited you to {workspace} on Ordo as {role}.\n\nAccept: {url}',
      /** The role as it reads mid-sentence: "as member". */
      role: { owner: 'owner', admin: 'admin', member: 'member', guest: 'guest' },
    },
    siteInvite: {
      subject: '{inviter} invited you to Ordo at {instance}',
      kicker: 'invitation',
      title: 'Join Ordo at {instance}',
      body: '{inviter} invited you to create an account on <b>{instance}</b>.',
      bodyCreate:
        '{inviter} invited you to create an account on <b>{instance}</b>, where you can start your own workspaces.',
      cta: 'Create your account',
      text: '{inviter} invited you to create an account on Ordo at {instance}.\n\nSign up: {url}',
    },
    security: {
      kicker: 'security',
      notYou: "If this wasn't you, change your password and contact your administrator.",
      cta: 'Open account settings',
      twoFactorOn: {
        title: 'Two-factor authentication is on',
        body: 'Signing in to Ordo now also needs a code from your authenticator app.',
      },
      twoFactorOff: {
        title: 'Two-factor authentication is off',
        body: 'Signing in to Ordo now only needs your password.',
      },
      totpOff: {
        title: 'Your authenticator app no longer signs in to Ordo',
        body: 'Signing in with your password now asks for one of your passkeys (or a recovery code) instead.',
      },
      passkeyAdded: {
        title: 'A passkey was added to your Ordo account',
        body: 'The passkey "{name}" can now sign in to your account.',
      },
      passkeyRemoved: {
        title: 'A passkey was removed from your Ordo account',
        body: 'The passkey "{name}" can no longer sign in to your account.',
      },
      emailChanged: {
        title: 'Your Ordo email address changed',
        body: 'Your account now uses {email}.',
      },
    },
    digest: {
      kicker: 'inbox',
      updates: { one: '{count} update in {workspace}', other: '{count} updates in {workspace}' },
      footer: 'Change which emails you get in Settings → Notifications',
      settings: 'Notification settings: {url}',
    },
  },
  /** One line per notification: the push body and the email digest line. */
  notification: {
    issue_assigned: '{actor} assigned you',
    issue_unassigned: '{actor} unassigned you',
    issue_comment: '{actor} commented',
    issue_mention: '{actor} mentioned you',
    issue_status_changed: '{actor} moved it to {state}',
    issue_priority_urgent: '{actor} marked it urgent',
    comment_reaction: '{actor} reacted to your comment',
    issue_sla_breached: 'Missed its SLA',
    someone: 'Someone',
  },
  /** Direct messages in Slack, Discord, Matrix and Telegram; {issue} is the identifier. */
  chat: {
    issue_assigned: '{actor} assigned you {issue}',
    issue_unassigned: '{actor} unassigned you from {issue}',
    issue_comment: '{actor} commented on {issue}',
    issue_mention: '{actor} mentioned you on {issue}',
    issue_status_changed: '{actor} moved {issue} to {state}',
    issue_priority_urgent: '{actor} marked {issue} urgent',
    comment_reaction: '{actor} reacted to your comment on {issue}',
    issue_sla_breached: '{issue} missed its SLA',
    unassigned: 'Unassigned',
    priority: { '1': 'Urgent', '2': 'High', '3': 'Medium', '4': 'Low' },
  },
  releases: {
    /** Heading in drafted release notes for issues without a label. */
    otherHeading: 'Other changes',
  },
};
