# Keyboard shortcuts

Press `?` anywhere in Ordo to see this list. `Mod` is `⌘` on macOS and `Ctrl` elsewhere. Shortcuts don't
fire while you're typing in a field, except the ones marked _(anywhere)_. `Mod Shift .` means the key itself, so it
works the same on layouts where Shift+`.` types `:` (Swedish, Norwegian, Danish, Finnish, German).

## General

| Keys    | Action                         |
| ------- | ------------------------------ |
| `Mod K` | Command menu _(anywhere)_      |
| `C`     | Create issue                   |
| `/`     | Search                         |
| `?`     | Keyboard shortcuts             |
| `Esc`   | Close dialog / clear selection |

## Navigation

| Keys         | Action                   |
| ------------ | ------------------------ |
| `G` then `I` | Inbox                    |
| `G` then `M` | My issues                |
| `G` then `T` | Your first team's issues |
| `G` then `P` | Projects                 |
| `G` then `V` | Views                    |
| `G` then `D` | Dashboards               |
| `G` then `S` | Settings                 |

`G` then a key always navigates, even on pages where that key alone does something else (`I` on an issue
list assigns to you, `G` then `I` opens the inbox). Opening or closing a dialog cancels a pending `G`.

## Issue lists and boards

| Keys                       | Action                          |
| -------------------------- | ------------------------------- |
| `J` / `↓`                  | Focus next issue                |
| `K` / `↑`                  | Focus previous issue            |
| `Enter` / `O`              | Open focused issue              |
| `X`                        | Select / deselect focused issue |
| `Shift X` or `Shift`-click | Select a range                  |
| `Mod A`                    | Select all                      |
| `V`                        | Toggle list / board             |

## Acting on issues

These apply to the selected issues, or the focused one if nothing is selected, or the open issue.

| Keys               | Action                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `S`                | Change status                                                     |
| `P`                | Set priority                                                      |
| `A`                | Assign                                                            |
| `I`                | Assign to me (toggle)                                             |
| `L`                | Labels                                                            |
| `Shift P`          | Project                                                           |
| `Shift C`          | Cycle                                                             |
| `E`                | Estimate                                                          |
| `Mod ⌫` / `Delete` | Move to trash (undo from the toast)                               |
| `Mod Shift .`      | Copy the open issue's git branch name (the `.` key on any layout) |
| `Shift G`          | Jump to the latest activity on the open issue                     |
| `1`–`9`            | In a property menu: pick the nth option                           |
| `⌫`                | In a property menu with an empty filter: back to the command menu |

## Editing

| Keys        | Action                                                        |
| ----------- | ------------------------------------------------------------- |
| `D`         | Edit the description of the open issue, project or initiative |
| `Mod Enter` | Submit (new issue, comment, description)                      |
| `Esc`       | Cancel editing                                                |
| `@`         | Mention someone (↑/↓, `Enter` or `Tab` to pick)               |

A description is also a button: `Tab` to it and press `Enter` or `Space` to start editing. When you save or
cancel, focus goes back to it.

On a narrow screen the navigation drawer works like a dialog: `Tab` stays inside it, `Esc` closes it and puts
focus back on the menu button, and page shortcuts are paused while it's open.

In the rich text editor, Markdown typed at the start of a line or around a word formats as you go:

| Type                               | Gets you                       |
| ---------------------------------- | ------------------------------ |
| `#`, `##`, `###` + space           | Heading                        |
| `-` or `*` + space, `1.` + space   | Bulleted / numbered list       |
| `[ ]` + space                      | Checklist                      |
| `>` + space                        | Quote                          |
| ` ``` `                            | Code block                     |
| `---`                              | Divider                        |
| `**bold**`, `*italic*`, `~~gone~~` | Bold, italic, strikethrough    |
| `` `code` ``                       | Inline code                    |
| `Mod B` / `Mod I` / `Mod E`        | Bold / italic / inline code    |
| `Mod Shift S`                      | Strikethrough                  |
| `Tab` / `Shift Tab` in a list      | Indent / outdent the list item |

## Inbox

| Keys        | Action                                              |
| ----------- | --------------------------------------------------- |
| `J` / `K`   | Next / previous notification                        |
| `U`         | Toggle read                                         |
| `H`         | Snooze (or, in Snoozed, wake)                       |
| `⌫`         | Delete notification                                 |
| `1` – `4`   | Quick filter: All, Mentions, Assigned, Comments     |
| `5`         | Unread only, on or off                              |
| `Shift` `F` | More filters (kind, why, who, team, issue priority) |

## Dashboards

| Keys | Action                           |
| ---- | -------------------------------- |
| `E`  | Edit the layout (again: save it) |
| `A`  | While editing: add a widget      |
