import { secretAad } from '../../lib/encryptedColumns.ts';
import type { SourceContext } from './types.ts';
import { ImportAbort } from './types.ts';

/** Imports keep API credentials encrypted, bound to the import they belong to. */
export function importSecrets<T extends Record<string, string>>(sctx: SourceContext): T {
  const { row, app } = sctx;
  if (!row.secrets) throw new ImportAbort('The import has no credentials; start a new one');
  return JSON.parse(app.keyring.decrypt(row.secrets, secretAad.importSecrets(row.id))) as T;
}
