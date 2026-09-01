interface Props {
  icon?: string;
  title?: string;
  hint?: string;
}

export function EmptyState({ icon = "∅", title = "Пока ничего нет", hint }: Props) {
  return (
    <div className="empty empty-state">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
    </div>
  );
}
