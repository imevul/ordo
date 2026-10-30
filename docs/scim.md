# Directory sync (SCIM)

SCIM lets your identity provider keep a workspace's members in step with your directory. Assign someone to Ordo in
Okta, Entra ID or Authentik and they become a member; change their name or address there and it changes here;
deactivate them and they're suspended in Ordo at once, without waiting for their session to run out.

SCIM decides **who is a member**. [Single sign-on](sso.md) decides **how they sign in**. You'll usually want both:
people your directory adds have no password, so they sign in through your provider.

## Before you start

- **Verify your email domain** under **Settings → Access → Domains**. The directory can only add people at verified
  domains, and only sees members there (plus anyone it added itself).
- Set up [single sign-on](sso.md) with the same provider, so the people it adds can sign in.

## Connect your identity provider

1. **Settings → Authentication → Directory sync (SCIM)**: copy the **SCIM base URL**
   (`https://<your Ordo>/api/scim/v2`) and create a **token**. Copy the token straight away; it isn't shown again.
2. Pick the role people join as (**member** or **guest**). You can change anyone's role in Ordo afterwards.
3. In your identity provider:

| Provider  | Where                                                                                                               | Settings                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Okta      | Your Ordo app → General → Provisioning: _SCIM_; then Provisioning → Integration                                     | Base URL, _Unique identifier field_ `userName`, actions _Push New Users_, _Push Profile Updates_, _Push Groups_; auth _HTTP Header_ with the token |
| Entra ID  | Enterprise applications → your Ordo app → Provisioning → _Automatic_                                                | _Tenant URL_ = base URL, _Secret token_ = the token; _Test connection_; map `userPrincipalName` or `mail` to `userName`                            |
| Authentik | Providers → _SCIM Provider_ (URL = base URL, token), then add it as a backchannel provider of your Ordo application | The default user and group mappings work                                                                                                           |

Okta and Entra ID test the connection by listing users; a working token answers with the members at your verified
domains.

## What syncs

| In your directory                             | In Ordo                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Assign someone                                | Their account is created (or found by email) and joins with the role you picked            |
| Change their name                             | Their name changes                                                                         |
| Change their email to another verified domain | Their email changes                                                                        |
| Deactivate them                               | They're **suspended**: they can't open the workspace, and open tabs lose access right away |
| Reactivate them                               | Suspension lifted                                                                          |
| Unassign or delete them                       | They're **removed** from the workspace and its teams; their account and work stay          |

Changes show in the audit log as made by **Directory sync**.

## Groups and teams

Push groups from your identity provider and they appear under **Settings → Authentication → Groups**. On their
own they change nothing. **Link a group to a team** and the team's members become the group's members: Ordo shows
who would join and who would leave before you confirm, then keeps the team in step as people join and leave the
group in your directory.

- Several groups can link to one team; its members are everyone in any of them.
- On a linked team, people can't be added or removed by hand (Ordo says which group to change). Team roles are still
  set in Ordo, and survive syncs.
- **Link new groups to the team with the same name** links a group by itself when it's created or renamed, if a team
  has that name (ignoring case). Linking by hand works either way.
- Unlinking, or deleting the group in your directory, leaves the team's members as they were, and the team is managed
  by hand again.
- People only count once they're members of the workspace, so push users before (or with) their groups. If you set
  a default team for new members, don't also link it to a group, or new people will join it and then leave it.

## Rules that keep accounts safe

Accounts are shared between workspaces on an instance, so a directory gets limited powers:

- It can add people only at the workspace's **verified domains**, and change someone's email only from one verified
  domain to another. Names change only for people at those domains.
- It links an existing account only if that account has **verified** its address. An unverified account at the
  address (anyone can claim an address without proving it) is moved to a placeholder address, kept with its work,
  and the directory gets a fresh account. If it was really theirs, an instance admin can
  send its holder a password reset link (Admin → Users) to get back in and pick another address.
- It never suspends or removes an **owner** (you'll see a `403` in your provider's logs); change owners in Ordo.
- A token works for one workspace only, and isn't an API key: it can't read issues or act as anyone.
- Revoking a token (Settings → Authentication) stops it immediately.

## Endpoints

The base URL serves `ServiceProviderConfig`, `ResourceTypes`, `Schemas`, `Users` and `Groups` (each: list with
`filter`, `startIndex` and `count`; get, create, replace, patch and delete). User filters support `eq` on `userName`,
`externalId`, `emails.value` and `id`; group filters on `displayName`, `externalId` and `id`; both joined with `and`.
Groups honour `excludedAttributes=members`, and members the directory can't see are ignored. PATCH accepts the dialects Okta and Entra ID send, including
operation names in any case, values without a path, and `"True"`/`"False"` as booleans. Bulk operations, sorting
and ETags aren't supported. Each token may make 1,200 requests a minute.
