export function PageSizeOptions({ defaultPageSize }: { defaultPageSize: number }) {
  return <>{[...new Set([20, 50, 100, defaultPageSize])].sort((a, b) => a - b)
    .map(size => <option key={size} value={size}>{size}</option>)}</>;
}
