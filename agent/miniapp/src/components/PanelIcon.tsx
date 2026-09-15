import type { TabKey } from "../lib/tabnav";
const paths: Record<TabKey, string> = {
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  tasks: 'M8 5h13 M8 12h13 M8 19h13 M2 5l1 1 2-3 M2 12l1 1 2-3 M2 19l1 1 2-3',
  approvals: 'M5 12l4 4L20 5 M20 12v8H4V4h9',
  agents: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M5 21v-3a7 7 0 0 1 14 0v3 M2 9v6 M22 9v6',
  perms: 'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  logs: 'M4 5h16 M4 12h16 M4 19h10',
  wiki: 'M12 5v16 M12 5C9 2 5 2 2 3v16c4-1 7-1 10 2 M12 5c3-3 7-3 10-2v16c-4-1-7-1-10 2',
  settings: 'M4 5h16 M4 12h16 M4 19h16 M8 2v6 M16 9v6 M10 16v6',
  mac: 'M4 3h16v13H4z M2 20h20 M9 16v4 M15 16v4',
};
export default function PanelIcon({tab}: {tab: TabKey}) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[tab]} /></svg>;
}
