import { Grid } from '@react-three/drei';
import { useViewportStore } from '@/store/viewportStore';

export function GridFloor() {
  const show = useViewportStore((s) => s.showGrid);
  if (!show) return null;
  return (
    <Grid
      args={[400, 400]}
      cellSize={5}
      cellThickness={0.5}
      cellColor="#444"
      sectionSize={50}
      sectionThickness={1}
      sectionColor="#888"
      fadeDistance={500}
      infiniteGrid
      rotation={[Math.PI / 2, 0, 0]}
    />
  );
}
