/** Customers: the list, a customer's page and the new-customer dialog. */
export default {
  list: {
    kicker: 'customers',
    title: 'Customers',
    newCustomer: 'New customer',
    emptyTitle: 'no customers yet',
    emptyBody:
      'Customers collect requests: what they asked for, tied to the issues that deliver it. Email intake adds them on its own.',
    /** Column headings. */
    name: 'Name',
    domains: 'Domains',
    owner: 'Owner',
    requests: 'Requests',
    open: 'Open',
  },
  create: {
    title: 'New customer',
    namePlaceholder: 'Company name',
    domainsPlaceholder: 'Email domains, e.g. {example}',
    domainsHint: 'Email from these domains is filed under this customer.',
    submit: 'Create customer',
  },
  detail: {
    notFound: 'customer not found',
    kicker: 'customers',
    /** Kicker when the customer has no domain. */
    customer: 'customer',
    delete: 'Delete customer',
    confirmDeleteTitle: 'Delete customer “{name}”?',
    confirmDeleteBody: 'Their requests go too; the issues stay.',
    nameLabel: 'Customer name',
    requests: { one: 'Requests · {count}', other: 'Requests · {count}' },
    noRequests: '// no requests yet',
    noContact: 'no contact',
    /** How a request came in. */
    source: {
      manual: 'manual',
      email: 'email',
      api: 'api',
    },
    details: 'Details',
    domains: 'Domains',
    owner: 'Owner',
    setOwner: 'Set owner…',
    noOwner: 'No owner',
    notes: 'Notes',
  },
};
