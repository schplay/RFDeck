export function estimateRuntime(percent: number): string {
  const totalMinutes = Math.floor(percent * 8); // Mockup: 8 hours = 480 mins max
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
