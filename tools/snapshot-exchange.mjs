// SPDX-License-Identifier: Apache-2.0
// stdin/stdout only; no database, credentials, network or file mutation.
import fs from 'node:fs';
import { encodeSnapshot, snapshotReviewToken, validateSnapshot } from '../runtime/snapshot.mjs';
try {
  const snapshot = JSON.parse(fs.readFileSync(0, 'utf8'));
  validateSnapshot(snapshot);
  process.stdout.write(encodeSnapshot({snapshot, tokens: Object.fromEntries(snapshot.memories.map(r => [r.id, snapshotReviewToken(snapshot, r.id)]))}) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
