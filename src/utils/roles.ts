export const roleColors: Record<string, string> = {
  Carry: 'bg-color-success text-color-success-foreground',
  Mid: 'bg-color-error text-color-error-foreground',
  Offlane: 'bg-color-info text-color-info-foreground',
  Pos4: 'bg-color-warning text-color-warning-foreground',
  Pos5: 'bg-color-warning text-color-warning-foreground',
}

export const roleOrder = ['Carry', 'Mid', 'Offlane', 'Pos4', 'Pos5']

export function sortedRoles(roles: string[]) {
  return [...roles].sort((a, b) => roleOrder.indexOf(a) - roleOrder.indexOf(b))
}
