/** Bounded, read-only Calendar snapshot. No notes, attendees or URLs leave the Mac. */
export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
}
export interface CalendarDay {
  date: string;
  timeZone: string;
  events: CalendarEvent[];
  truncated: boolean;
}
export function parseCalendarDay(raw: string): CalendarDay {
  const d = JSON.parse(raw);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.timeZone !== 'string' ||
      !Array.isArray(d.events) || d.events.length > 40 || typeof d.truncated !== 'boolean') {
    throw new Error('invalid_calendar_result');
  }
  new Intl.DateTimeFormat('ru', { timeZone: d.timeZone });
  for (const e of d.events) {
    if (!e || typeof e.title !== 'string' || e.title.length > 200 || typeof e.allDay !== 'boolean' ||
        typeof e.start !== 'string' || typeof e.end !== 'string' ||
        !Number.isFinite(Date.parse(e.start)) || !Number.isFinite(Date.parse(e.end)) || Date.parse(e.end) < Date.parse(e.start)) {
      throw new Error('invalid_calendar_event');
    }
  }
  return d;
}
