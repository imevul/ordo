/** Custom fields: their settings page, the issue pickers, history lines, filters and groups. */
export default {
  settings: {
    title: 'Custom fields',
    description:
      "Properties issues have beyond the built-in ones. Workspace fields are on every team's issues; team fields only on that team's.",
    newField: 'New field',
    name: 'Field name',
    type: 'Type',
    scope: 'Scope',
    workspace: 'Workspace',
    /** Tag on a field that belongs to the whole workspace rather than a team. */
    workspaceTag: 'workspace',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'What the field is for (optional)',
    fixedHint: "The type and scope can't change once the field exists.",
    options: 'Options',
    noOptions: 'No options yet. Add the choices people pick from.',
    newOption: 'New option',
    optionName: 'Option name',
    addOption: 'Add option',
    changeColor: 'Change the color of {name}',
    moveUp: 'Move {name} up',
    moveDown: 'Move {name} down',
    removeOption: 'Remove {name}',
    removeOptionTitle: 'Remove option “{name}”?',
    removeOptionBody: 'Issues that have this option lose it.',
    edit: 'Edit {name}',
    deleteField: 'Delete {name}',
    deleteTitle: 'Delete field “{name}”?',
    deleteBody: "Every issue loses its value for this field. This can't be undone.",
    empty: '// no custom fields yet',
    created: 'Field created',
  },
  props: {
    /** Picker search placeholder. */
    set: 'Set {field}…',
    notSet: 'Not set',
    /** The "none" choice in a picker and the group of issues without a value. */
    none: 'No {field}',
    clear: 'Clear {field}',
    numberPlaceholder: 'Add a number',
    textPlaceholder: 'Add text',
    /** Stand-in for an option that was removed from the field. */
    removedOption: 'removed option',
    someone: 'Someone',
    /** Tooltip on a field's value in issue lists. */
    valueTitle: '{field}: {value}',
  },
  activity: {
    set: '{actor} set {field} to {value}',
    cleared: '{actor} cleared {field}',
    added: '{actor} added {values} to {field}',
    removed: '{actor} removed {values} from {field}',
    changed: '{actor} added {added} to {field} and removed {removed}',
    /** A field that was deleted after the change. */
    deletedField: 'a deleted field',
  },
};
