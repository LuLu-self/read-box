// Deleting cards: hide them at once through state.json, then ask the pipeline (inbox capture with
// delete_of) to remove the entry, its text and its images from the library.

import { updateJson, putFile } from './gh.mjs';
import { makeId, isoLocal } from './data.mjs';

export async function deleteItems(cfg, ids) {
  const now = new Date();
  const st = await updateJson(cfg, 'state.json', (s) => {
    s.v = 1; s.items = s.items || {};
    for (const id of ids) s.items[id] = { ...(s.items[id] || {}), deleted: true, updated_at: now.toISOString() };
    return s;
  }, `delete: ${ids.length} 篇`, { v: 1, items: {} });
  if (!st.ok) return { ok: false, state: null };
  let queued = 0;
  for (const [n, id] of ids.entries()) {
    const at = new Date(now.getTime() + n * 1000);
    const cap = { v: 1, url: '', text: '', captured_at: isoLocal(at), client: 'board@1', delete_of: id };
    if ((await putFile(cfg, `inbox/${makeId(at)}.json`, JSON.stringify(cap, null, 2) + '\n', `delete: ${id}`)).ok) queued++;
  }
  return { ok: queued === ids.length, state: st.data };
}
