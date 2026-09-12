const key = row => JSON.stringify([row.session_id, row.vm_id])

export function sessionGraph(rows) {
  const nodes = new Map(rows.map(row => [key(row), row]))
  const parents = new Map()
  for (const [id, row] of nodes) {
    const parent = key({ session_id: row.parent_session_id, vm_id: row.vm_id })
    if (parent !== id && nodes.has(parent)) parents.set(id, parent)
  }

  const visited = new Set()
  for (const id of nodes.keys()) {
    const path = []
    const positions = new Map()
    let current = id
    while (current !== undefined && !visited.has(current)) {
      if (positions.has(current)) {
        for (let i = positions.get(current); i < path.length; i++) parents.delete(path[i])
        break
      }
      positions.set(current, path.length)
      path.push(current)
      current = parents.get(current)
    }
    for (const entry of path) visited.add(entry)
  }

  const roots = []
  const children = new Map()
  for (const [id, row] of nodes) {
    const parent = parents.get(id)
    if (parent === undefined) roots.push(row)
    else {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(row)
    }
  }
  for (const [id, row] of nodes) row.child_count = children.get(id)?.length ?? 0
  return { roots, childrenOf: (session_id, vm_id) => children.get(key({ session_id, vm_id })) ?? [] }
}
