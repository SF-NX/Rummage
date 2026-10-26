import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { FolderFilter, RootInfo } from '../types'
import { customLabel, folderScope, KIND_OPTIONS, TIME_OPTIONS, type Filters, type TimeRange } from '../lib/filter'
import { errorMessage } from '../lib/errors'
import { isTauri } from '../lib/platform'
import { useCoreEvent } from '../hooks/useCoreEvent'
import DateRangePopover from './DateRangePopover'
import FolderSelect from './FolderSelect'
import { FilterIcon } from './icons'
import MultiSelect from './MultiSelect'
import Select from './Select'
import { showToast } from './Toast'

interface Props {
  filters: Filters
  onChange: (next: Filters) => void
  /** 变化时重新读取文件夹列表（设置中可能增删了文件夹） */
  refresh: unknown
  /** 后台服务是否已连接；连上时重新读取文件夹列表 */
  connected: boolean
}

/** 下拉框的宽度一致 */
const SELECT_WIDTH = 'w-32'

/**
 * 搜索框下方的筛选条：类型多选菜单（至少留一项），文件夹、修改时间下拉框。
 * 时间的“自定义”选项打开日期弹出层，文件夹通过级联菜单选择
 * 文件夹的勾选保存在后台服务中，筛选条只按保存的结果算出生效范围
 */
export default function FilterBar({ filters, onChange, refresh, connected }: Props) {
  const [roots, setRoots] = useState<RootInfo[]>([])
  // 读取过文件夹列表；读到之前不禁用文件夹筛选
  const [loaded, setLoaded] = useState(false)
  const [folder, setFolder] = useState<FolderFilter>({ custom: false, entries: [] })
  const [editing, setEditing] = useState(false)
  const range = customLabel(filters.from, filters.to)

  const loadRoots = () => {
    invoke<RootInfo[]>('list_roots')
      .then((list) => {
        setRoots(list)
        setLoaded(true)
      })
      .catch((err) => console.warn('无法读取文件夹列表：', err))
    invoke<FolderFilter>('get_folder_filter')
      .then((f) => setFolder({ custom: f.custom, entries: f.entries }))
      .catch((err) => console.warn('无法读取文件夹筛选：', err))
  }

  useEffect(() => {
    if (isTauri && connected) loadRoots()
  }, [refresh, connected])

  // 命令行或 MCP 增删文件夹时刷新
  useCoreEvent((ev) => {
    if (ev.type === 'RootsChanged' && connected) loadRoots()
  })

  const active = folderScope(folder.entries)
  const custom = folder.custom && active.length > 0
  const scope = custom ? active : []
  const scopeKey = JSON.stringify(scope)
  useEffect(() => {
    if (JSON.stringify(filters.folders) !== scopeKey) onChange({ ...filters, folders: scope })
  }, [scopeKey, filters, onChange])

  const save = (next: FolderFilter) =>
    invoke('set_folder_filter', { custom: next.custom, entries: next.entries })
      .then(() => setFolder(next))
      .catch((err) => {
        console.warn('无法保存文件夹筛选：', err)
        showToast(errorMessage(err, '无法保存文件夹筛选，请稍后再试'), 'error')
      })

  const empty = loaded && !roots.length

  return (
    <div role="group" aria-label="筛选" className="mt-2.5 flex flex-wrap items-center justify-center gap-2 px-1">
      <div className={SELECT_WIDTH}>
        <MultiSelect
          label="类型"
          values={filters.kinds}
          onChange={(kinds) => onChange({ ...filters, kinds })}
          options={KIND_OPTIONS.map((o) => ({ label: o.label, value: o.kind }))}
          allText="全部类型"
          unit="种类型"
          tip="只勾选要找的文件类型，匹配更准"
        />
      </div>
      <div className={SELECT_WIDTH}>
        <FolderSelect roots={roots} filters={folder} onChange={save} disabled={empty} />
      </div>
      {/* 自定义范围比其他选项长，按内容定宽 */}
      <div className="relative min-w-32">
        <Select<TimeRange>
          label="修改时间"
          value={filters.time}
          // 选项右侧的按钮键盘够不到：已选自定义时再选一次也打开弹出层
          onChange={(time) => (time === 'custom' && (!range || filters.time === 'custom') ? setEditing(true) : onChange({ ...filters, time }))}
          options={TIME_OPTIONS.map((o) =>
            o.value === 'custom'
              ? { label: o.label, value: o.value, display: range || o.label, action: { label: '选择起止日期', icon: <FilterIcon className="h-3.5 w-3.5" />, onClick: () => setEditing(true) } }
              : { label: o.label, value: o.value },
          )}
        />
        {editing && (
          <DateRangePopover
            from={filters.from}
            to={filters.to}
            onApply={(from, to) => {
              onChange({ ...filters, time: 'custom', from, to })
              setEditing(false)
            }}
            onClose={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  )
}
