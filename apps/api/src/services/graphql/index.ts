import {
  buildSchema,
  type DocumentNode,
  type ExecutionResult,
  execute,
  type FragmentDefinitionNode,
  GraphQLError,
  type GraphQLFormattedError,
  GraphQLObjectType,
  type GraphQLSchema,
  Kind,
  parse,
  type SelectionSetNode,
  specifiedRules,
  validate,
} from 'graphql';
import { ZodError } from 'zod';
import { HttpError } from '../../lib/errors.ts';
import { type GqlContext, NODE_BUDGET, resolvers } from './resolvers.ts';
import { typeDefs } from './schema.ts';

export const MAX_DEPTH = 10;
const MAX_TOKENS = 10_000;

export function buildGraphqlSchema(): GraphQLSchema {
  const schema = buildSchema(typeDefs);
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (!(type instanceof GraphQLObjectType)) throw new Error(`No object type ${typeName}`);
    const defs = type.getFields();
    for (const [name, resolve] of Object.entries(fields)) {
      if (!defs[name]) throw new Error(`No field ${typeName}.${name}`);
      defs[name].resolve = resolve as never;
    }
  }
  return schema;
}

/** How deep the query's selections nest, fragments included; introspection doesn't count. */
export function queryDepth(document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions)
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  const depth = (set: SelectionSetNode | undefined, seen: Set<string>): number => {
    if (!set) return 0;
    let max = 0;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value.startsWith('__')) continue;
        max = Math.max(max, sel.selectionSet ? 1 + depth(sel.selectionSet, seen) : 1);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        max = Math.max(max, depth(sel.selectionSet, seen));
      } else {
        const name = sel.name.value;
        const frag = fragments.get(name);
        // Cycles are reported by validation; don't recurse into them here.
        if (frag && !seen.has(name))
          max = Math.max(max, depth(frag.selectionSet, new Set([...seen, name])));
      }
    }
    return max;
  };
  let max = 0;
  for (const def of document.definitions)
    if (def.kind === Kind.OPERATION_DEFINITION)
      max = Math.max(max, depth(def.selectionSet, new Set()));
  return max;
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_USER_INPUT',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
};

/** Errors as clients see them: HTTP errors from the services keep their message and get a code. */
export function formatError(err: GraphQLError, log: (err: unknown) => void): GraphQLFormattedError {
  const original = err.originalError;
  if (!original || original instanceof GraphQLError) return err.toJSON();
  if (original instanceof HttpError)
    return {
      ...err.toJSON(),
      extensions: {
        code: STATUS_CODES[original.statusCode] ?? original.code.toUpperCase(),
        ...(original.details !== undefined && { details: original.details }),
      },
    };
  if (original instanceof ZodError)
    return { ...err.toJSON(), extensions: { code: 'BAD_USER_INPUT' } };
  log(original);
  return {
    message: 'Internal server error',
    locations: err.locations,
    path: err.path,
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  };
}

export interface GraphqlRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

/**
 * Parses, validates (with a depth limit) and runs one request. `status` is 400 when the
 * document never ran, as GraphQL over HTTP suggests; field errors still answer 200.
 */
export async function runGraphql(
  schema: GraphQLSchema,
  request: GraphqlRequest,
  context: Omit<GqlContext, 'budget' | 'cache'>,
  { budget = NODE_BUDGET }: { budget?: number } = {},
): Promise<{ status: number; body: ExecutionResult }> {
  let document: DocumentNode;
  try {
    document = parse(request.query, { maxTokens: MAX_TOKENS });
  } catch (err) {
    return { status: 400, body: { errors: [err as GraphQLError] } };
  }
  const errors = validate(schema, document, specifiedRules);
  if (errors.length) return { status: 400, body: { errors } };
  if (queryDepth(document) > MAX_DEPTH)
    return {
      status: 400,
      body: {
        errors: [
          new GraphQLError(`Queries may nest at most ${MAX_DEPTH} levels`, {
            extensions: { code: 'QUERY_TOO_DEEP' },
          }),
        ],
      },
    };
  const result = await execute({
    schema,
    document,
    variableValues: request.variables ?? undefined,
    operationName: request.operationName ?? undefined,
    contextValue: { ...context, budget: { left: budget }, cache: new Map() },
  });
  return { status: result.data === undefined ? 400 : 200, body: result };
}
