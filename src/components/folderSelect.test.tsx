// @vitest-environment jsdom

import { act, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { FolderFilter, RootInfo } from '../types'
import { button, click, flush, mockCore, render } from '../test/tauri'
import FolderSelect, { folderMenuPosition } from './FolderSelect'
import { folderScope } from '../lib/filter'

const INITIAL_FILTER: FolderFilter = { custom: false, entries: [] }
const roots: RootInfo[] = [{ id: 1, path: 'D:\\照片', offline: false, missing: false, files: 10, excludes: [], skipNomedia: true, scanning: false }]

function Harness({ list = roots, initial = INITIAL_FILTER, onChange }: { list?: RootInfo[]; initial?: FolderFilter; onChange: (next: FolderFilter) => void }) {
  const [filters, setFilters] = useState(initial)
  return (
    <FolderSelect
      roots={list}
      filters={filters}
      disabled={false}
      onChange={(next) => {
        setFilters(next)
        onChange(next)
      }}
    />
  )
}

function item(name: string) {
  const row = [...document.querySelectorAll<HTMLButtonElement>('[data-folder]')].find((el) => el.textContent?.trim() === name)
  if (!row) throw new Error(`找不到目录：${name}`)
  return row
}

async function hover(name: string) {
  act(() => {
    item(name).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  await flush()
}

async function key(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  await flush()
}

describe('FolderSelect', () => {
  it('切换搜索范围时保留已保存的其他子目录条目', async () => {
    mockCore({ list_search_folders: () => [{ name: '旅行', hasChildren: false }] })
    const change = vi.fn()
    const filters = {
      custom: true,
      entries: [
        { rootId: 1, rel: '', checked: true },
        { rootId: 1, rel: '旧目录', checked: true },
      ],
    }
    render(<FolderSelect roots={roots} filters={filters} onChange={change} disabled={false} />)
    await click(button('文件夹'))
    await hover('照片')
    await click(item('旅行'))
    expect(change.mock.lastCall?.[0].entries).toContainEqual({ rootId: 1, rel: '旧目录', checked: true })
    expect(change.mock.lastCall?.[0].entries).toContainEqual({ rootId: 1, rel: '旅行', checked: true })
  })

  it('悬停逐级展开，选择孙目录后保存对应范围', async () => {
    const calls = mockCore({ list_search_folders: ({ subfolder }) => (subfolder === '' ? [{ name: '旅行', hasChildren: true }] : [{ name: '海边', hasChildren: false }]) })
    const change = vi.fn()
    const filters = INITIAL_FILTER
    render(<FolderSelect roots={roots} filters={filters} onChange={change} disabled={false} />)
    await click(button('文件夹'))
    await hover('照片')
    expect(item('旅行')).toBeTruthy()
    await hover('旅行')
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(3)
    expect(calls.filter((c) => c.cmd === 'list_search_folders').map((c) => c.args.subfolder)).toEqual(['', '旅行\\'])
    await click(item('海边'))
    expect(change).toHaveBeenLastCalledWith({
      custom: true,
      entries: [
        { rootId: 1, rel: '', checked: true },
        { rootId: 1, rel: '旅行\\海边', checked: true },
      ],
    })
    expect(button('文件夹').getAttribute('aria-expanded')).toBe('true')
    await click(button('完成'))
    expect(button('文件夹').getAttribute('aria-expanded')).toBe('false')
  })

  it('每层都能选择父目录，空目录可返回全部范围', async () => {
    mockCore({ list_search_folders: () => [] })
    const change = vi.fn()
    render(<FolderSelect roots={roots} filters={INITIAL_FILTER} onChange={change} disabled={false} />)
    await click(button('文件夹'))
    await hover('照片')
    expect(document.body.textContent).toContain('没有已收录的子文件夹')
    await click(button('在此文件夹中搜索'))
    expect(change.mock.lastCall?.[0].entries[0].rel).toBe('')
    await click(button('完成'))
    await click(button('文件夹'))
    await click(button('搜索全部文件夹'))
    expect(change).toHaveBeenLastCalledWith(INITIAL_FILTER)
  })

  it('切换分支时丢弃旧请求，关闭后迟到的回复不重新打开菜单', async () => {
    let resolveOld!: (value: unknown) => void
    mockCore({
      list_search_folders: ({ rootId }) =>
        rootId === 1
          ? new Promise((resolve) => {
              resolveOld = resolve
            })
          : [{ name: '合同', hasChildren: false }],
    })
    render(<FolderSelect roots={[...roots, { ...roots[0], id: 2, path: 'E:\\资料' }]} filters={INITIAL_FILTER} onChange={vi.fn()} disabled={false} />)
    await click(button('文件夹'))
    await hover('照片')
    await hover('资料')
    await act(async () => resolveOld([{ name: '旧目录', hasChildren: false }]))
    await flush()
    expect(document.body.textContent).not.toContain('旧目录')
    expect(item('合同')).toBeTruthy()
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('键盘上下移动、向右展开、向左返回、Esc 收起', async () => {
    mockCore({ list_search_folders: () => [{ name: '旅行', hasChildren: true }] })
    render(<FolderSelect roots={roots} filters={INITIAL_FILTER} onChange={vi.fn()} disabled={false} />)
    await key(button('文件夹'), 'ArrowDown')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('照片')
    await key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement?.textContent).toBe('在此文件夹中搜索')
    await key(document.activeElement!, 'ArrowLeft')
    expect(document.activeElement?.textContent).toBe('照片')
    await key(document.activeElement!, 'Escape')
    expect(button('文件夹').getAttribute('aria-expanded')).toBe('false')
  })

  it('读取失败显示原因并允许重试', async () => {
    let fail = true
    mockCore({
      list_search_folders: () => {
        if (fail) throw { message: '后台服务未连接' }
        return [{ name: '旅行', hasChildren: false }]
      },
    })
    render(<FolderSelect roots={roots} filters={INITIAL_FILTER} onChange={vi.fn()} disabled={false} />)
    await click(button('文件夹'))
    await hover('照片')
    expect(document.body.textContent).toContain('后台服务未连接')
    fail = false
    await click(button('后台服务未连接（重试）'))
    expect(item('旅行')).toBeTruthy()
  })

  it('同级与跨根目录可以连续多选，父目录合并下级，取消时至少保留一项', async () => {
    mockCore({
      list_search_folders: ({ rootId }) =>
        rootId === 1
          ? [
              { name: '旅行', hasChildren: false },
              { name: '家庭', hasChildren: false },
            ]
          : [{ name: '合同', hasChildren: false }],
    })
    const change = vi.fn()
    render(<Harness list={[...roots, { ...roots[0], id: 2, path: 'E:\\资料' }]} onChange={change} />)
    await click(button('文件夹'))
    await hover('照片')
    await click(item('旅行'))
    await click(item('家庭'))
    expect(folderScope(change.mock.lastCall![0].entries)).toEqual([
      { rootId: 1, rel: '旅行' },
      { rootId: 1, rel: '家庭' },
    ])
    expect(item('照片').getAttribute('aria-checked')).toBe('mixed')
    expect(item('家庭').getAttribute('aria-checked')).toBe('true')
    await hover('资料')
    await click(item('合同'))
    expect(folderScope(change.mock.lastCall![0].entries)).toHaveLength(3)
    await click(item('照片'))
    expect(folderScope(change.mock.lastCall![0].entries)).toEqual([
      { rootId: 1, rel: '' },
      { rootId: 2, rel: '合同' },
    ])
    await click(item('照片'))
    expect(folderScope(change.mock.lastCall![0].entries)).toEqual([{ rootId: 2, rel: '合同' }])
    await hover('资料')
    const count = change.mock.calls.length
    await click(item('合同'))
    expect(change).toHaveBeenCalledTimes(count)
    await click(button('搜索全部文件夹'))
    expect(change.mock.lastCall![0].custom).toBe(false)
  })

  it('选择子目录缩小已选父目录范围，保留其他分支且不混淆同名前缀', async () => {
    mockCore({
      list_search_folders: ({ subfolder }) =>
        subfolder === ''
          ? [
              { name: '旅行', hasChildren: true },
              { name: '旅行备份', hasChildren: false },
            ]
          : [{ name: '海边', hasChildren: false }],
    })
    const change = vi.fn()
    render(<Harness initial={{ custom: true, entries: [{ rootId: 1, rel: '', checked: true }] }} onChange={change} />)
    await click(button('文件夹'))
    await hover('照片')
    await click(item('旅行'))
    await click(item('旅行备份'))
    await hover('旅行')
    await click(item('海边'))
    expect(folderScope(change.mock.lastCall![0].entries)).toEqual([
      { rootId: 1, rel: '旅行备份' },
      { rootId: 1, rel: '旅行\\海边' },
    ])
    await click(document.querySelector<HTMLButtonElement>('[data-level="2"] [data-row]')!)
    expect(folderScope(change.mock.lastCall![0].entries)).toEqual([
      { rootId: 1, rel: '旅行' },
      { rootId: 1, rel: '旅行备份' },
    ])
  })

  it('靠近右边缘向左展开，靠近底部上移，始终保留窗口边距', () => {
    expect(folderMenuPosition({ left: 300, right: 540, top: 200 }, 200, 1200, 800)).toEqual({ left: 548, top: 200 })
    expect(folderMenuPosition({ left: 950, right: 1190, top: 700 }, 200, 1200, 800)).toEqual({ left: 702, top: 592 })
    expect(folderMenuPosition({ left: 0, right: 240, top: -10 }, 200, 360, 640)).toEqual({ left: 8, top: 8 })
  })
})
