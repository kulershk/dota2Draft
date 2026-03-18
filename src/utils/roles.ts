export const roleColors: Record<string, string> = {
  Carry: 'badge-success',
  Mid: 'badge-danger',
  Offlane: 'badge-info',
  Pos4: 'badge-warning',
  Pos5: 'badge-purple',
}

export const roleOrder = ['Carry', 'Mid', 'Offlane', 'Pos4', 'Pos5']

export function sortedRoles(roles: string[]) {
  return [...roles].sort((a, b) => roleOrder.indexOf(a) - roleOrder.indexOf(b))
}
