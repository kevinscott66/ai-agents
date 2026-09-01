import type { VNode } from "preact";

interface SkeletonProps {
  height?: number | string;
  width?: number | string;
  radius?: number | string;
  style?: any;
}

function Skeleton({
  height = 16,
  width = "100%",
  radius = 6,
  style,
}: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{
        height,
        width,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

export function SkeletonRow() {
  return (
    <div className="list-item" style={{ pointerEvents: "none" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Skeleton width="60%" height={14} />
        <div style={{ height: 6 }} />
        <Skeleton width="40%" height={11} />
      </div>
      <Skeleton width={60} height={18} radius={10} />
    </div>
  );
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  const arr: VNode[] = [];
  for (let i = 0; i < rows; i++) arr.push(<SkeletonRow key={i} />);
  return <>{arr}</>;
}
