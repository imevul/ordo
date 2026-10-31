/**
 * The GraphQL schema, in SDL. Resolvers live in resolvers.ts; types without a resolver for a
 * field read the property of the same name from the REST shape (`@ordo/shared` types).
 * Timestamps are ISO-8601 strings and calendar dates `YYYY-MM-DD`, as in the REST API.
 */
export const typeDefs = /* GraphQL */ `
"""
Ordo's GraphQL API for one workspace. Everything is answered from the caller's point of view:
teams, issues and projects they can't see don't exist here.
"""
type Query {
  "The person the request acts as."
  viewer: User!
  workspace: Workspace!
  "Teams you can see."
  teams: [Team!]!
  "A team by key (ENG) or id."
  team(key: String!): Team
  "People in the workspace (guests don't see other people's email)."
  members: [User!]!
  labels: [Label!]!
  "Workspace fields and those of teams you can see; with teamKey, the fields that team's issues have."
  customFields(teamKey: String): [CustomField!]!
  projects: [Project!]!
  project(id: ID!): Project
  "Cycles of the teams you can see, or of one team."
  cycles(teamKey: String): [Cycle!]!
  "An issue by id or identifier (ENG-42); null when it doesn't exist or you can't see it."
  issue(id: ID!): Issue
  "Issues matching a filter, a page at a time (in id order, so cursors stay valid)."
  issues(filter: IssueFilter, first: Int = 50, after: String): IssueConnection!
  "Full-text search over titles, descriptions and comments, best matches first."
  search(query: String!, first: Int = 20): [Issue!]!
}

type Mutation {
  issueCreate(input: IssueCreateInput!): Issue!
  "Change an issue. Fields left out stay as they are; null clears."
  issueUpdate(id: ID!, input: IssueUpdateInput!): Issue!
  "Take it out of lists (still readable by link and in search)."
  issueArchive(id: ID!): Issue!
  issueUnarchive(id: ID!): Issue!
  "Move it to the trash."
  issueTrash(id: ID!): Boolean!
  "Markdown; @username mentions notify. parentId answers another comment."
  commentCreate(issueId: ID!, body: String!, parentId: ID): Comment!
}

type Workspace {
  id: ID!
  name: String!
  slug: String!
  "Where its web app lives."
  url: String!
}

type User {
  id: ID!
  name: String!
  username: String!
  "Empty when guests look at other people."
  email: String!
  avatarUrl: String
  "owner, admin, member or guest; null for people who aren't members (any more)."
  role: String
}

type Team {
  id: ID!
  key: String!
  name: String!
  description: String
  color: String!
  private: Boolean!
  cyclesEnabled: Boolean!
  triageEnabled: Boolean!
  "In workflow order."
  states: [WorkflowState!]!
  members: [User!]!
  "The custom fields its issues have: the workspace's and its own, in order."
  customFields: [CustomField!]!
  issues(filter: IssueFilter, first: Int = 50, after: String): IssueConnection!
}

enum StateType {
  triage
  backlog
  unstarted
  started
  completed
  canceled
}

type WorkflowState {
  id: ID!
  name: String!
  type: StateType!
  color: String!
  position: Int!
  description: String
}

type Label {
  id: ID!
  name: String!
  color: String!
  "Null for workspace labels."
  team: Team
}

enum CustomFieldType {
  select
  multi_select
  number
  date
  text
  person
}

type CustomFieldOption {
  "Stable within the field: renaming an option keeps the issues that have it."
  id: ID!
  name: String!
  color: String!
}

type CustomField {
  id: ID!
  name: String!
  description: String
  type: CustomFieldType!
  "Null for fields every team's issues have."
  team: Team
  "The choices of select and multi_select fields; empty for the other types."
  options: [CustomFieldOption!]!
  position: Float!
}

"An issue's value for one custom field. Only the part for the field's type is set."
type CustomFieldValue {
  field: CustomField!
  "select: the chosen option; multi_select: the chosen options."
  options: [CustomFieldOption!]!
  number: Float
  "YYYY-MM-DD"
  date: String
  text: String
  user: User
  "The value written out: option names (comma-separated), the number, date or text, or the person's username."
  display: String!
}

"""
A custom field value to set. Give the part for the field's type: optionId (select), optionIds
(multi_select), number, date (YYYY-MM-DD), text, or userId (person). Leave them all out to clear it.
"""
input CustomFieldValueInput {
  fieldId: ID!
  optionId: ID
  optionIds: [ID!]
  number: Float
  date: String
  text: String
  userId: ID
}

type Progress {
  total: Int!
  completed: Int!
  started: Int!
  canceled: Int!
  totalEstimate: Float!
  completedEstimate: Float!
}

type Project {
  id: ID!
  name: String!
  description: String
  color: String!
  "planned, started, paused, completed or canceled"
  status: String!
  "on_track, at_risk or off_track, from the latest update"
  health: String
  lead: User
  startDate: String
  targetDate: String
  teams: [Team!]!
  progress: Progress!
  milestones: [Milestone!]!
  issues(filter: IssueFilter, first: Int = 50, after: String): IssueConnection!
  createdAt: String!
  updatedAt: String!
}

type Milestone {
  id: ID!
  name: String!
  description: String
  targetDate: String
  progress: Progress!
}

type Cycle {
  id: ID!
  number: Int!
  name: String
  description: String
  startsAt: String!
  endsAt: String!
  team: Team!
  progress: Progress!
}

type Issue {
  id: ID!
  "ENG-42"
  identifier: String!
  number: Int!
  title: String!
  "Markdown."
  description: String!
  "0 none, 1 urgent, 2 high, 3 medium, 4 low"
  priority: Int!
  priorityLabel: String!
  estimate: Int
  dueDate: String
  team: Team!
  state: WorkflowState!
  assignee: User
  "Null when the creator's account was deleted."
  creator: User
  labels: [Label!]!
  "The custom fields it has a value for, in field order."
  customFieldValues: [CustomFieldValue!]!
  project: Project
  milestone: Milestone
  cycle: Cycle
  parent: Issue
  children: [Issue!]!
  comments: [Comment!]!
  "The git branch name, in the workspace's format, for the viewer."
  branchName: String!
  "Its page in the web app."
  url: String!
  createdAt: String!
  updatedAt: String!
  startedAt: String
  completedAt: String
  canceledAt: String
  archivedAt: String
  "Set while it's in the trash."
  trashedAt: String
  "When the team's SLA for its priority runs out."
  slaBreachesAt: String
}

type Comment {
  id: ID!
  "Markdown."
  body: String!
  "Null when the author's account was deleted."
  author: User
  parentId: ID
  reactions: [Reaction!]!
  createdAt: String!
  updatedAt: String!
  editedAt: String
}

type Reaction {
  emoji: String!
  users: [User!]!
}

type PageInfo {
  hasNextPage: Boolean!
  "Pass as after to get the next page."
  endCursor: String
}

type IssueConnection {
  nodes: [Issue!]!
  pageInfo: PageInfo!
}

enum ArchivedFilter {
  "Archived issues too."
  include
  "Only archived issues."
  only
}

"All fields combine with AND; lists are OR."
input IssueFilter {
  teamId: ID
  stateIds: [ID!]
  stateTypes: [StateType!]
  "0–4"
  priorities: [Int!]
  "Ids, me or none."
  assigneeIds: [String!]
  "Ids or me."
  creatorIds: [String!]
  "Has any of these."
  labelIds: [ID!]
  "Ids or none."
  projectIds: [String!]
  milestoneIds: [String!]
  cycleIds: [String!]
  "Sub-issues of."
  parentId: ID
  "Has one of the values, for every field given."
  customFields: [CustomFieldFilter!]
  "Words (as prefixes), or an identifier."
  query: String
  subscribedByMe: Boolean
  archived: ArchivedFilter
}

input CustomFieldFilter {
  fieldId: ID!
  "Option ids, user ids or me, a number or date written out, the text, or none for no value."
  values: [String!]!
}

input IssueCreateInput {
  teamId: ID!
  title: String!
  description: String
  "The team's default when left out."
  stateId: ID
  priority: Int
  assigneeId: ID
  labelIds: [ID!]
  projectId: ID
  milestoneId: ID
  cycleId: ID
  parentId: ID
  estimate: Int
  "YYYY-MM-DD"
  dueDate: String
  customFields: [CustomFieldValueInput!]
}

input IssueUpdateInput {
  title: String
  description: String
  "Moves the issue to another team."
  teamId: ID
  stateId: ID
  priority: Int
  assigneeId: ID
  "Replaces all labels."
  labelIds: [ID!]
  addLabelIds: [ID!]
  removeLabelIds: [ID!]
  projectId: ID
  milestoneId: ID
  cycleId: ID
  parentId: ID
  estimate: Int
  dueDate: String
  "Sets the fields given; the others keep their value."
  customFields: [CustomFieldValueInput!]
}
`;
