import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import type { FolderFilter, RootInfo } from '../types'
import { folderScope } from '../lib/filter'
import { errorMessage } from '../lib/errors'
import { useBackLayer } from '../hooks/useBackLayer'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from './icons'
import { SELECT_CLASS } from './Select'

interface Props {
  roots: RootInfo[]
  filters: FolderFilter
  onChange: (filters: FolderFilter) => void
  disabled: boolean
}

interface Folder {
  rootId: number
  path: string
  subfolder: string
  name: string
  hasChildren: boolean
}

interface Branch {
  folder: Folder
  anchor: DOMRect
  children: Folder[] | null
  error: string
  left: number
  top: number
  request: number
}

const nameOf = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path
const keyOf = (folder: Folder) => `${folder.rootId}:${folder.subfolder}`
const MENU_CLASS =
  'pointer-events-auto fixed w-60 overflow-y-auto rounded-xl bg-white/95 px-1 py-1.5 text-xs shadow-[0_4px_16px_rgb(0,0,0,0.08)] ring-1 ring-black/[0.06] backdrop-blur-xl dark:bg-gray-800/95 dark:text-gray-200 dark:ring-white/[0.06]'
const ROW_CLASS =
  'flex h-9 w-full items-center gap-2 rounded-md px-3 text-left outline-none hover:bg-gray-100 focus-visible:bg-blue-50 dark:hover:bg-white/[0.06] dark:focus-visible:bg-white/10'

/** 级联菜单优先向右，空间不足时翻到左侧；纵向保持在窗口内 */
export function folderMenuPosition(rect: Pick<DOMRect, 'left' | 'right' | 'top'>, height: number, width: number, viewportHeight: number) {
  const left = rect.right + 248 <= width - 8 ? rect.right + 8 : rect.left - 248
  return { left: Math.max(8, Math.min(left, width - 248)), top: Math.max(8, Math.min(rect.top, viewportHeight - height - 8)) }
}

/** 文件夹多选与子目录级联选择共用一个入口；每一层只查询直接子目录 */
export default function FolderSelect({ roots, filters, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [branches, setBranches] = useState<Branch[]>([])
  const [childrenByFolder, setChildrenByFolder] = useState<Record<string, Folder[]>>({})
  const pending = useRef(new Map<string, Promise<Folder[]>>())
  const generation = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const sequence = useRef(0)
  const focusLevel = useRef<number | null>(null)
  const scopes = folderScope(filters.entries)
  const rootFolders: Folder[] = roots.map((r) => ({ rootId: r.id, path: r.path, subfolder: '', name: nameOf(r.path), hasChildren: true }))
  const names = scopes.flatMap((scope) => {
    const root = roots.find((r) => r.id === scope.rootId)
    return root ? [nameOf(scope.rel || root.path)] : []
  })
  const label = !filters.custom || !names.length ? '全部文件夹' : names.length <= 2 ? names.join('、') : `${names.length} 个文件夹`
  const maxHeight = Math.max(36, Math.min(320, window.innerHeight - 16))

  const close = () => {
    setOpen(false)
    setBranches([])
  }
  useBackLayer(close, open)

  useEffect(() => {
    generation.current++
    pending.current.clear()
    setChildrenByFolder({})
    close()
  }, [roots])

  const loadChildren = (folder: Folder): Promise<Folder[]> => {
    const key = keyOf(folder)
    if (childrenByFolder[key]) return Promise.resolve(childrenByFolder[key])
    const existing = pending.current.get(key)
    if (existing) return existing
    const version = generation.current
    const request = invoke<{ name: string; hasChildren: boolean }[]>('list_search_folders', { rootId: folder.rootId, subfolder: folder.subfolder })
      .then((entries) => {
        const sep = folder.path.includes('\\') ? '\\' : '/'
        const children = entries.map((entry) => ({
          rootId: folder.rootId,
          path: `${folder.path.replace(/[\\/]+$/, '')}${sep}${entry.name}`,
          subfolder: `${folder.subfolder}${entry.name}${sep}`,
          ...entry,
        }))
        if (version === generation.current) setChildrenByFolder((old) => ({ ...old, [key]: children }))
        return children
      })
      .finally(() => {
        if (pending.current.get(key) === request) pending.current.delete(key)
      })
    pending.current.set(key, request)
    return request
  }

  // 只读取已选路径的祖先目录，菜单重新打开时也能恢复父项的全选状态
  const scopeKey = JSON.stringify(scopes)
  useEffect(() => {
    if (!open || !filters.custom) return
    for (const scope of scopes) {
      const root = roots.find((r) => r.id === scope.rootId)
      if (!root || !scope.rel) continue
      const sep = root.path.includes('\\') ? '\\' : '/'
      const parts = scope.rel.split(/[\\/]/)
      for (let depth = 0; depth < parts.length; depth++) {
        const subfolder = depth ? parts.slice(0, depth).join(sep) + sep : ''
        void loadChildren({ rootId: root.id, path: `${root.path.replace(/[\\/]+$/, '')}${sep}${subfolder}`, subfolder, name: '', hasChildren: true }).catch((err) =>
          console.warn('无法读取目录勾选状态：', err),
        )
      }
    }
  }, [open, filters.custom, scopeKey, roots])

  const checked = (folder: Folder): boolean | 'mixed' => {
    if (!filters.custom) return false
    const rel = folder.subfolder.replace(/[\\/]+$/, '')
    const sep = folder.path.includes('\\') ? '\\' : '/'
    if (scopes.some((scope) => scope.rootId === folder.rootId && scope.rel === rel)) return true
    if (!scopes.some((scope) => scope.rootId === folder.rootId && (!rel || scope.rel.startsWith(rel + sep)))) return false
    const children = childrenByFolder[keyOf(folder)]
    return children?.length && children.every((child) => checked(child) === true) ? true : 'mixed'
  }

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) close()
    }
    const reposition = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', outside)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  useEffect(() => {
    const level = focusLevel.current
    if (level === null || !open) return
    const menu = menuRef.current?.querySelector<HTMLElement>(`[data-level="${level}"]`)
    const first = menu?.querySelector<HTMLButtonElement>('[data-row]')
    if (first) {
      first.focus()
      focusLevel.current = null
    }
  }, [open, branches])

  const show = (keyboard = false) => {
    if (disabled) return
    const rect = triggerRef.current!.getBoundingClientRect()
    const height = Math.min(maxHeight, (roots.length + 2) * 36 + 12)
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)),
      top: rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6),
    })
    setBranches([])
    focusLevel.current = keyboard ? 0 : null
    setOpen(true)
  }

  const select = (folder: Folder) => {
    const rel = folder.subfolder.replace(/[\\/]+$/, '')
    const sep = folder.path.includes('\\') ? '\\' : '/'
    const current = filters.custom ? scopes : []
    const selected = checked(folder) === true
    // 父子范围相互包含时只保留本次选择的范围，其他分支继续参与搜索
    const next = current.filter((scope) => {
      if (scope.rootId !== folder.rootId) return true
      if (selected) return scope.rel !== rel && rel !== '' && !scope.rel.startsWith(rel + sep)
      return scope.rel !== '' && rel !== '' && !rel.startsWith(scope.rel + sep) && !scope.rel.startsWith(rel + sep)
    })
    if (!selected) next.push({ rootId: folder.rootId, rel })
    if (!next.length) return
    const entries = [
      ...roots.map((root) => ({ rootId: root.id, rel: '', checked: next.some((scope) => scope.rootId === root.id) })),
      ...filters.entries.filter((e) => e.rel).map((e) => ({ ...e, checked: next.some((scope) => scope.rootId === e.rootId && scope.rel === e.rel) })),
    ]
    for (const scope of next) {
      if (scope.rel && !entries.some((e) => e.rootId === scope.rootId && e.rel === scope.rel)) entries.push({ ...scope, checked: true })
    }
    onChange({ custom: true, entries })
  }

  const expand = async (folder: Folder, depth: number, rect: DOMRect, keyboard = false) => {
    if (!folder.hasChildren) {
      setBranches((old) => old.slice(0, depth))
      return
    }
    if (keyboard) focusLevel.current = depth + 1
    if (branches[depth] && keyOf(branches[depth].folder) === keyOf(folder) && !branches[depth].error) {
      if (keyboard) menuRef.current?.querySelector<HTMLButtonElement>(`[data-level="${depth + 1}"] [data-row]`)?.focus()
      return
    }
    const request = ++sequence.current
    const pos = folderMenuPosition(rect, Math.min(84, maxHeight), window.innerWidth, window.innerHeight)
    setBranches((old) => [...old.slice(0, depth), { folder, anchor: rect, children: null, error: '', ...pos, request }])
    try {
      const children = await loadChildren(folder)
      const placed = folderMenuPosition(rect, Math.min(maxHeight, (Math.max(1, children.length) + 1) * 36 + 12), window.innerWidth, window.innerHeight)
      setBranches((old) => (old[depth]?.request === request ? [...old.slice(0, depth), { ...old[depth], children, ...placed }] : old))
    } catch (err) {
      console.warn('无法读取子文件夹：', err)
      setBranches((old) => (old[depth]?.request === request ? [...old.slice(0, depth), { ...old[depth], error: errorMessage(err, '无法读取子文件夹，请重试') }] : old))
    }
  }

  const navigate = (e: KeyboardEvent, level: number) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      triggerRef.current?.focus()
      return
    }
    if (e.key === 'Tab') {
      close()
      return
    }
    if (e.key === 'ArrowRight' || (e.key === 'ArrowLeft' && level === 0)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.key === 'ArrowLeft' && level > 0) {
      e.preventDefault()
      e.stopPropagation()
      const parent = branches[level - 1].folder
      setBranches((old) => old.slice(0, level - 1))
      const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>(`[data-level="${level - 1}"] [data-folder]`)
      Array.from(buttons ?? [])
        .find((b) => b.dataset.folder === keyOf(parent))
        ?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    e.stopPropagation()
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-row]'))
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    rows[(at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
  }

  const row = (folder: Folder, level: number) => {
    const state = checked(folder)
    const selected = state === true
    const partial = state === 'mixed'
    const expanded = branches[level] && keyOf(branches[level].folder) === keyOf(folder)
    return (
      <div
        key={keyOf(folder)}
        className={`flex items-center rounded-md ${expanded ? 'bg-blue-50 dark:bg-blue-400/10' : 'hover:bg-gray-100 dark:hover:bg-white/[0.06]'}`}
        onMouseEnter={(e) => {
          void expand(folder, level, e.currentTarget.getBoundingClientRect())
        }}
      >
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={partial ? 'mixed' : selected}
          data-row
          data-folder={keyOf(folder)}
          title={folder.path}
          className={`${ROW_CLASS} min-w-0 flex-1 hover:!bg-transparent ${selected || expanded ? 'font-medium text-blue-600 dark:text-blue-400' : ''}`}
          onClick={() => select(folder)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' && folder.hasChildren) {
              e.preventDefault()
              e.stopPropagation()
              void expand(folder, level, e.currentTarget.parentElement!.getBoundingClientRect(), true)
            }
          }}
        >
          <span
            aria-hidden="true"
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${selected || partial ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-300 dark:border-gray-500'}`}
          >
            {selected ? <CheckIcon className="h-3 w-3" /> : partial ? <span className="h-px w-2 bg-current" /> : null}
          </span>
          <span className="truncate">{folder.name}</span>
        </button>
        {folder.hasChildren && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`展开 ${folder.name}`}
            aria-expanded={!!expanded}
            className={`h-9 shrink-0 rounded-md px-2 hover:text-blue-500 ${expanded ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400'}`}
            onClick={(e) => {
              void expand(folder, level, e.currentTarget.parentElement!.getBoundingClientRect(), true)
            }}
          >
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="文件夹"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        title={disabled ? '还没有添加文件夹' : label}
        className={`${SELECT_CLASS} flex items-center justify-between gap-1 ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
          if (['ArrowDown', 'Enter', ' '].includes(e.key)) {
            e.preventDefault()
            e.stopPropagation()
            if (!open) show(true)
            else menuRef.current?.querySelector<HTMLButtonElement>('[data-row]')?.focus()
          }
        }}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className={`h-3.5 w-3.5 shrink-0 text-gray-400 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} className="pointer-events-none fixed inset-0 z-50">
            <div
              role="menu"
              aria-label="文件夹"
              data-level={0}
              className={MENU_CLASS}
              style={{ ...position, maxHeight }}
              onKeyDown={(e) => navigate(e, 0)}
              onScroll={() => setBranches([])}
            >
              <button
                type="button"
                data-row
                aria-label="搜索全部文件夹"
                className={`${ROW_CLASS} border-b border-gray-100 font-medium dark:border-white/10`}
                onMouseEnter={() => setBranches([])}
                onClick={() => {
                  onChange({ ...filters, custom: false })
                  close()
                  triggerRef.current?.focus()
                }}
              >
                全部文件夹
              </button>
              {rootFolders.map((folder) => row(folder, 0))}
              <div className="sticky bottom-0 flex h-9 items-center justify-between border-t border-gray-100 bg-white px-3 dark:border-white/10 dark:bg-gray-800">
                <span className="text-gray-400" title="可多选，至少保留一个文件夹">
                  {filters.custom ? `已选 ${scopes.length} 项` : '全部文件夹'}
                </span>
                <button
                  type="button"
                  data-row
                  className="rounded px-2 py-1 text-blue-600 hover:bg-blue-50 focus-visible:bg-blue-50 dark:text-blue-400 dark:hover:bg-white/10"
                  onClick={() => {
                    close()
                    triggerRef.current?.focus()
                  }}
                >
                  完成
                </button>
              </div>
            </div>
            {branches.map((branch, depth) => (
              <div
                key={`${depth}:${keyOf(branch.folder)}`}
                role="menu"
                aria-label={`${branch.folder.name}的子文件夹`}
                data-level={depth + 1}
                className={MENU_CLASS}
                style={{ left: branch.left, top: branch.top, maxHeight }}
                onKeyDown={(e) => navigate(e, depth + 1)}
                onScroll={() => setBranches((old) => old.slice(0, depth + 1))}
              >
                <button
                  type="button"
                  data-row
                  role="menuitemcheckbox"
                  aria-checked={checked(branch.folder)}
                  className={`${ROW_CLASS} border-b border-gray-100 font-medium text-blue-600 dark:border-white/10 dark:text-blue-400`}
                  onMouseEnter={() => setBranches((old) => old.slice(0, depth + 1))}
                  onClick={() => select(branch.folder)}
                >
                  在此文件夹中搜索
                </button>
                {branch.error ? (
                  <button
                    type="button"
                    className={`${ROW_CLASS} !h-auto min-h-9 text-red-500`}
                    onClick={() => {
                      void expand(branch.folder, depth, branch.anchor)
                    }}
                  >
                    {branch.error}（重试）
                  </button>
                ) : branch.children === null ? (
                  <p role="status" className="px-3 py-3 text-gray-400">
                    正在读取…
                  </p>
                ) : branch.children.length ? (
                  branch.children.map((folder) => row(folder, depth + 1))
                ) : (
                  <p className="px-3 py-3 text-gray-400">没有已收录的子文件夹</p>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
