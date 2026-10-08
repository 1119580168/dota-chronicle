// Authoring metadata only. Original map payloads remain outside the project.
const spec = require('../resources/community/wikibox-old.json');
function applyCommunityCatalog(catalog) {
  for (const entry of catalog.entries) {
    const runtime = spec.runtimes.find(r => r.version === entry.id);
    entry.events = entry.events.filter(event => event.id !== spec.event.id);
    if (runtime) entry.events.push({ ...spec.event, ...runtime });
  }
  for (const runtime of spec.runtimes)
    if (!catalog.entries.some(entry => entry.id === runtime.version))
      throw Error('Unknown community runtime: ' + runtime.version);
  return catalog;
}
module.exports = { applyCommunityCatalog };
