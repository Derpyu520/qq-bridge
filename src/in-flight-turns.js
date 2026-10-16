// A seeded session can reuse turn numbers. Only events after the last seed
// boundary belong to the current conversation epoch.
export function inFlightTurnEvents(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const eventOf = (entry) => entry?.type === 'event' ? entry.event : entry;
  const open = new Set();
  let epochStart = 0;
  let hasBoundary = false;
  for (let index = 0; index < records.length; index++) {
    const event = eventOf(records[index]);
    if (event?.type === 'session/end-seed') {
      open.clear();
      epochStart = index + 1;
      hasBoundary = true;
    } else if (event?.type === 'turn/start') {
      open.add(event.data?.turn);
      hasBoundary = true;
    } else if (event?.type === 'turn/end') {
      open.delete(event.data?.turn);
      hasBoundary = true;
    }
  }
  // A metadata-only snapshot does not establish whether a turn has ended.
  if (!hasBoundary) return null;
  const events = records.slice(epochStart).map(eventOf).filter((event) => (
    (event?.type === 'turn/start' || event?.type === 'assistant/message')
      && open.has(event.data?.turn)
  ));
  return { turns: [...open], events };
}
