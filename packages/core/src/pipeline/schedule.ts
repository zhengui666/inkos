/** UTC cron, evaluated against calendar time rather than time since process startup. */
export function nextCronTime(expression: string, after: number): number {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expected five cron fields: ${expression}`);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const fields = parts.map((part, index) => {
    const [min, max] = ranges[index]!;
    const values = new Set<number>();
    for (const item of part.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!match) throw new Error(`Unsupported cron field: ${item}`);
      const step = Number(match[2] ?? 1);
      const [first, last] = match[1] === "*" ? [min, max] : match[1]!.split("-").map(Number);
      const end = last ?? first;
      if (step < 1 || first < min || end > max || first > end) throw new Error(`Invalid cron field: ${item}`);
      for (let n = first; n <= end; n += step) values.add(index === 4 && n === 7 ? 0 : n);
    }
    return values;
  });
  const start = Math.floor(after / 60_000) * 60_000 + 60_000;
  // Includes leap-day schedules; impossible dates fail instead of spinning forever.
  for (let time = start; time <= start + 8 * 366 * 86_400_000; time += 60_000) {
    const date = new Date(time);
    if (!fields[3]!.has(date.getUTCMonth() + 1) || !fields[1]!.has(date.getUTCHours()) || !fields[0]!.has(date.getUTCMinutes())) continue;
    const day = fields[2]!.has(date.getUTCDate()), weekday = fields[4]!.has(date.getUTCDay());
    if (parts[2] === "*" ? weekday : parts[4] === "*" ? day : day || weekday) return time;
  }
  throw new Error(`Cron has no matching date: ${expression}`);
}
