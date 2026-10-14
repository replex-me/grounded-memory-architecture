// SPDX-License-Identifier: Apache-2.0
// Turns explicit semantic judgments into a guarded atomic change; never extracts claims.
export function prepareEvolution(
  store,
  {
    request_id,
    actor,
    reason,
    recorded_at,
    memories = [],
    links = [],
    units = [],
    sources = [],
    read_set = {},
  },
) {
  const operations = [],
    ids = new Set(),
    unitVersions = {};
  for (const input of sources) {
    operations.push({ op: "put", type: "input", record: input });
    ids.add(input.id);
  }
  for (const proposed of memories) {
    const previous = store.raw(proposed.id);
    const record = {
      ...proposed,
      revision: (previous?.revision || 0) + 1,
      review_required: true,
      review: null,
    };
    operations.push({ op: "put", type: "memory", record });
    ids.add(record.id);
  }
  for (const proposed of links) {
    const previous = store.raw(proposed.id);
    const record = { ...proposed, revision: (previous?.revision || 0) + 1 };
    operations.push({ op: "put", type: "link", record });
    for (const id of [
      record.id,
      record.source,
      record.target,
      ...record.basis.map((b) => b.input_id),
    ])
      ids.add(id);
  }
  for (const unit of units) {
    operations.push({ op: "unit", ...unit });
    ids.add(unit.input_id);
    for (const id of unit.targets) ids.add(id);
    unitVersions[JSON.stringify([unit.input_id, unit.key])] = store.unitGuard(
      unit.input_id,
      unit.key,
    );
  }
  const expect = store.guard([...ids]);
  for (const [id, token] of Object.entries(expect)) {
    if (token !== null) {
      if (!Object.hasOwn(read_set, id))
        throw new Error("Existing record needs the token actually read: " + id);
      if (read_set[id] !== token)
        throw new Error("Judgment was based on a stale read: " + id);
    }
  }
  return {
    request_id,
    actor,
    reason,
    recorded_at,
    expect,
    expect_units: unitVersions,
    operations,
  };
}
