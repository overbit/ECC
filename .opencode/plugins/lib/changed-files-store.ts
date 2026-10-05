import * as path from "path"
import { AsyncLocalStorage } from "node:async_hooks"

export type ChangeType = "added" | "modified" | "deleted"

type ChangeStore = {
  changes: Map<string, ChangeType>
  worktreeRoot: string
}

// Existing V1 callers keep the same default store. V2 creates a scope per
// plugin location; async hooks and tools then share only that location's data.
const defaultStore: ChangeStore = { changes: new Map(), worktreeRoot: "" }
const scopes = new AsyncLocalStorage<ChangeStore>()

function currentStore(): ChangeStore {
  return scopes.getStore() ?? defaultStore
}

export function createStoreScope(worktree: string): <T>(run: () => T) => T {
  const store: ChangeStore = {
    changes: new Map(),
    worktreeRoot: worktree || process.cwd(),
  }
  return <T>(run: () => T): T => scopes.run(store, run)
}

export function initStore(worktree: string): void {
  currentStore().worktreeRoot = worktree || process.cwd()
}

function toRelative(p: string): string {
  if (!p) return ""
  const normalized = path.normalize(p)
  const { worktreeRoot } = currentStore()
  if (path.isAbsolute(normalized) && worktreeRoot) {
    const rel = path.relative(worktreeRoot, normalized)
    return rel.startsWith("..") ? normalized : rel
  }
  return normalized
}

export function recordChange(filePath: string, type: ChangeType): void {
  const rel = toRelative(filePath)
  if (!rel) return
  currentStore().changes.set(rel, type)
}

export function getChanges(): Map<string, ChangeType> {
  return new Map(currentStore().changes)
}

export function clearChanges(): void {
  currentStore().changes.clear()
}

export type TreeNode = {
  name: string
  path: string
  changeType?: ChangeType
  children: TreeNode[]
}

function addToTree(children: TreeNode[], segs: string[], fullPath: string, changeType: ChangeType): void {
  if (segs.length === 0) return
  const [head, ...rest] = segs
  let child = children.find((c) => c.name === head)

  if (rest.length === 0) {
    if (child) {
      child.changeType = changeType
      child.path = fullPath
    } else {
      children.push({ name: head, path: fullPath, changeType, children: [] })
    }
    return
  }

  if (!child) {
    const dirPath = segs.slice(0, -rest.length).join(path.sep)
    child = { name: head, path: dirPath, children: [] }
    children.push(child)
  }
  addToTree(child.children, rest, fullPath, changeType)
}

export function buildTree(filter?: ChangeType): TreeNode[] {
  const root: TreeNode[] = []
  for (const [relPath, changeType] of currentStore().changes) {
    if (filter && changeType !== filter) continue
    const segs = relPath.split(path.sep).filter(Boolean)
    if (segs.length === 0) continue
    addToTree(root, segs, relPath, changeType)
  }

  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return [...nodes].sort((a, b) => {
      const aIsFile = a.changeType !== undefined
      const bIsFile = b.changeType !== undefined
      if (aIsFile !== bIsFile) return aIsFile ? 1 : -1
      return a.name.localeCompare(b.name)
    }).map((n) => ({ ...n, children: sortNodes(n.children) }))
  }
  return sortNodes(root)
}

export function getChangedPaths(filter?: ChangeType): Array<{ path: string; changeType: ChangeType }> {
  const list: Array<{ path: string; changeType: ChangeType }> = []
  for (const [p, t] of currentStore().changes) {
    if (filter && t !== filter) continue
    list.push({ path: p, changeType: t })
  }
  list.sort((a, b) => a.path.localeCompare(b.path))
  return list
}

export function hasChanges(): boolean {
  return currentStore().changes.size > 0
}
