import {
  createCustomerRequestSchema,
  createCustomerSchema,
  updateCustomerSchema,
} from '@ordo/shared';
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/auth.ts';
import { parse } from '../lib/errors.ts';
import { mutate } from '../lib/mutate.ts';
import {
  addCustomerRequest,
  createCustomer,
  customerRequestsOf,
  deleteCustomer,
  deleteCustomerRequest,
  listCustomers,
  updateCustomer,
} from '../services/customers.ts';

/** Customers and their requests; the web app gets the customer list with the bootstrap payload. */
export async function customerRoutes(app: FastifyInstance) {
  const customer = async (req: Parameters<typeof requireAccess>[0], id: string) =>
    (await listCustomers(app.db, requireAccess(req))).find((c) => c.id === id);

  app.get('/customers', async (req) => listCustomers(app.db, requireAccess(req)));

  app.post('/customers', async (req) => {
    const input = parse(createCustomerSchema, req.body);
    const id = await mutate(app, req, (ctx) => createCustomer(ctx, input));
    return customer(req, id);
  });

  app.patch('/customers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(updateCustomerSchema, req.body);
    await mutate(app, req, (ctx) => updateCustomer(ctx, id, input));
    return customer(req, id);
  });

  app.delete('/customers/:id', async (req) => {
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteCustomer(ctx, id));
    return { ok: true };
  });

  app.get('/customers/:id/requests', async (req) => {
    const { id } = req.params as { id: string };
    return customerRequestsOf(app.db, requireAccess(req), id);
  });

  app.post('/issues/:id/customer-requests', async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(createCustomerRequestSchema, req.body);
    return mutate(app, req, (ctx) =>
      addCustomerRequest(ctx, id, input, req.authMethod === 'api_key' ? 'api' : 'manual'),
    );
  });

  app.delete('/customer-requests/:id', async (req) => {
    const { id } = req.params as { id: string };
    await mutate(app, req, (ctx) => deleteCustomerRequest(ctx, id));
    return { ok: true };
  });
}
