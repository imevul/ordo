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

## Rules that keep accounts safe

Accounts are shared between workspaces on an instance, so a directory gets limited powers:

- It can add people only at the workspace's **verified domains**, and change someone's email only from one verified
  domain to another. Names change only for people at those domains.
- It never suspends or removes an **owner** (you'll see a `403` in your provider's logs); change owners in Ordo.
- A token works for one workspace only, and isn't an API key: it can't read issues or act as anyone.
- Revoking a token (Settings → Authentication) stops it immediately.

## Endpoints

The base URL serves `ServiceProviderConfig`, `ResourceTypes`, `Schemas` and `Users` (list with `filter`, `startIndex`
and `count`; get, create, replace, patch and delete). Filters support `eq` on `userName`, `externalId`,
`emails.value` and `id`, joined with `and`. PATCH accepts the dialects Okta and Entra ID send, including
operation names in any case, values without a path, and `"True"`/`"False"` as booleans. Bulk operations, sorting
and ETags aren't supported. Each token may make 1,200 requests a minute.
