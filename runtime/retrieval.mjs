// SPDX-License-Identifier: Apache-2.0
// A derived response view. Never changes a stored meaning, selector or proof token.
import {createHash} from 'node:crypto';

export function referenceRecord(record) {
  if (record.record_type === 'input') throw new Error('Use the original-source reader for inputs');
  const {basis, links, history, ...meaning} = record;
  const result = {...meaning};
  if (basis) result.basis_refs = basis.map(({quote, ...ref}) => ({...ref,
    quote_sha256: createHash('sha256').update(quote).digest('hex')}));
  if (links) result.relation_index = {record_id: record.id, total: links.length,
    by_type: Object.fromEntries([...new Set(links.map(link => link.type))].sort().map(type => [type, links.filter(link => link.type === type).length])),
    detail_required: true};
  if (history) result.history_available = true;
  return result;
}
